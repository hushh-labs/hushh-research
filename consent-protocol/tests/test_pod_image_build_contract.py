"""The slim pod image and pod identity are wired in DEV ONLY — proven, not asserted.

`deploy/backend.cloudbuild.yaml` gained a `build-pod-image` step so that
``HUSSH_ONE_POD_IMAGE`` finally resolves to something real, plus the
``HUSSH_ONE_POD_SERVICE_ACCOUNT`` wiring for the zero-role pod identity created in
`hushh-pda-dev`. That file is read from the *deployed SHA* rather than from ``main``,
which is what makes shipping it on a feature branch possible at all — and also what
makes a mistake here dangerous, because the same template is what uat and production
deploy.

The founder constraint is explicit: dev only, and nothing that moves uat or production
until a human decides otherwise. These tests execute the real guard with `bash` for every
environment value rather than reading the YAML and trusting it, because a guard that is
merely *present* is not a guard that *holds*.
"""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

import pytest
import yaml

from tests._deploy_contract import backend_deploy_script

REPO_ROOT = Path(__file__).resolve().parents[2]
CLOUDBUILD = REPO_ROOT / "deploy" / "backend.cloudbuild.yaml"

# Every value the deploy lanes actually pass. `manual` is the template's own default.
NON_DEV_ENVS = ["uat", "prod", "production", "manual", ""]


@pytest.fixture(scope="module")
def config() -> dict:
    return yaml.safe_load(CLOUDBUILD.read_text(encoding="utf-8"))


def _step(config: dict, step_id: str) -> dict:
    for step in config["steps"]:
        if step.get("id") == step_id:
            return step
    raise AssertionError(f"{step_id} step is missing from backend.cloudbuild.yaml")


@pytest.fixture(scope="module")
def pod_step(config: dict) -> dict:
    return _step(config, "build-pod-image")


def _bash(script: str, cwd: str | None = None) -> str:
    return subprocess.run(  # noqa: S603 - fixed argv, no shell=True, test-local input
        ["bash", "-c", script],  # noqa: S607 - bash is resolved from PATH by design
        text=True,
        capture_output=True,
        check=False,
        cwd=cwd,
    ).stdout


def _run_guard(script: str, deploy_env: str, build_flag: str) -> str:
    """Run a step's script with Cloud Build substitutions already expanded.

    Cloud Build expands ``${_FOO}`` textually before bash ever sees it, so that is what
    we reproduce here. Everything after the guard is replaced with a marker, so the test
    exercises the branch decision without invoking docker.

    Runs in a throwaway copy of the WORKSPACE SHAPE -- a `contracts/` tree beside a
    `consent-protocol/` directory -- because that is what Cloud Build gives the step,
    and the step now stages contracts into the build context before building. Running
    it from `consent-protocol/` (pytest's cwd) instead would make the staging fail
    under `set -e` and report it as a guard failure, which is a fixture defect, not a
    finding. The step is deliberately allowed to fail hard when contracts are absent:
    an image with no contracts tree runs with an empty action gateway and no persona
    grounding, and shipping that silently is the bug this staging exists to fix.
    """
    expanded = script.replace("${_DEPLOY_ENV}", deploy_env).replace(
        "${_BUILD_POD_IMAGE}", build_flag
    )
    body, _, _ = expanded.partition("gcloud auth configure-docker")
    with tempfile.TemporaryDirectory() as workspace:
        root = Path(workspace)
        (root / "contracts" / "agents").mkdir(parents=True)
        (root / "contracts" / "agents" / "product-agent-registry.v2.json").write_text("{}")
        (root / "consent-protocol").mkdir()
        return _bash(body + '\necho "REACHED_BUILD"', cwd=str(root))


# --- the load-bearing constraint: uat and production never build a pod ---------------


@pytest.mark.parametrize("deploy_env", NON_DEV_ENVS)
def test_non_dev_environments_never_build_the_pod_image(pod_step: dict, deploy_env: str):
    """Even with the kill-switch on, anything that is not exactly 'dev' must skip."""
    out = _run_guard(pod_step["args"][-1], deploy_env, "true")
    assert "REACHED_BUILD" not in out
    assert "skipped" in out


def test_dev_with_the_switch_on_builds(pod_step: dict):
    assert "REACHED_BUILD" in _run_guard(pod_step["args"][-1], "dev", "true")


def test_dev_with_the_switch_off_does_not_build(pod_step: dict):
    """The kill-switch turns the step off without reverting the file."""
    assert "REACHED_BUILD" not in _run_guard(pod_step["args"][-1], "dev", "false")


def test_guard_is_exact_equality_not_a_prefix_match(pod_step: dict):
    """A substring/prefix test on an environment name is the class of bug that fires in
    production. 'dev' is a prefix of nothing we deploy today, but the guard must not
    depend on that remaining true."""
    script = pod_step["args"][-1]
    assert '"${_DEPLOY_ENV}" != "dev"' in script
    for forbidden in ("=~", "== dev*", '"dev"*', "startswith"):
        assert forbidden not in script


# --- the env vars must never point at resources this lane did not create -------------


@pytest.mark.parametrize("deploy_env", NON_DEV_ENVS)
def test_pod_env_vars_are_empty_outside_dev(config: dict, deploy_env: str):
    """`append_optional_env` skips empty values, so empty means the variable is never
    set and GcpBackend keeps resolving to nothing — byte-identical to before."""
    script = backend_deploy_script()
    assert 'append_optional_env "HUSSH_ONE_POD_IMAGE" "${pod_image}"' in script
    assert 'append_optional_env "HUSSH_ONE_POD_SERVICE_ACCOUNT" "${pod_sa}"' in script

    out = _bash(
        'pod_image=""; pod_sa=""\n'
        f'if [[ "{deploy_env}" == "dev" && "true" == "true" ]]; then\n'
        '  pod_image="gcr.io/proj/consent-protocol-pod:tag"\n'
        "fi\n"
        f'if [[ "{deploy_env}" == "dev" ]]; then\n'
        '  pod_sa="hussh-one-pod@proj.iam.gserviceaccount.com"\n'
        "fi\n"
        'echo "image=${pod_image} sa=${pod_sa}"'
    )
    assert out.strip() == "image= sa="


def test_pod_env_vars_are_set_in_dev():
    out = _bash(
        'pod_image=""; pod_sa=""\n'
        'if [[ "dev" == "dev" && "true" == "true" ]]; then\n'
        '  pod_image="gcr.io/proj/consent-protocol-pod:tag"\n'
        "fi\n"
        'if [[ "dev" == "dev" ]]; then\n'
        '  pod_sa="hussh-one-pod@proj.iam.gserviceaccount.com"\n'
        "fi\n"
        'echo "image=${pod_image} sa=${pod_sa}"'
    )
    assert out.strip() == (
        "image=gcr.io/proj/consent-protocol-pod:tag sa=hussh-one-pod@proj.iam.gserviceaccount.com"
    )


def test_pod_service_account_is_the_zero_role_identity(config: dict):
    """It must be the purpose-built pod account, never the runtime or default compute
    account — those carry real permissions a per-user pod must not inherit."""
    script = backend_deploy_script()
    assert 'pod_sa="hussh-one-pod@${PROJECT_ID}.iam.gserviceaccount.com"' in script
    assert "consent-protocol-runtime@" not in script.split("pod_sa=")[1][:200]
    assert "-compute@developer.gserviceaccount.com" not in script


# --- structural guarantees -----------------------------------------------------------


def test_kill_switch_has_a_declared_default(config: dict):
    """An undeclared substitution makes `gcloud builds submit` reject the build."""
    assert config["substitutions"]["_BUILD_POD_IMAGE"] == "true"


def test_pod_image_repository_is_distinct_from_the_hub_image(pod_step: dict):
    """The pod must never be pushed over the hub image tag — they are different runtime
    surfaces and overwriting the hub would take down the control plane."""
    script = pod_step["args"][-1]
    assert "consent-protocol-pod:" in script
    assert "/consent-protocol:" not in script


def test_pod_dockerfile_exists(pod_step: dict):
    assert "--file consent-protocol/Dockerfile.pod" in pod_step["args"][-1]
    assert (REPO_ROOT / "consent-protocol" / "Dockerfile.pod").is_file()


def test_the_pod_runs_exactly_one_worker():
    """The single-writer invariant, enforced where it is actually decided.

    `GcpBackend` pins maxScale=1 and calls single-writer a CORRECTNESS constraint,
    "not a tuning knob" -- then the image ran `-w 2` one process layer below, where
    nothing checked. gunicorn does not preload by default, so each worker imported
    the app independently, ran the startup hook independently, and got its own
    module-level `_STATE` in `pod_self_registration`.

    A pod generates an ephemeral X25519 keypair at boot, so that meant TWO
    IDENTITIES INSIDE ONE POD, with `/pod/public-key` returning whichever worker
    answered. Anything the hub sealed to that key had a coin-flip chance of being
    unreadable by the worker serving the next turn.

    Asserted against the Dockerfile rather than against a constant this file also
    owns, because a test that restates the value it guards agrees with the bug for
    exactly as long as both are wrong together.
    """
    dockerfile = (REPO_ROOT / "consent-protocol" / "Dockerfile.pod").read_text(encoding="utf-8")
    command = next(line for line in dockerfile.splitlines() if line.startswith("CMD"))

    assert " -w 1 " in command, f"pod must run exactly one worker; got: {command}"
    assert " -w 2 " not in command


# --- the hub's own readiness must not lie either -------------------------------------


def test_hub_deploy_sets_an_explicit_http_startup_probe(config: dict):
    """Same false-health defect as the pod, different surface.

    Cloud Run's default startup probe is a TCP connect and gunicorn binds its port before
    forking workers, so a hub revision whose workers die on import reports Ready and
    ContainerHealthy while serving 503 (observed in hushh-pda-dev, 2026-08-04). Deploy
    gates, uptime checks and the reconcile loop all read that condition, so it has to
    mean what it says on every lane -- not only for pods, whose probe is set in
    GcpBackend.render_deploy_config.
    """
    script = backend_deploy_script()
    assert "--startup-probe=httpGet.path=/health" in script
    assert "tcpSocket" not in script

    # The window must stay at least as generous as the default Cloud Run already
    # allowed, so a revision that starts as fast as today's cannot newly fail a deploy.
    probe = next(line for line in script.splitlines() if "--startup-probe=" in line)
    period = int(probe.split("periodSeconds=")[1].split(",")[0])
    failures = int(probe.split("failureThreshold=")[1].split(",")[0].rstrip('"'))
    assert period * failures >= 240


# --- the pod -> hub data path is dev-only ---------------------------------------------


@pytest.mark.parametrize("deploy_env", NON_DEV_ENVS)
def test_pod_hub_identity_auth_is_never_enabled_outside_dev(config: dict, deploy_env: str):
    """The load-bearing one. Every pod shares a service account, so accepting a pod's ID
    token proves "a hussh pod", not WHICH user's pod -- the agent id comes from the pod's
    own assertion. In an environment holding real users, one compromised pod could read
    another user's prompt. Dev carries synthetic users only, so the guard is what keeps
    this honest.
    """
    script = backend_deploy_script()
    assert 'append_optional_env "POD_HUB_IDENTITY_AUTH_ENABLED" "${pod_identity_auth}"' in script

    out = _bash(
        'hub_url=""; pod_identity_auth=""; pod_allowed_sa=""\n'
        f'if [[ "{deploy_env}" == "dev" ]]; then\n'
        '  hub_url="https://svc-123.us-central1.run.app"\n'
        '  pod_identity_auth="true"\n'
        '  pod_allowed_sa="hussh-one-pod@proj.iam.gserviceaccount.com"\n'
        "fi\n"
        'echo "url=${hub_url} auth=${pod_identity_auth} sa=${pod_allowed_sa}"'
    )
    assert out.strip() == "url= auth= sa="


def test_pod_hub_data_path_is_wired_in_dev():
    out = _bash(
        'hub_url=""; pod_identity_auth=""; pod_allowed_sa=""\n'
        'if [[ "dev" == "dev" ]]; then\n'
        '  hub_url="https://svc-123.us-central1.run.app"\n'
        '  pod_identity_auth="true"\n'
        '  pod_allowed_sa="hussh-one-pod@proj.iam.gserviceaccount.com"\n'
        "fi\n"
        'echo "url=${hub_url} auth=${pod_identity_auth} sa=${pod_allowed_sa}"'
    )
    assert out.strip() == (
        "url=https://svc-123.us-central1.run.app auth=true "
        "sa=hussh-one-pod@proj.iam.gserviceaccount.com"
    )


def test_hub_url_is_read_from_cloud_run_not_constructed(config: dict):
    """The hub's url is ASKED FOR, never assumed.

    A hardcoded dev url would point pods at the wrong hub from any other project. An
    earlier version reconstructed it from the $PROJECT_NUMBER substitution and that dev
    deploy was rejected inside `gcloud builds submit` before any Cloud Build existed
    (2026-08-04) -- the exact error was unrecoverable, so that is the suspect rather than
    a proven cause. Reading status.url needs no substitution at all, which is why it is
    the shape pinned here.
    """
    script = backend_deploy_script()
    assert 'gcloud run services describe "${_BACKEND_SERVICE}"' in script
    assert "--format='value(status.url)'" in script
    assert "aqahj4iyha" not in script  # the dev-specific Cloud Run hash
    # The assignment itself must not rebuild a url; a mention inside a comment is fine.
    assignment = script.split("hub_url=", 1)[1][:200]
    assert ".run.app" not in assignment
    assert "PROJECT_NUMBER" not in assignment


# --- the limit that broke every lane, now guarded --------------------------------------

# Cloud Build's hard cap on a single build-step arg.
_CLOUD_BUILD_MAX_ARG = 10_000
# Warn well before the cliff: the deploy-backend body grew ~1,000 chars in a single
# commit, so a threshold close to the limit would give no useful runway.
_ARG_WARN_THRESHOLD = 8_000

_CLOUDBUILD_CONFIGS = [
    "deploy/backend.cloudbuild.yaml",
    "deploy/frontend.cloudbuild.yaml",
    "deploy/dev.autodeploy.backend.cloudbuild.yaml",
]


@pytest.mark.parametrize("config_path", _CLOUDBUILD_CONFIGS)
def test_no_cloud_build_step_arg_exceeds_the_limit(config_path: str):
    """Every step arg in every cloudbuild config must stay under 10,000 characters.

    This is the regression guard for a real outage. `deploy-backend`'s inline body
    crossed the limit on 2026-07-28 (commit 363a9932d, 9,559 -> 10,569) and from that
    moment EVERY backend deploy failed at submission on all three lanes -- dev, uat and
    production -- with:

        INVALID_ARGUMENT: invalid .steps field: build step 2 arg 1 too long (max: 10000)

    Nothing caught it for a week, because gcloud enforces the cap client-side before any
    Build resource exists: there is no failed build to look at, no log to read, and the
    lanes had simply not been dispatched. `deploy/backend.cloudbuild.yaml` is shared by
    all three workflows, so a single file put production in that state.

    Had this assertion existed, it would have failed on the commit that introduced it.
    """
    path = REPO_ROOT / config_path
    config = yaml.safe_load(path.read_text(encoding="utf-8"))
    for index, step in enumerate(config.get("steps") or []):
        for arg_index, arg in enumerate(step.get("args") or []):
            size = len(arg)
            assert size < _CLOUD_BUILD_MAX_ARG, (
                f"{config_path} step {index} ({step.get('id')}) arg {arg_index} is "
                f"{size} chars, over Cloud Build's {_CLOUD_BUILD_MAX_ARG} limit -- "
                f"gcloud will reject this config and NO build will be created. Move the "
                f"body into a script, as scripts/deploy/backend-deploy.sh does."
            )
            assert size < _ARG_WARN_THRESHOLD, (
                f"{config_path} step {index} ({step.get('id')}) arg {arg_index} is "
                f"{size} chars — under the {_CLOUD_BUILD_MAX_ARG} limit but past the "
                f"{_ARG_WARN_THRESHOLD} warning line. Extract it now, before a later "
                f"commit pushes it over and breaks every deploy lane at once."
            )


def test_the_extracted_deploy_script_receives_every_variable_it_reads():
    """`set -u` plus a missing `env:` entry would fail the deploy at runtime.

    Cloud Build substitutes ${_FOO} in the config, never inside a file from the source
    tarball, so the script reads real environment variables handed over by the step's
    `env:` list. Any variable referenced but not passed would be unbound.
    """
    import re

    config = yaml.safe_load(CLOUDBUILD.read_text(encoding="utf-8"))
    step = _step(config, "deploy-backend")
    script = backend_deploy_script()

    passed = {entry.split("=", 1)[0] for entry in (step.get("env") or [])}
    body = "\n".join(line for line in script.splitlines() if not line.lstrip().startswith("#"))
    referenced = set(re.findall(r"\$\{(_[A-Z0-9_]+)\}", body))
    referenced |= set(re.findall(r"\$\{?(PROJECT_ID)\}?", body))

    missing = sorted(referenced - passed)
    assert not missing, f"referenced in the script but absent from the step's env: {missing}"


def test_the_step_keeps_its_substitution_tokens_in_the_yaml():
    """deploy-dev.yml's skew guard greps this YAML for "${_KEY}" and SILENTLY DROPS any
    substitution it cannot find — the deploy would then run on template defaults with no
    error at all. Keeping the tokens in the `env:` list is what preserves that guard."""
    raw = CLOUDBUILD.read_text(encoding="utf-8")
    for key in ("_DEPLOY_ENV", "_IMAGE_TAG", "_BACKEND_SERVICE", "_RUNTIME_SERVICE_ACCOUNT"):
        assert f"${{{key}}}" in raw, (
            f"{key} lost its ${{...}} token in the YAML; deploy-dev.yml's skew guard "
            f"would silently drop it and the deploy would use the template default."
        )
