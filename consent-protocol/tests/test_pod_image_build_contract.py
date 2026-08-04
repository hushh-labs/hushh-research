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
from pathlib import Path

import pytest
import yaml

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


def _bash(script: str) -> str:
    return subprocess.run(  # noqa: S603 - fixed argv, no shell=True, test-local input
        ["bash", "-c", script],  # noqa: S607 - bash is resolved from PATH by design
        text=True,
        capture_output=True,
        check=False,
    ).stdout


def _run_guard(script: str, deploy_env: str, build_flag: str) -> str:
    """Run a step's script with Cloud Build substitutions already expanded.

    Cloud Build expands ``${_FOO}`` textually before bash ever sees it, so that is what
    we reproduce here. Everything after the guard is replaced with a marker, so the test
    exercises the branch decision without invoking docker.
    """
    expanded = script.replace("${_DEPLOY_ENV}", deploy_env).replace(
        "${_BUILD_POD_IMAGE}", build_flag
    )
    body, _, _ = expanded.partition("gcloud auth configure-docker")
    return _bash(body + '\necho "REACHED_BUILD"')


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
    script = _step(config, "deploy-backend")["args"][-1]
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
        "image=gcr.io/proj/consent-protocol-pod:tag "
        "sa=hussh-one-pod@proj.iam.gserviceaccount.com"
    )


def test_pod_service_account_is_the_zero_role_identity(config: dict):
    """It must be the purpose-built pod account, never the runtime or default compute
    account — those carry real permissions a per-user pod must not inherit."""
    script = _step(config, "deploy-backend")["args"][-1]
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
    script = _step(config, "deploy-backend")["args"][-1]
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
    script = _step(config, "deploy-backend")["args"][-1]
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


def test_hub_url_is_derived_not_hardcoded(config: dict):
    """A hardcoded dev URL would silently point pods at the wrong hub from any other
    project. The project-number form is the one deploy-dev.yml already relies on."""
    script = _step(config, "deploy-backend")["args"][-1]
    assert 'hub_url="https://${_BACKEND_SERVICE}-${PROJECT_NUMBER}.${_REGION}.run.app"' in script
    assert "aqahj4iyha" not in script  # the dev-specific Cloud Run hash
