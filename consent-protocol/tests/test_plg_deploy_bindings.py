"""An empty provisioning container must never become a broken runtime mount."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

HELPER = Path(__file__).resolve().parents[2] / "deploy/plg/bind_secrets.sh"


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
add_secret() { printf '%s:%s\n' "$1" "$2"; }
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
source "$1" "$2" test-project
"""
    result = subprocess.run(  # noqa: S603 -- fixed helper and synthetic CLI, no cloud access
        [bash, "-c", script, "plg-bindings", HELPER.as_posix(), profile],
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
        bindings += ["ONE_PLG_EXPORT_SECRET:ONE_PLG_EXPORT_SECRET"]
        if state == "ENABLED":
            bindings += ["ONE_PLG_EXPORT_ACCOUNT_IDS:ONE_PLG_EXPORT_ACCOUNT_IDS"]
        if subscription == "ENABLED":
            bindings += ["ONE_PLG_SUBSCRIPTION_SECRET:ONE_PLG_SUBSCRIPTION_SECRET"]
    if profile == "production" and audience == "ENABLED":
        bindings += ["ONE_PLG_AUDIENCE_SECRET:ONE_PLG_AUDIENCE_SECRET"]
    if profile == "production" and policy == "ENABLED":
        bindings += ["ONE_PLG_REPORTING_POLICY_JSON:ONE_PLG_REPORTING_POLICY_JSON"]
    assert result.stdout.splitlines() == bindings
