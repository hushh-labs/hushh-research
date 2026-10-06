"""Microsoft removed the idle hosting space: a typed reason, and a rebuild that adopts.

Against the in-memory ARM: a real setup runs first, then the environment and the agent
are deleted the way Azure's 90-day idle policy deletes them (the resource group, the
identity, the vault and the storage survive). The rebuild must keep every custody
resource unwritten, reuse the setup nonce, and refuse with nothing written whenever
anything beyond the hosting space is gone.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from hushh_mcp.services import azure_agent_setup as setup
from hushh_mcp.services import azure_hosting_rebuild as rebuild
from hushh_mcp.services import azure_setup_job as job
from hushh_mcp.services.azure_agent_observation import AzureAgentUnreadable, observe_agent
from hushh_mcp.services.azure_setup_applier import AzureSetupRefused, SetupApplier
from hushh_mcp.services.azure_setup_plan import (
    NONCE_TAG,
    PlanInputs,
    Scopes,
    resource_group_name,
    resource_names,
)
from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
from hushh_mcp.services.user_cloud_service import resolve_user_cloud
from tests.azure_arm_fake import POD_PRINCIPAL, FakeArm

_HUSHH_ID = "ha1_abcdefghijklmnopqrstuvwxyz234567"
_TENANT = "11111111-1111-1111-1111-111111111111"
_SUB = "22222222-2222-2222-2222-222222222222"
_HUSSH_SP = "88888888-8888-8888-8888-888888888888"
_TOKEN = "person-token-for-tests"  # noqa: S105 - no service exists to authenticate to
_IMAGE = "us-central1-docker.pkg.dev/hushh-pda-dev/one-pod/consent-protocol-pod@sha256:" + "b" * 64


class _Http:
    def get(self, url, timeout=None):
        class _R:
            status_code = 200

        return _R()


@pytest.fixture(autouse=True)
def _hub_caller(monkeypatch):
    monkeypatch.setenv(
        "HUSSH_CONSENT_PLANE_SA", "consent-plane@hushh-pda-dev.iam.gserviceaccount.com"
    )


def _spec(principal: str = POD_PRINCIPAL) -> PodSpec:
    return PodSpec(
        hushh_id=_HUSHH_ID,
        phone_e164_hash="h",
        pod_pubkey="",
        billing_space_id="b",
        expected_runtime_principal=principal or None,
    )


def _run(arm: FakeArm, *, adopt: bool, principal: str = POD_PRINCIPAL):
    return setup.run_agent_setup(
        access_token=_TOKEN,
        tenant_id=_TENANT,
        subscription_id=_SUB,
        location="eastus2",
        spec=_spec(principal),
        source_image=_IMAGE,
        advance=lambda _stage: None,
        arm=arm,
        hussh_principal_id=_HUSSH_SP,
        image_credentials=lambda: {},
        http=_Http(),
        sleep=lambda _s: None,
        adopt=adopt,
    )


def _scopes(arm: FakeArm) -> Scopes:
    group = f"/subscriptions/{_SUB}/resourceGroups/{resource_group_name(_HUSHH_ID)}"
    nonce = arm.resources[group]["tags"][NONCE_TAG]
    inputs = PlanInputs(_HUSHH_ID, _TENANT, _SUB, "eastus2", resource_group_name(_HUSHH_ID), nonce)
    return Scopes(inputs, resource_names(inputs))


def _azure_reclaims_the_hosting_space(arm: FakeArm) -> Scopes:
    scopes = _scopes(arm)
    del arm.resources[scopes.app]
    del arm.resources[scopes.environment]
    return scopes


def _custody(scopes: Scopes) -> tuple[str, ...]:
    return (
        scopes.identity,
        scopes.vault,
        scopes.key,
        scopes.secret,
        scopes.storage,
        scopes.blob_service,
        scopes.container,
    )


# -- the typed reason, from the standing observer's two reads --------------------------


def _observed(arm: FakeArm, scopes: Scopes) -> str:
    return rebuild.hosting_state(observe_agent(arm, scopes.app, scopes.environment))


def test_hosting_removed_by_azure_reads_as_reclaimed_and_never_as_owner_deleted():
    arm = FakeArm()
    _run(arm, adopt=False)
    scopes = _scopes(arm)
    assert _observed(arm, scopes) == rebuild.HOSTING_PRESENT
    del arm.resources[scopes.app]
    assert _observed(arm, scopes) == rebuild.HOSTING_AGENT_REMOVED
    del arm.resources[scopes.environment]
    assert _observed(arm, scopes) == rebuild.HOSTING_RECLAIMED
    assert rebuild.HOSTING_RECLAIMED in rebuild.REBUILDABLE
    assert rebuild.HOSTING_AGENT_REMOVED not in rebuild.REBUILDABLE


def test_grants_gone_with_the_hosting_read_as_unconfirmed_not_as_absence():
    arm = FakeArm()
    _run(arm, adopt=False)
    scopes = _azure_reclaims_the_hosting_space(arm)
    arm.forbidden |= {scopes.app, scopes.environment}
    observation = observe_agent(arm, scopes.app, scopes.environment)
    assert rebuild.hosting_state(observation) == rebuild.HOSTING_UNCONFIRMED
    assert rebuild.HOSTING_UNCONFIRMED in rebuild.REBUILDABLE


# -- the rebuild adopts what survived ----------------------------------------------------


def test_the_rebuild_adopts_the_surviving_identity_vault_and_storage_and_writes_none_of_them():
    arm = FakeArm()
    first = _run(arm, adopt=False)
    scopes = _azure_reclaims_the_hosting_space(arm)
    before = {path: arm.resources[path] for path in _custody(scopes)}
    start = len(arm.calls)

    rebuilt = _run(arm, adopt=True)

    written = {path for method, path, _ in arm.calls[start:] if method == "PUT"}
    assert written.isdisjoint(_custody(scopes))
    assert {scopes.environment, scopes.app} <= written
    assert {path: arm.resources[path] for path in _custody(scopes)} == before
    assert rebuilt.nonce == first.nonce
    assert rebuilt.pod_principal_id == first.pod_principal_id == POD_PRINCIPAL
    assert _observed(arm, scopes) == rebuild.HOSTING_PRESENT


@pytest.mark.parametrize(
    ("gone", "code"),
    [
        ("vault", "REBUILD_CUSTODY_MISSING"),
        ("key", "REBUILD_CUSTODY_MISSING"),
        ("secret", "REBUILD_CUSTODY_MISSING"),
        ("storage", "REBUILD_CUSTODY_MISSING"),
        ("container", "REBUILD_CUSTODY_MISSING"),
        ("identity", "REBUILD_IDENTITY_MISSING"),
        ("group", "REBUILD_GROUP_MISSING"),
    ],
)
def test_a_rebuild_never_mints_custody_it_refuses_with_nothing_written(gone, code):
    arm = FakeArm()
    _run(arm, adopt=False)
    scopes = _azure_reclaims_the_hosting_space(arm)
    del arm.resources[getattr(scopes, gone)]
    start = len(arm.calls)

    with pytest.raises(AzureSetupRefused) as refused:
        _run(arm, adopt=True)

    assert refused.value.code == code
    assert [c for c in arm.calls[start:] if c[0] != "GET"] == []


@pytest.mark.parametrize(
    ("delete", "code"),
    [((), "REBUILD_NOT_NEEDED"), (("app",), "REBUILD_AGENT_REMOVED")],
)
def test_a_rebuild_runs_only_when_the_hosting_space_itself_is_gone(delete, code):
    arm = FakeArm()
    _run(arm, adopt=False)
    scopes = _scopes(arm)
    for name in delete:
        del arm.resources[getattr(scopes, name)]
    start = len(arm.calls)
    with pytest.raises(AzureSetupRefused) as refused:
        _run(arm, adopt=True)
    assert refused.value.code == code
    assert [c for c in arm.calls[start:] if c[0] != "GET"] == []


def test_a_rebuild_refuses_an_identity_other_than_the_recorded_one():
    arm = FakeArm()
    _run(arm, adopt=False)
    _azure_reclaims_the_hosting_space(arm)
    with pytest.raises(AzureSetupRefused) as refused:
        _run(arm, adopt=True, principal="99999999-9999-9999-9999-999999999999")
    assert refused.value.code == "REBUILD_IDENTITY_CHANGED"


def test_the_applier_in_adopt_mode_refuses_a_custody_resource_that_vanished_mid_rebuild():
    """The survey ran, then the vault went: the applier still never mints one."""
    arm = FakeArm()
    _run(arm, adopt=False)
    scopes = _azure_reclaims_the_hosting_space(arm)
    del arm.resources[scopes.vault]
    plan_for = setup.plan_factory(
        _spec(), source_registry="r.example.com", source_repository="p", incarnation="i"
    )
    plan = plan_for(PlanInputs(_HUSHH_ID, _TENANT, _SUB, "eastus2", scopes.group.rsplit("/", 1)[1],
                               arm.resources[scopes.group]["tags"][NONCE_TAG]))  # fmt: skip
    applier = SetupApplier(arm, advance=lambda _s: None, sleep=lambda _s: None, adopt=True)
    start = len(arm.calls)
    with pytest.raises(AzureSetupRefused) as refused:
        applier.apply(plan, values={"husshPrincipalId": _HUSSH_SP}, plan_for=plan_for)
    assert refused.value.code == "REBUILD_CUSTODY_MISSING"
    written = [path for method, path, _ in arm.calls[start:] if method == "PUT"]
    assert not any(path.startswith(scopes.vault) or path == scopes.identity for path in written)


# -- the job and the hand-off to adoption ------------------------------------------------


class _Repo:
    def __init__(self) -> None:
        self.finished: dict = {}

    async def advance(self, *, user_id, job_id, stage):
        return None

    async def finish(self, *, user_id, job_id, status, error_code=None, error_message=None):
        self.finished = {"status": status, "code": error_code, "message": error_message}

    async def touch(self, *, user_id, job_id):
        return True


async def _rebuild_job(repo: _Repo, setup_fn, events: list) -> None:
    async def publish():
        events.append("publish")

    async def adopted():
        events.append("adopt")

    spec = PodSpec(
        hushh_id="h", phone_e164_hash="p", pod_pubkey="", user_cloud_tenant_id=_TENANT,
        user_cloud_subscription_id=_SUB, user_cloud_resource_group="rg", user_cloud_region="eastus2",
    )  # fmt: skip
    await job.run_azure_rebuild_job(
        user_id="u1", job_id="j1", access_token=_TOKEN, spec=spec, source_image=_IMAGE,
        publish=publish, on_recorded=adopted, repo=repo, setup=setup_fn,
    )  # fmt: skip


async def test_the_rebuild_job_runs_setup_in_adopt_mode_then_publishes_then_adopts():
    repo, events, seen = _Repo(), [], {}

    def fake_setup(**kwargs):
        seen.update(kwargs)
        events.append("setup")

    await _rebuild_job(repo, fake_setup, events)
    assert seen["adopt"] is True and seen["subscription_id"] == _SUB
    assert seen["tenant_id"] == _TENANT and seen["location"] == "eastus2"
    assert events == ["setup", "publish", "adopt"]
    assert repo.finished["status"] == "recorded"


async def test_every_rebuild_refusal_is_recorded_under_the_rebuild_prefix():
    repo, events = _Repo(), []

    def refused(**_kwargs):
        raise AzureSetupRefused("Your Microsoft sign-in expired.", code="AZURE_SIGN_IN_EXPIRED")

    await _rebuild_job(repo, refused, events)
    assert repo.finished["code"] == "REBUILD_AZURE_SIGN_IN_EXPIRED"
    assert events == []

    def custody(**_kwargs):
        raise AzureSetupRefused("gone", code="REBUILD_CUSTODY_MISSING")

    await _rebuild_job(repo, custody, events)
    assert repo.finished["code"] == "REBUILD_CUSTODY_MISSING"


class _Table:
    """The registry table in memory, with UPDATE semantics: every fence must match."""

    def __init__(self, rows: list[dict]) -> None:
        self.rows, self._fence, self._data = rows, [], None

    def table(self, _name):
        query = _Table(self.rows)
        return query

    def select(self, _cols="*"):
        return self

    def update(self, data):
        self._data = dict(data)
        return self

    def eq(self, column, value):
        self._fence.append((column, value))
        return self

    def is_(self, column, value):
        return self.eq(column, value)

    def limit(self, _n):
        return self

    def execute(self):
        hit = [r for r in self.rows if all(r.get(c) == v for c, v in self._fence)]
        for row in hit if self._data is not None else ():
            row.update(self._data)
        return SimpleNamespace(data=[dict(r) for r in hit])


def _row(**overrides) -> dict:
    row = {
        "user_id": "u1", "hushh_id": "h", "deployment_target": "user_azure",
        "external_agent_id": "/app", "status": "provisioned", "updated_at": "t1",
        "backend": "user_azure", "user_cloud_authorized_at": "2026-07-01T00:00:00+00:00",
        "user_cloud_tenant_id": _TENANT, "user_cloud_subscription_id": _SUB,
        "user_cloud_resource_group": "rg-hussh-h", "user_cloud_region": "eastus",
    }  # fmt: skip
    return {**row, **overrides}


_EXPECTED = {
    key: str(_row()[key])
    for key in (
        "hushh_id", "deployment_target", "external_agent_id",
        "user_cloud_tenant_id", "user_cloud_subscription_id", "user_cloud_resource_group",
    )
}  # fmt: skip


def _registry(row: dict) -> tuple[PersonalAgentRegistryRepo, dict]:
    stored = dict(row)
    return PersonalAgentRegistryRepo(client=_Table([stored])), stored


async def test_a_rebuilt_agent_is_handed_to_adoption_and_can_still_be_updated():
    registry, stored = _registry(_row(updated_at="t2"))
    await rebuild.record_rebuilt_agent(user_id="u1", expected=_EXPECTED, registry=registry)
    assert stored["status"] == "needs_reinit"
    assert stored["user_cloud_authorized_at"] not in (None, "2026-07-01T00:00:00+00:00")
    assert stored["external_agent_id"] == "/app" and stored["hushh_id"] == "h"
    # The exact gate upgrade_pod and provision apply before any Azure update.
    cloud = await resolve_user_cloud("u1", repo=registry)
    assert cloud is not None and cloud.authorized and not cloud.blocks_provisioning


async def test_the_confirmed_gone_writer_would_have_blocked_every_later_update():
    """Negative control: this is why the rebuild does not reuse ``mark_needs_reinit``."""
    registry, stored = _registry(_row())
    assert await registry.mark_needs_reinit("u1", observed=dict(stored))
    cloud = await resolve_user_cloud("u1", repo=registry)
    assert cloud is not None and cloud.blocks_provisioning


class _StaleRead(PersonalAgentRegistryRepo):
    """``get`` returns what the job saw; the table has moved on underneath it."""

    def __init__(self, client, stale: dict) -> None:
        super().__init__(client=client)
        self._stale = stale

    async def get(self, user_id):
        return dict(self._stale)


@pytest.mark.parametrize(
    ("seen", "stored"),
    [
        (_row(hushh_id="someone-else"), _row(hushh_id="someone-else")),
        (_row(user_cloud_subscription_id="other"), _row(user_cloud_subscription_id="other")),
        (_row(status="suspended"), _row(status="suspended")),
        # A write between the hand-off's own final re-read and its UPDATE. A change
        # earlier in the rebuild is caught by ``expected`` and the status allowlist.
        pytest.param(_row(), _row(updated_at="t9"), id="changed-after-final-re-read"),
        (_row(), _row(user_cloud_resource_group="rg-moved")),
    ],
)
async def test_a_changed_record_refuses_the_hand_off_and_writes_nothing(seen, stored):
    table = _Table([dict(stored)])
    with pytest.raises(AzureSetupRefused) as refused:
        await rebuild.record_rebuilt_agent(
            user_id="u1", expected=_EXPECTED, registry=_StaleRead(table, seen)
        )
    assert refused.value.code == "CLOUD_NOT_RECORDED"
    assert table.rows == [stored]


async def test_adoption_waits_for_the_new_observer_grant_and_never_raises():
    calls, slept = [], []

    async def adopt(*, user_id):
        calls.append(user_id)
        if len(calls) < 3:
            raise AzureAgentUnreadable("grant settling")
        return {"adopted": True}

    async def sleep(seconds):
        slept.append(seconds)

    assert await rebuild.adopt_rebuilt_agent("u1", adopt=adopt, sleep=sleep) is True
    assert len(calls) == 3 and slept == [10.0, 20.0]

    async def broken(*, user_id):
        raise RuntimeError("registry down")

    assert await rebuild.adopt_rebuilt_agent("u1", adopt=broken, sleep=sleep) is False


class _JobRecord:
    def __init__(self, job: dict | None) -> None:
        self.job = job

    async def get(self, user_id):
        return self.job


@pytest.mark.parametrize(
    "current",
    [
        None,
        {"job_id": "job-newer", "status": "running"},
        {"job_id": "job-1", "status": "failed"},
    ],
)
async def test_a_superseded_rebuild_never_hands_off_over_a_newer_job(current):
    from hushh_mcp.services.byoc_setup_job_service import JobSuperseded

    registry, stored = _registry(_row(updated_at="t2"))
    before = dict(stored)
    with pytest.raises(JobSuperseded):
        await rebuild.record_rebuilt_agent(
            user_id="u1",
            expected=_EXPECTED,
            registry=registry,
            jobs=_JobRecord(current),
            job_id="job-1",
        )
    assert stored == before


async def test_the_running_rebuild_that_owns_the_job_row_hands_off():
    registry, stored = _registry(_row(updated_at="t2"))
    await rebuild.record_rebuilt_agent(
        user_id="u1",
        expected=_EXPECTED,
        registry=registry,
        jobs=_JobRecord({"job_id": "job-1", "status": "running"}),
        job_id="job-1",
    )
    assert stored["status"] == "needs_reinit"


@pytest.mark.parametrize(
    ("job", "expected"),
    [
        (None, False),
        ({"stage": "importing_image", "stages": [{"stage": "importing_image"}]}, False),
        ({"stage": "rebuilding", "stages": []}, True),
        ({"stage": "proving", "stages": [{"stage": "rebuilding"}, {"stage": "proving"}]}, True),
    ],
)
def test_a_rebuild_record_is_told_from_a_setup_or_an_update(job, expected):
    assert rebuild.is_rebuild_job(job) is expected
