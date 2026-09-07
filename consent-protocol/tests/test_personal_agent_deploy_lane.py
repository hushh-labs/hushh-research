"""The per-user-pod journey's configuration, proved by RUNNING the deploy script.

Before this, `grep -r PERSONAL_AGENT deploy/ scripts/deploy/` returned nothing. Every
flag behind the personal-agent path existed in `runtime_settings` and defaulted OFF, so
in every environment:

  * `personal_agent_enabled()` was False, so the surface 404'd;
  * `HUSSH_GCP_BACKEND_LIVE` was unset, so `GcpBackend` stayed in PLAN MODE -- it
    returned a rendered config and never called Cloud Run, which reads as success at
    every layer above it;
  * `HUSSH_POD_INVOKER_MEMBER` was unset, so no pod was invokable by anyone.

A validated AI key therefore left the registry row at `pending` and nothing -- no code,
no log line, no alert -- said so.

WHY THIS EXECUTES THE SCRIPT INSTEAD OF GREPPING IT
---------------------------------------------------
The other deploy-contract tests in this directory read the file as text. That proves a
string is present; it does not prove the branch containing it ever runs, and every one
of these values sits inside a `_DEPLOY_ENV == dev` conditional. A grep would pass just
as happily if the guard were inverted.

So this puts a stub `gcloud` on PATH, runs the real script, and reads the real argv of
the real `gcloud run deploy` call. The env list is parsed out of the YAML rather than
restated here, so a variable added to the script but not to the YAML `env:` block fails
here too (`set -u`), from the runtime side rather than the textual one.
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import pytest

from tests._deploy_contract import BACKEND_CLOUDBUILD, BACKEND_DEPLOY_SCRIPT

REPO_ROOT = Path(__file__).resolve().parents[2]
PROJECT = "hushh-pda-dev"
RUNTIME_SA = f"consent-protocol-runtime@{PROJECT}.iam.gserviceaccount.com"
HUB_URL = "https://consent-protocol-abc123-uc.a.run.app"

# Answers every gcloud read the script makes on its way to the deploy, then records the
# deploy's argv instead of performing it. `bindings.role=` is echoed back from the
# filter so both IAM preflights pass without the stub knowing which roles exist.
_GCLOUD_STUB = f"""#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GCLOUD_CALLS"
case "$1 $2" in
  "run deploy")
    for arg in "$@"; do printf '%s\\n' "$arg" >> "$DEPLOY_ARGV"; done
    exit 0 ;;
  "run services") echo "{HUB_URL}" ; exit 0 ;;
  "services list") echo "aiplatform.googleapis.com" ; exit 0 ;;
  "projects get-iam-policy")
    for arg in "$@"; do
      if [[ "$arg" == *"bindings.role="* ]]; then
        role="${{arg#*bindings.role=}}"; echo "${{role%% *}}"
      fi
    done
    exit 0 ;;
esac
exit 0
"""


def _yaml_env_names() -> list[str]:
    """The `_FOO=${{_FOO}}` passthrough list in the deploy step -- the script's whole
    input surface, since `set -u` makes any omission fatal."""
    text = BACKEND_CLOUDBUILD.read_text(encoding="utf-8")
    return sorted(set(re.findall(r'^\s+- "(_[A-Z0-9_]+)=\$\{_[A-Z0-9_]+\}"', text, re.M)))


def _yaml_env_entries() -> list[str]:
    """The deploy-backend step's `env:` entries, verbatim (`NAME=value`)."""
    import yaml

    config = yaml.safe_load(BACKEND_CLOUDBUILD.read_text(encoding="utf-8"))
    for step in config.get("steps") or []:
        if step.get("id") == "deploy-backend":
            return list(step.get("env") or [])
    raise AssertionError("no deploy-backend step")


def _yaml_substitution_defaults() -> dict[str, str]:
    """The declared `substitutions:` defaults.

    Cloud Build applies these whenever a lane does not override, so seeding the run
    with them reproduces a real deploy rather than an all-empty one -- and it is what
    supplies the numeric values the script's own preflights require.
    """
    text = BACKEND_CLOUDBUILD.read_text(encoding="utf-8")
    block = text.split("\nsubstitutions:\n", 1)[1].split("\noptions:", 1)[0]
    found: dict[str, str] = {}
    for line in block.splitlines():
        match = re.match(r'^  (_[A-Z0-9_]+):\s*"?([^"#]*?)"?\s*$', line)
        if match:
            found[match.group(1)] = match.group(2)
    return found


def _run(tmp_path: Path, **overrides: str) -> list[str]:
    """Run the real deploy script with a stub gcloud; return the deploy argv."""
    # One directory per invocation: a couple of tests take both a fixture and a direct
    # run, and a shared argv file would append the second deploy onto the first.
    run_dir = tmp_path / f"run{len(list(tmp_path.iterdir()))}"
    bin_dir = run_dir / "bin"
    bin_dir.mkdir(parents=True)
    stub = bin_dir / "gcloud"
    stub.write_text(_GCLOUD_STUB, encoding="utf-8")
    stub.chmod(0o755)

    argv_file = run_dir / "argv.txt"
    env = {
        "PATH": f"{bin_dir}:{os.environ.get('PATH', '')}",
        "HOME": str(tmp_path),
        "PROJECT_ID": PROJECT,
        "DEPLOY_ARGV": str(argv_file),
        "GCLOUD_CALLS": str(run_dir / "calls.txt"),
    }
    # Everything the YAML hands over, at the YAML's own declared default -- which is
    # exactly what Cloud Build supplies when a lane does not override, so this run
    # reproduces a real deploy rather than an all-empty one. Anything the YAML passes
    # through but never defaults is empty, which is the honest state: append_optional_env
    # skips it and the runtime_settings default applies.
    # Reproduce Cloud Build's substitution: overrides ARE substitutions, and every
    # `${_X}` inside a step env value is expanded from them (a packed entry such as
    # _CLOUD_RUN_CAPACITY carries several substitutions in one value, so expanding the
    # value, not just naming it, is what keeps this run faithful to a real deploy).
    substitutions = {**_yaml_substitution_defaults(), **overrides}

    def _expand(value: str) -> str:
        return re.sub(r"\$\{(_[A-Z0-9_]+)\}", lambda m: substitutions.get(m.group(1), ""), value)

    for entry in _yaml_env_entries():
        name, _, value = entry.partition("=")
        env.setdefault(name, _expand(value))
    env["_RUNTIME_SERVICE_ACCOUNT"] = RUNTIME_SA
    env.update({k: v for k, v in overrides.items() if k not in env or k in substitutions})

    result = subprocess.run(  # noqa: S603 - fixed argv, no shell, hermetic stub PATH
        ["bash", str(BACKEND_DEPLOY_SCRIPT)],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, f"script failed:\n{result.stdout}\n{result.stderr}"
    return argv_file.read_text(encoding="utf-8").splitlines()


def _env_vars(argv: list[str]) -> dict[str, str]:
    """Unpack `--set-env-vars=^|^A=1|B=2` into a dict."""
    flag = next(a for a in argv if a.startswith("--set-env-vars="))
    body = flag[len("--set-env-vars=") :]
    assert body.startswith("^|^"), f"unexpected delimiter syntax: {body[:16]}"
    out: dict[str, str] = {}
    for pair in body[3:].split("|"):
        key, _, value = pair.partition("=")
        out[key] = value
    return out


@pytest.fixture
def dev(tmp_path):
    return _env_vars(_run(tmp_path, _DEPLOY_ENV="dev", _BUILD_POD_IMAGE="true"))


@pytest.fixture
def prod(tmp_path):
    return _env_vars(_run(tmp_path, _DEPLOY_ENV="production"))


# -- the block that did not exist -------------------------------------------------


@pytest.mark.parametrize(
    ("name", "value"),
    [
        # The surface itself. Without it every personal-agent route 404s.
        ("PERSONAL_AGENT_ENABLED", "true"),
        ("PERSONAL_AGENT_BACKEND", "gcp"),
        # Separately revocable on purpose: enabling the surface and enabling
        # automatic creation of BILLABLE compute are different decisions.
        ("PERSONAL_AGENT_AUTOPROVISION_ENABLED", "true"),
        # The difference between rendering a config and creating a service.
        ("HUSSH_GCP_BACKEND_LIVE", "true"),
        # A pod-ONLY key. Never the hub's -- with HMAC, verify implies forge.
        ("HUSSH_POD_SIGNING_KEY_SECRET", "HUSSH_POD_DEV_SIGNING_KEY"),
        # The pod actually runs Agent One.
        ("HUSSH_POD_TURN_ENABLED", "true"),
    ],
)
def test_dev_carries_the_personal_agent_block(dev, name, value):
    assert dev.get(name) == value


def test_the_hub_is_the_only_member_that_may_invoke_a_pod(dev):
    """Non-targetability is the pod's security property. This names ONE caller, and
    `set_invoker_binding` independently refuses allUsers/allAuthenticatedUsers."""
    assert dev["HUSSH_POD_INVOKER_MEMBER"] == f"serviceAccount:{RUNTIME_SA}"


def test_the_invoker_member_is_never_a_bare_prefix(tmp_path):
    """An empty substitution would render the literal "serviceAccount:" -- non-empty
    enough to be SET, malformed enough to fail every setIamPolicy at provision time,
    in the one path nobody exercises locally. The script requires the SA anyway, so
    the guard is belt-and-braces; assert the shape rather than trusting that."""
    dev = _env_vars(_run(tmp_path, _DEPLOY_ENV="dev"))
    assert dev["HUSSH_POD_INVOKER_MEMBER"] != "serviceAccount:"
    assert dev["HUSSH_POD_INVOKER_MEMBER"].endswith(".iam.gserviceaccount.com")


@pytest.mark.parametrize(
    "name",
    [
        "PERSONAL_AGENT_ENABLED",
        "PERSONAL_AGENT_BACKEND",
        "PERSONAL_AGENT_AUTOPROVISION_ENABLED",
        "HUSSH_GCP_BACKEND_LIVE",
        "HUSSH_POD_SIGNING_KEY_SECRET",
        "HUSSH_POD_INVOKER_MEMBER",
        "HUSSH_POD_TURN_ENABLED",
    ],
)
def test_production_carries_none_of_it(prod, name):
    """Dev holds synthetic users. Every one of these is unset outside dev BY
    CONSTRUCTION -- empty value, append_optional_env skips, default applies -- so
    landing this file cannot change uat or production behaviour by one byte."""
    assert name not in prod


# -- the audience, and why there is no second variable for it ---------------------


def test_the_hub_learns_its_own_url_on_dev(dev):
    """A pod mints its ID token audience-bound to this exact string."""
    assert dev["HUSSH_HUB_BASE_URL"] == HUB_URL


def test_no_separate_audience_variable_is_ever_set(dev, prod):
    """POD_HUB_EXPECTED_AUDIENCE falls back to HUSSH_HUB_BASE_URL in runtime_settings.

    Two independently-configured copies of one address is a silent divergence: change
    the hub URL, forget the audience, and every pod->hub call 401s with nothing in
    either log saying why. One variable makes that unrepresentable."""
    assert "POD_HUB_EXPECTED_AUDIENCE" not in dev
    assert "POD_HUB_EXPECTED_AUDIENCE" not in prod


def test_the_expected_audience_matches_what_a_pod_actually_mints(dev):
    """The two halves of the check, resolved through the real functions rather than
    compared as strings here. `hub_base_url` is what the pod sends as `aud`;
    `pod_hub_expected_audience` is what the hub demands. They must agree."""
    from hushh_mcp.runtime_settings import pod_hub_expected_audience
    from hushh_mcp.services.pod_hub_client import hub_base_url

    previous = os.environ.get("HUSSH_HUB_BASE_URL")
    os.environ["HUSSH_HUB_BASE_URL"] = dev["HUSSH_HUB_BASE_URL"]
    try:
        assert pod_hub_expected_audience() == hub_base_url()
    finally:
        if previous is None:
            os.environ.pop("HUSSH_HUB_BASE_URL", None)
        else:
            os.environ["HUSSH_HUB_BASE_URL"] = previous


# -- G5: the background task that outlives its request ----------------------------


def test_dev_allocates_cpu_outside_requests(tmp_path):
    """Personal-agent provisioning is `loop.create_task` around a `wait_ready` poll
    that runs up to 150s AFTER the response returned. Cloud Run's default throttles
    CPU to near zero between requests, so that task does not run slowly -- it barely
    runs, the row strands at `provisioning`, and nothing reports a fault."""
    assert "--no-cpu-throttling" in _run(tmp_path, _DEPLOY_ENV="dev")


def test_the_other_lanes_keep_request_based_billing(tmp_path):
    """This flag switches Cloud Run to instance-based billing. On the shared lanes
    that is a cost decision needing founder sign-off, not a silent default -- even
    though the same exposure applies there to the consent listener, the Gmail watch
    renewal loop and the revocation sweep."""
    assert "--no-cpu-throttling" not in _run(tmp_path, _DEPLOY_ENV="production")


def test_retired_revisions_still_do_not_pin_database_pools(dev, tmp_path):
    """CPU allocation and revision min-instances are different levers, and only the
    first one was the fix. Revision min stays 0 so no-traffic revisions release their
    warm pools; the SERVICE-level min keeps the serving revision warm."""
    argv = _run(tmp_path, _DEPLOY_ENV="dev")
    assert "--min-instances=0" in argv
