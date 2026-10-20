"""An empty provisioning container must never become a broken runtime mount."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

HELPER = Path(__file__).resolve().parents[2] / "deploy/plg/bind_secrets.sh"


@pytest.mark.parametrize(
    ("profile", "state", "expected"),
    [
        ("production", "ENABLED", 2),
        ("production", "DISABLED", 0),
        ("production", "", 0),
        ("production", "error", 0),
        ("uat", "ENABLED", 0),
        ("dev", "ENABLED", 0),
    ],
)
def test_binding_pair_requires_enabled_versions_in_production(profile, state, expected):
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
  else
    printf '%s\n' ENABLED
  fi
}
source "$1" "$2" test-project
"""
    result = subprocess.run(  # noqa: S603 -- fixed helper and synthetic CLI, no cloud access
        [bash, "-c", script, "plg-bindings", HELPER.as_posix(), profile],
        env={**os.environ, "PLG_TEST_SECOND_STATE": state},
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )
    assert len(result.stdout.splitlines()) == expected
    if expected:
        assert result.stdout.splitlines() == [
            "ONE_PLG_EXPORT_SECRET:ONE_PLG_EXPORT_SECRET",
            "ONE_PLG_EXPORT_ACCOUNT_IDS:ONE_PLG_EXPORT_ACCOUNT_IDS",
        ]
