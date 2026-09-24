"""Native callback request logs must never retain OAuth/Pickers query data."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "deploy" / "drive" / "setup_native_callback_log_exclusion.sh"


def _run_guard(**overrides: str) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    environment.update(
        {
            "PROJECT_ID": "hushh-pda-uat",
            "BACKEND_SERVICE": "consent-protocol",
            "EXCLUSION_NAME": "drive-native-callback-query-material",
            **overrides,
        }
    )
    return subprocess.run(  # noqa: S603 - fixed repository-owned shell helper
        ["bash", str(SCRIPT)],
        env=environment,
        capture_output=True,
        check=False,
        text=True,
    )


def test_callback_log_guard_is_uat_only_and_excludes_exact_native_paths() -> None:
    source = SCRIPT.read_text(encoding="utf-8")

    assert 'readonly UAT_PROJECT_ID="hushh-pda-uat"' in source
    assert 'readonly UAT_BACKEND_SERVICE="consent-protocol"' in source
    assert 'readonly UAT_EXCLUSION_NAME="drive-native-callback-query-material"' in source
    assert 'resource.type=\\"cloud_run_revision\\"' in source
    assert "logs/run.googleapis.com%2Frequests" in source
    assert "oauth/native/callback|google_drive/picker/native/callback" in source
    assert 'BASE_URL="https://logging.googleapis.com/v2"' in source
    assert '"${BASE_URL}/${RESOURCE}?updateMask=filter%2Cdescription%2Cdisabled"' in source
    assert '"${BASE_URL}/projects/${PROJECT_ID}/exclusions"' in source
    assert "call_logging PATCH" in source
    assert "call_logging POST" in source
    assert '"disabled": False' in source
    assert 'payload.get("disabled", False) is not False' in source
    assert "sinks" not in source
    assert "add-iam-policy-binding" not in source
    assert "run services" not in source


def test_callback_log_guard_refuses_non_uat_or_broader_targets_before_gcloud() -> None:
    wrong_project = _run_guard(PROJECT_ID="hushh-pda")
    wrong_service = _run_guard(BACKEND_SERVICE="hushh-webapp")
    wrong_name = _run_guard(EXCLUSION_NAME="all-request-logs")

    for result, message in (
        (wrong_project, "limited to hushh-pda-uat"),
        (wrong_service, "limited to consent-protocol"),
        (wrong_name, "only manages drive-native-callback-query-material"),
    ):
        assert result.returncode != 0
        assert message in result.stderr
        assert "gcloud is required" not in result.stderr
