"""An empty provisioning container must never become a broken runtime mount."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

HELPER = Path(__file__).resolve().parents[2] / "deploy/plg/bind_secrets.sh"


@pytest.mark.parametrize(
    ("profile", "state", "audience", "expected"),
    [
        ("production", "ENABLED", "DISABLED", 2),
        ("production", "DISABLED", "DISABLED", 0),
        ("production", "", "DISABLED", 0),
        ("production", "error", "DISABLED", 0),
        ("production", "DISABLED", "ENABLED", 1),
        ("production", "ENABLED", "ENABLED", 3),
        ("uat", "ENABLED", "ENABLED", 0),
        ("dev", "ENABLED", "ENABLED", 0),
    ],
)
def test_binding_pair_requires_enabled_versions_in_production(profile, state, audience, expected):
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
  else
    printf '%s\n' ENABLED
  fi
}
source "$1" "$2" test-project
"""
    result = subprocess.run(  # noqa: S603 -- fixed helper and synthetic CLI, no cloud access
        [bash, "-c", script, "plg-bindings", HELPER.as_posix(), profile],
        env={**os.environ, "PLG_TEST_SECOND_STATE": state, "PLG_TEST_AUDIENCE_STATE": audience},
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )
    assert len(result.stdout.splitlines()) == expected
    bindings = []
    if profile == "production" and state == "ENABLED":
        bindings += [
            "ONE_PLG_EXPORT_SECRET:ONE_PLG_EXPORT_SECRET",
            "ONE_PLG_EXPORT_ACCOUNT_IDS:ONE_PLG_EXPORT_ACCOUNT_IDS",
        ]
    if profile == "production" and audience == "ENABLED":
        bindings += ["ONE_PLG_AUDIENCE_SECRET:ONE_PLG_AUDIENCE_SECRET"]
    assert result.stdout.splitlines() == bindings
