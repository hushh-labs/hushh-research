"""Native callback request logs must never retain OAuth/Pickers query data."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "deploy" / "drive" / "setup_native_callback_log_exclusion.sh"


def _run_guard(*args: str, **overrides: str) -> subprocess.CompletedProcess[str]:
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
        ["/bin/bash", str(SCRIPT), *args],
        env=environment,
        capture_output=True,
        check=False,
        text=True,
    )


def test_callback_log_guard_excludes_only_fixed_callback_request_logs() -> None:
    source = SCRIPT.read_text(encoding="utf-8")

    assert 'readonly UAT_PROJECT_ID="hushh-pda-uat"' in source
    assert 'readonly PROD_PROJECT_ID="hushh-pda"' in source
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


def test_callback_log_guard_refuses_unrelated_or_broader_targets_before_gcloud() -> None:
    wrong_project = _run_guard(PROJECT_ID="hushh-pda-dev")
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


def test_production_guard_is_idempotent_and_verification_cannot_mutate(tmp_path) -> None:
    """Execute the actual shell against a synthetic metadata-only Logging API."""
    executables = tmp_path / "bin"
    executables.mkdir()
    state = tmp_path / "state.json"
    calls = tmp_path / "calls.txt"
    (executables / "gcloud").write_text("#!/bin/sh\nprintf synthetic-token")
    (executables / "curl").write_text(
        f"#!{sys.executable}\n"
        + """
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
method = args[args.index('--request') + 1]
output = Path(args[args.index('--output') + 1])
state = Path(os.environ['GUARD_STATE'])
calls = Path(os.environ['GUARD_CALLS'])
with calls.open('a') as stream: stream.write(method + '\\n')
if method == 'GET' and not state.exists():
    output.write_text('{}'); print('404', end='')
else:
    if method in ('PATCH', 'POST'):
        body = json.loads(args[args.index('--data') + 1])
        state.write_text(json.dumps(body))
    output.write_text(state.read_text()); print('200', end='')
"""
    )
    for executable in executables.iterdir():
        executable.chmod(0o755)
    environment = {
        "PROJECT_ID": "hushh-pda",
        "PATH": f"{executables}:{os.environ['PATH']}",
        "GUARD_STATE": str(state),
        "GUARD_CALLS": str(calls),
    }
    missing = _run_guard("--verify-only", **environment)
    assert missing.returncode != 0
    assert calls.read_text().splitlines() == ["GET"]
    for _ in range(2):
        assert _run_guard(**environment).returncode == 0
    payload = json.loads(state.read_text())
    assert 'service_name="consent-protocol"' in payload["filter"]
    assert 'service_name="hushh-webapp"' in payload["filter"]
    assert "/one/profile/connectors/oauth/return" in payload["filter"]
    assert "request.summary" not in payload["filter"]
    prior = calls.read_text()
    assert _run_guard("--verify-only", **environment).returncode == 0
    assert calls.read_text() == prior + "GET\n"
    payload["disabled"] = True
    state.write_text(json.dumps(payload))
    prior = calls.read_text()
    assert _run_guard("--verify-only", **environment).returncode != 0
    assert calls.read_text() == prior + "GET\n"
