"""A pod capability cannot ship wired to nothing, and the guard proves it by
parsing reality, not by trusting a hand-maintained list.

This is the generalisation of ``test_pod_status_vocabulary_is_one_vocabulary`` to
the whole capability surface. The defect class it kills, eight times observed this
workstream: a mechanism built, correct, and tested, that reaches nothing on the
live serving path because one of three files disagreed with the others --
``scripts/deploy/backend-deploy.sh`` (emits into the hub env),
``gcp_backend.render_deploy_config`` (renders the per-pod env), and the runtime
reader. Nothing joined them, so a broken link shipped green.

Every assertion here derives its facts from those real files -- parsing the deploy
script's emit set, parsing and EXECUTING the backend's render, executing the deploy
block -- and cross-checks them against the intent declared once in
``pod_capability_registry``. The registry supplies only what code cannot: which
lane a capability should be on in, and whether it is pod-read or hub-read.

The load-bearing catch: a flag ``gcp_backend`` renders into the pod from a hub
variable that no deploy lane sets renders ``"false"`` on every pod forever, so the
capability 404s in every lane while looking enabled. ``HUSSH_POD_MIGRATION_ENABLED``
was exactly this, shipped this workstream. Assertion A is the one that catches it.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.gcp_backend import GcpBackend
from hushh_mcp.services.pod_capability_registry import POD_CAPABILITIES, by_env_var

_BACKEND = Path(__file__).resolve().parents[1]
_REPO = _BACKEND.parent
_DEPLOY = _REPO / "scripts" / "deploy" / "backend-deploy.sh"
_GCP_BACKEND = _BACKEND / "hushh_mcp" / "services" / "gcp_backend.py"
_SPEC = PodSpec(hushh_id="ha1x", phone_e164_hash="h" * 64, pod_pubkey="p" * 43)


# --------------------------------------------------------------------------- #
# Ground-truth extractors: parse the real files, do not transcribe them.
# --------------------------------------------------------------------------- #


def _deploy_emit_set() -> set[str]:
    """Every flag the deploy script writes into the hub env via append_optional_env."""
    text = _DEPLOY.read_text(encoding="utf-8")
    return set(re.findall(r'append_optional_env "([A-Z0-9_]+)"', text))


def _render_flag_set() -> set[str]:
    """Every flag gcp_backend RENDERS into the per-pod env by reading the hub env.

    Matched by the render pattern specifically -- ``"value": "true" if _flag("X")
    else "false"`` -- not any ``_flag(...)`` call, because the backend also reads
    flags for its own decisions (e.g. HUSSH_GCP_BACKEND_LIVE gates live vs
    dry-run) that never reach a pod. Those are not the defect class this catches.
    """
    text = _GCP_BACKEND.read_text(encoding="utf-8")
    return set(re.findall(r'"true" if _flag\("([A-Z0-9_]+)"\)', text))


def _rendered_pod_env(env_overrides: dict[str, str]) -> dict[str, str]:
    """Execute the real render for a spec, with the given hub env in place, and
    return the per-pod env as a name->value dict."""
    import os

    saved = {k: os.environ.get(k) for k in env_overrides}
    os.environ.update(env_overrides)
    try:
        config = GcpBackend(
            project="p", region="us-central1", image="img:1", live=False
        ).render_deploy_config(_SPEC)
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    env = config["spec"]["template"]["spec"]["containers"][0]["env"]
    return {e["name"]: str(e.get("value", "")) for e in env if "name" in e}


def _run_dev_block() -> dict[str, str]:
    """Execute the real dev block of the deploy script and return the env it emits.

    Reuses the execute-and-read pattern the deploy-contract tests use, but over the
    WHOLE append_optional_env block (start of the personal-agent locals through the
    last append line) rather than a truncated slice -- so late-appended flags like
    the signing alg and migration are inside assertion range.
    """
    script = _DEPLOY.read_text(encoding="utf-8")
    # From the FIRST pod-capability local through the env join, so every dev
    # sub-block that declares a capability is executed -- not just the
    # personal-agent block. POD_HUB_IDENTITY_AUTH_ENABLED lives in an earlier
    # sub-block, and slicing from the personal-agent block alone would miss it.
    start = script.index('pod_identity_auth=""')
    end_anchor = "env_var_string="
    slice_ = script[start : script.index(end_anchor)]
    slice_ = (
        slice_.replace("${_DEPLOY_ENV}", "dev")
        .replace("${_RUNTIME_SERVICE_ACCOUNT}", "runtime@example.iam.gserviceaccount.com")
        .replace("${PROJECT_ID}", "hushh-pda-test")
        .replace("${_GENAI_PROJECT_ID}", "hushh-pda-test")
    )
    preamble = (
        "env_vars=()\n"
        "gcloud() { return 1; }\n"
        "append_optional_env() {\n"
        '  local n="$1"; local v="$2"\n'
        '  if [[ -n "${v}" ]]; then env_vars+=("${n}=${v}"); fi\n'
        "}\n"
        "append_optional_secret() { :; }\n"
    )
    result = subprocess.run(  # noqa: S603 - fixed argv, no shell, test-local input
        ["bash", "-c", preamble + slice_ + '\nprintf "%s\\n" "${env_vars[@]}"'],  # noqa: S607
        text=True,
        capture_output=True,
        check=True,
    )
    return dict(line.split("=", 1) for line in result.stdout.splitlines() if line)


_TRUTHY = {"1", "true", "yes", "on"}


def _reader_exists(env_var: str) -> bool:
    """Is this flag read by any non-test runtime module? Parsed, not assumed."""
    for base in (_BACKEND / "hushh_mcp", _BACKEND / "api", _BACKEND / "pod_server.py"):
        target = [base] if base.is_file() else base.rglob("*.py")
        for path in target:
            if "/tests/" in str(path):
                continue
            body = path.read_text(encoding="utf-8", errors="ignore")
            if re.search(rf'(getenv|_clean_env|_flag)\(\s*"{re.escape(env_var)}"', body):
                return True
    return False


# --------------------------------------------------------------------------- #
# A. render ⟹ emit. The load-bearing assertion. Needs no registry.
# --------------------------------------------------------------------------- #


def test_every_pod_rendered_flag_is_emitted_by_the_deploy_script():
    """A flag gcp_backend renders into the pod by reading the hub env MUST be set
    by some deploy lane, or it renders "false" on every pod forever while the
    capability looks enabled. This is the HUSSH_POD_MIGRATION_ENABLED bug, and any
    future flag of the same shape."""
    rendered = _render_flag_set()
    emitted = _deploy_emit_set()
    unemitted = sorted(rendered - emitted)
    assert not unemitted, (
        "gcp_backend renders these flags into the pod from a hub variable that NO "
        f"deploy lane emits, so each renders 'false' on every pod forever: {unemitted}. "
        "Add an append_optional_env line (and a dev-block local) for each."
    )


# --------------------------------------------------------------------------- #
# B. closed loop: every rendered pod flag is declared.
# --------------------------------------------------------------------------- #


def test_every_pod_rendered_flag_is_declared_in_the_registry():
    """A new pod flag cannot escape the loop. If gcp_backend renders it, the
    registry must declare its intent, so the other assertions can check it."""
    registry = by_env_var()
    undeclared = sorted(f for f in _render_flag_set() if f not in registry)
    assert not undeclared, (
        f"these flags are rendered into the pod but declared in no registry row: {undeclared}. "
        "Add a PodCapability for each so its wiring intent is checked."
    )


# --------------------------------------------------------------------------- #
# C. every declared capability is actually read somewhere.
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("cap", POD_CAPABILITIES, ids=lambda c: c.env_var)
def test_every_declared_capability_has_a_runtime_reader(cap):
    """Declared-but-dead is impossible: a capability nothing reads is a row that
    lies about a mechanism existing."""
    assert _reader_exists(cap.env_var), (
        f"{cap.env_var} is declared in the registry but no runtime module reads it"
    )


# --------------------------------------------------------------------------- #
# D. dev-on ⟹ the dev lane actually emits it. Executed.
# --------------------------------------------------------------------------- #


def test_every_dev_on_capability_is_emitted_truthy_by_the_dev_lane():
    """The 'door off everywhere, ledger on nowhere' catcher. A capability the
    registry says is on in dev must actually be emitted truthy when the dev block
    runs."""
    emitted = _run_dev_block()
    missing = []
    for cap in POD_CAPABILITIES:
        if cap.dev_intent != "on":
            continue
        value = emitted.get(cap.env_var, "")
        if value.strip().lower() not in _TRUTHY:
            missing.append(f"{cap.env_var} (got {value!r}) -- {cap.why}")
    assert not missing, (
        "the dev lane does not emit these on-in-dev capabilities truthy:\n  " + "\n  ".join(missing)
    )


# --------------------------------------------------------------------------- #
# E. pod + dev-on ⟹ the render propagates it. Executed.
# --------------------------------------------------------------------------- #


def test_every_dev_on_pod_capability_is_rendered_true_into_the_pod():
    """The unguarded-render catcher (POD_LOCAL_PKM / POD_DURABLE_IDENTITY had this
    gap). With the hub env set, the per-pod render must carry the flag as 'true' --
    proving the render actually propagates it rather than dropping it."""
    pod_on = {c.env_var: "1" for c in POD_CAPABILITIES if c.locus == "pod" and c.dev_intent == "on"}
    rendered = _rendered_pod_env(pod_on)
    missing = []
    for cap in POD_CAPABILITIES:
        if cap.locus != "pod" or cap.dev_intent != "on":
            continue
        if rendered.get(cap.env_var, "").strip().lower() != "true":
            missing.append(f"{cap.env_var} (rendered {rendered.get(cap.env_var)!r})")
    assert not missing, (
        "the per-pod render does not carry these pod capabilities as 'true' even with "
        f"the hub env set -- the render is unwired for them: {missing}"
    )


# --------------------------------------------------------------------------- #
# F. parked ⟹ consistently absent. Flipping one on forces full wiring.
# --------------------------------------------------------------------------- #


def test_parked_capabilities_are_wired_nowhere():
    """A parked capability must be emitted by no lane and rendered into no pod, so
    it cannot half-ship. The day it is turned on, its row flips to 'on' and the
    other assertions force the emit and the render together."""
    emitted = _deploy_emit_set()
    rendered = _render_flag_set()
    half_wired = []
    for cap in POD_CAPABILITIES:
        if cap.dev_intent != "parked":
            continue
        if cap.env_var in emitted:
            half_wired.append(f"{cap.env_var} is emitted by a lane but declared parked")
        if cap.env_var in rendered:
            half_wired.append(f"{cap.env_var} is rendered into the pod but declared parked")
    assert not half_wired, "parked capabilities must be wired nowhere:\n  " + "\n  ".join(
        half_wired
    )
