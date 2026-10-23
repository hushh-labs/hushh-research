"""PLG build projections and secret bindings retain their closed contracts."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "deploy/plg/bind_secrets.sh"
BACKEND_SECRET_PORT = ROOT / "scripts/deploy/commerce-preview-bindings.sh"


@pytest.mark.parametrize(
    ("profile", "state", "audience", "policy", "expected"),
    [
        ("production", "ENABLED", "DISABLED", "DISABLED", 2),
        ("production", "DISABLED", "DISABLED", "DISABLED", 1),
        ("production", "", "DISABLED", "DISABLED", 1),
        ("production", "error", "DISABLED", "DISABLED", 1),
        ("production", "DISABLED", "ENABLED", "DISABLED", 2),
        ("production", "ENABLED", "ENABLED", "DISABLED", 3),
        ("production", "DISABLED", "ENABLED", "ENABLED", 3),
        ("production", "ENABLED", "ENABLED", "ENABLED", 4),
        ("production", "ENABLED", "ENABLED", "error", 3),
        ("uat", "ENABLED", "ENABLED", "ENABLED", 0),
        ("dev", "ENABLED", "ENABLED", "ENABLED", 0),
    ],
)
@pytest.mark.parametrize("subscription", ["ENABLED", "DISABLED"])
def test_binding_requires_enabled_versions_in_production(
    profile, state, audience, policy, expected, subscription
):
    bash = shutil.which("bash")
    if os.name == "nt":
        candidate = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe"
        bash = str(candidate) if candidate.is_file() else None
    if not bash:
        pytest.skip("Bash is required for the production deploy helper")
    script = r"""
set -euo pipefail
PROJECT_ID=test-project
_SECRET_PREFIX=''
secrets=''
gcloud() {
  [[ "$*" == *'--project=test-project'* ]] || return 17
  if [[ "$*" == *'--secret=ONE_PLG_EXPORT_ACCOUNT_IDS'* ]]; then
    [[ "$PLG_TEST_SECOND_STATE" != error ]] || return 1
    printf '%s\n' "$PLG_TEST_SECOND_STATE"
  elif [[ "$*" == *'--secret=ONE_PLG_AUDIENCE_SECRET'* ]]; then
    printf '%s\n' "$PLG_TEST_AUDIENCE_STATE"
  elif [[ "$*" == *'--secret=ONE_PLG_REPORTING_POLICY_JSON'* ]]; then
    [[ "$PLG_TEST_POLICY_STATE" != error ]] || return 1
    printf '%s\n' "$PLG_TEST_POLICY_STATE"
  elif [[ "$*" == *'--secret=ONE_PLG_SUBSCRIPTION_SECRET'* ]]; then
    printf '%s\n' "$PLG_TEST_SUBSCRIPTION_STATE"
  else
    printf '%s\n' ENABLED
  fi
}
source "$3"
source "$1" "$2" test-project
IFS=',' read -r -a bindings <<< "$secrets"
for binding in "${bindings[@]}"; do
  [[ -z "$binding" ]] || printf '%s\n' "$binding"
done
"""
    result = subprocess.run(  # noqa: S603 -- fixed helper and synthetic CLI, no cloud access
        [
            bash,
            "-c",
            script,
            "plg-bindings",
            HELPER.as_posix(),
            profile,
            BACKEND_SECRET_PORT.as_posix(),
        ],
        env={
            **os.environ,
            "PLG_TEST_SECOND_STATE": state,
            "PLG_TEST_AUDIENCE_STATE": audience,
            "PLG_TEST_POLICY_STATE": policy,
            "PLG_TEST_SUBSCRIPTION_STATE": subscription,
        },
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )
    assert len(result.stdout.splitlines()) == expected + int(
        profile == "production" and subscription == "ENABLED"
    )
    bindings = []
    if profile == "production":
        bindings += ["ONE_PLG_EXPORT_SECRET=ONE_PLG_EXPORT_SECRET:latest"]
        if state == "ENABLED":
            bindings += ["ONE_PLG_EXPORT_ACCOUNT_IDS=ONE_PLG_EXPORT_ACCOUNT_IDS:latest"]
        if subscription == "ENABLED":
            bindings += ["ONE_PLG_SUBSCRIPTION_SECRET=ONE_PLG_SUBSCRIPTION_SECRET:latest"]
    if profile == "production" and audience == "ENABLED":
        bindings += ["ONE_PLG_AUDIENCE_SECRET=ONE_PLG_AUDIENCE_SECRET:latest"]
    if profile == "production" and policy == "ENABLED":
        bindings += ["ONE_PLG_REPORTING_POLICY_JSON=ONE_PLG_REPORTING_POLICY_JSON:latest"]
    assert result.stdout.splitlines() == bindings


def test_observation_projection_follows_split_literals_and_rejects_expressions():
    import runpy

    root = HELPER.parents[2]
    generator = runpy.run_path(
        str(root / "consent-protocol/scripts/generate_plg_observation_contract.py")
    )
    source = generator["SOURCE"].read_text()
    actions = generator["ACTIONS"].read_text()
    compile_contract = generator["compile_contract"]
    contract = compile_contract(source, actions_source=actions)
    assert "export_saved" in contract["events"]["one_memory_action"]
    changed = compile_contract(
        source, actions_source=actions.replace('"export_saved"', '"export_changed"')
    )
    assert "export_changed" in changed["events"]["one_memory_action"]
    assert changed["sourceDigest"] != contract["sourceDigest"]
    with pytest.raises(ValueError, match="literal enums"):
        compile_contract(source, actions_source=actions.replace('"export_saved"', "runtimeValue()"))
