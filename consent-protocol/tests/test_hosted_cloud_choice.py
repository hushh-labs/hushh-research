"""The third door: a person may choose to have hussh host their pod.

Before this, BYOC was the only way through onboarding. `deployment_target='gcp'`
was a legal value in the schema (migration 906) with **no writer anywhere** — so
"where does this person's agent live" had two answers in the type system and one
in reality, and someone who arrived with a Google account and nothing else could
not finish setup at all.

Three things are asserted here:

  1. the writer records the hosted choice and CLEARS the user-cloud coordinates,
     so no row is left in a half-state the schema calls illegal;
  2. the route satisfies the same setup marker the BYOC door does, through the
     same helper, so onboarding cannot get stuck on a step already completed;
  3. the dev deploy lane actually emits the flags this tier needs, and no other
     lane gains any of them — executed, not read.
"""

from __future__ import annotations

import re
import subprocess

import pytest

from hushh_mcp.services.user_cloud_service import user_cloud_from_row


class _FakeResponse:
    def __init__(self, data):
        self.data = data


class _FakeTable:
    """Records the update payload so a test can assert what would be written."""

    def __init__(self, store: dict):
        self._store = store

    def update(self, data):
        self._store["update"] = dict(data)
        return self

    def eq(self, column, value):
        self._store.setdefault("filters", []).append((column, value))
        return self

    def execute(self):
        return _FakeResponse([{"user_id": "u1"}] if self._store.get("rows", 1) else [])


class _FakeDb:
    def __init__(self, store: dict):
        self._store = store

    def table(self, name):
        self._store["table"] = name
        return _FakeTable(self._store)


def _repo(store: dict):
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    repo = PersonalAgentRegistryRepo()
    repo._db = lambda: _FakeDb(store)  # type: ignore[method-assign]
    return repo


# --------------------------------------------------------------------------- #
# 1. The writer
# --------------------------------------------------------------------------- #


async def test_the_hosted_choice_is_recorded():
    store: dict = {}
    wrote = await _repo(store).set_hosted_cloud(user_id="u1", deployment_target="gcp")

    assert wrote is True
    assert store["update"]["deployment_target"] == "gcp"
    assert ("user_id", "u1") in store["filters"]


async def test_the_hosted_choice_clears_the_user_cloud_coordinates():
    """A hosted row carrying a project is a half-state the schema calls illegal.

    It would also read as "authorized in a project this pod never ran in" to any
    later migration, which is precisely the stale-proof failure the authorization
    column was split out to prevent.
    """
    store: dict = {}
    await _repo(store).set_hosted_cloud(user_id="u1", deployment_target="gcp")

    written = store["update"]
    for column in (
        "user_cloud_project",
        "user_cloud_region",
        "user_cloud_bootstrap_sa",
        "user_cloud_authorized_at",
    ):
        assert written[column] is None, f"{column} survived the switch to hosted"


async def test_the_credential_axis_is_left_alone():
    """Where the pod runs and which credential reaches a model are separate
    choices. The AI step owns the second one; this route must not answer it."""
    store: dict = {}
    await _repo(store).set_hosted_cloud(user_id="u1", deployment_target="gcp")

    assert "model_credential_mode" not in store["update"]


async def test_no_row_means_no_write():
    store: dict = {"rows": 0}
    assert await _repo(store).set_hosted_cloud(user_id="u1", deployment_target="gcp") is False


async def test_a_blank_user_id_is_refused_before_touching_the_database():
    store: dict = {}
    assert await _repo(store).set_hosted_cloud(user_id="  ", deployment_target="gcp") is False
    assert "update" not in store


# --------------------------------------------------------------------------- #
# 2. The three states are distinguishable
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("target", "hosted", "user_owned"),
    [
        ("gcp", True, False),
        ("user_gcp", False, True),
        (None, False, False),
        ("", False, False),
    ],
)
def test_chosen_hussh_is_not_the_same_as_not_yet_asked(target, hosted, user_owned):
    """`not is_user_owned` would collapse "I chose hussh" into "I have not been
    asked yet". The first is a finished decision, the second is a pending step in
    onboarding, and the choice exists precisely to end that ambiguity."""
    cloud = user_cloud_from_row({"deployment_target": target})

    assert cloud is not None
    assert cloud.is_hosted is hosted
    assert cloud.is_user_owned is user_owned


def test_a_hosted_row_never_blocks_provisioning():
    """`blocks_provisioning` exists for a person who NAMED a cloud hushh cannot
    yet reach. There is nothing to authorize on the hosted tier, so a hosted row
    must never be able to wedge onboarding waiting for a grant that will never
    be run."""
    cloud = user_cloud_from_row({"deployment_target": "gcp"})

    assert cloud is not None
    assert cloud.blocks_provisioning is False


# --------------------------------------------------------------------------- #
# 3. The route writes the marker BOTH doors gate on
# --------------------------------------------------------------------------- #


async def test_the_hosted_door_writes_the_same_setup_marker(monkeypatch):
    """The setup hub gates on one `cloud` capability marker.

    If the hosted door did not write it, choosing "host it with hussh" would
    leave onboarding stuck on a step the person had just completed — and the
    obvious fix (a second gating rule in the frontend) is one that can drift
    from this one.
    """
    from api.routes.one import runtime as runtime_routes

    marked: list[str] = []

    async def _fake_marker(user_id: str) -> None:
        marked.append(user_id)

    async def _fake_set_hosted_cloud(**kwargs):
        return True

    monkeypatch.setattr(runtime_routes, "_write_cloud_setup_marker", _fake_marker)

    class _Repo:
        set_hosted_cloud = staticmethod(_fake_set_hosted_cloud)

    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_registry_repo.PersonalAgentRegistryRepo",
        _Repo,
    )

    response = await runtime_routes.select_hosted_cloud.__wrapped__(  # type: ignore[attr-defined]
        request=None, firebase_uid="u1"
    )

    assert marked == ["u1"]
    assert response.deploymentTarget == "gcp"
    assert response.migratable is True


async def test_the_hosted_door_makes_the_claim_the_tier_actually_earns(monkeypatch):
    """ "hussh does not read this pod" is the honest sentence for the hosted tier.

    "hussh CANNOT read this pod" is the one only the user-owned targets earn, and
    the difference is the entire point of the migration button. The server returns
    the assurance so the client renders what the server stands behind rather than
    its own copy of it.
    """
    from api.routes.one import runtime as runtime_routes

    async def _noop(user_id: str) -> None:
        return None

    monkeypatch.setattr(runtime_routes, "_write_cloud_setup_marker", _noop)

    class _Repo:
        @staticmethod
        async def set_hosted_cloud(**kwargs):
            return True

    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_registry_repo.PersonalAgentRegistryRepo",
        _Repo,
    )

    response = await runtime_routes.select_hosted_cloud.__wrapped__(  # type: ignore[attr-defined]
        request=None, firebase_uid="u1"
    )

    assurance = response.assurance.lower()
    assert "does not read" in assurance
    assert "cannot read" not in assurance


# --------------------------------------------------------------------------- #
# 4. The lane contract, executed rather than read
# --------------------------------------------------------------------------- #

_NON_DEV_ENVS = ["uat", "prod", "production", "staging", "manual", ""]


def _run_personal_agent_block(deploy_env: str) -> dict[str, str]:
    """Execute the real deploy block and return the env vars it would set."""
    from tests._deploy_contract import backend_deploy_script

    script = backend_deploy_script()
    start = script.index('personal_agent_enabled=""')
    end = script.index('append_optional_env "CONSENT_AUDIT_CHAIN_ENABLED"')
    slice_ = script[start : script.index("\n", end) + 1]

    # Cloud Build expands ${_FOO} textually before bash sees it; reproduce that.
    slice_ = (
        slice_.replace("${_DEPLOY_ENV}", deploy_env)
        .replace("${_RUNTIME_SERVICE_ACCOUNT}", "runtime@example.iam.gserviceaccount.com")
        .replace("${PROJECT_ID}", "hushh-pda-test")
    )
    # The Ed25519 block probes Secret Manager; stub gcloud so the slice is hermetic.
    preamble = (
        "env_vars=()\n"
        "gcloud() { return 1; }\n"
        "append_optional_env() {\n"
        '  local env_name="$1"\n'
        '  local env_value="$2"\n'
        '  if [[ -n "${env_value}" ]]; then\n'
        '    env_vars+=("${env_name}=${env_value}")\n'
        "  fi\n"
        "}\n"
        "append_optional_secret() { :; }\n"
    )
    result = subprocess.run(  # noqa: S603 - fixed argv, no shell=True, test-local input
        ["bash", "-c", preamble + slice_ + '\nprintf "%s\\n" "${env_vars[@]}"'],  # noqa: S607
        text=True,
        capture_output=True,
        check=True,
    )
    return dict(line.split("=", 1) for line in result.stdout.splitlines() if line)


def test_the_dev_lane_opts_into_the_hosted_tier_and_aims_it():
    """Both halves, because the guard requires both.

    The opt-in alone would refuse: `hosted_tier_guard` also demands a named
    hosting project, so that a fleet is never created in whatever project the
    hub's credentials happen to point at.
    """
    emitted = _run_personal_agent_block("dev")

    assert emitted["HUSSH_HOSTED_POD_TIER_ENABLED"] == "true"
    assert emitted["HUSSH_POD_PROJECT"] == "hushh-pda-test"


def test_the_dev_lane_turns_on_what_was_built_and_never_enabled():
    """The read doors and the consent audit chain both shipped complete, guarded,
    and switched on in no lane at all — which is indistinguishable from not having
    been built, from the outside."""
    emitted = _run_personal_agent_block("dev")

    assert emitted["POD_DATA_DOOR_ENABLED"] == "true"
    assert emitted["CONSENT_AUDIT_CHAIN_ENABLED"] == "true"


@pytest.mark.parametrize("deploy_env", _NON_DEV_ENVS)
def test_no_other_lane_gains_any_of_them(deploy_env: str):
    """Empty values are skipped by `append_optional_env`, so uat, production and a
    container that lost its configuration are byte-identical to before."""
    names = set(_run_personal_agent_block(deploy_env))

    for flag in (
        "HUSSH_HOSTED_POD_TIER_ENABLED",
        "HUSSH_POD_PROJECT",
        "POD_DATA_DOOR_ENABLED",
        "CONSENT_AUDIT_CHAIN_ENABLED",
    ):
        assert flag not in names, f"{flag} leaked into the {deploy_env or 'unset'} lane"


def test_the_hosted_flag_is_not_the_simulation_flag():
    """Read from the script itself: the two flags must stay separate names.

    Coupling them again would mean a lane that hosts pods also runs the reviewer
    phone-verification bypass, which is the exact defect the split removed.
    """
    from tests._deploy_contract import backend_deploy_script

    script = backend_deploy_script()
    hosted = re.search(r'append_optional_env "HUSSH_HOSTED_POD_TIER_ENABLED" "\$\{(\w+)\}"', script)
    simulation = re.search(
        r'append_optional_env "HUSHH_DEV_SIMULATION_ENABLED" "\$\{(\w+)\}"', script
    )

    assert hosted and simulation
    assert hosted.group(1) != simulation.group(1)
