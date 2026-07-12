"""Regression test for ADK/A2A compliance verifier."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def test_verify_adk_a2a_compliance_script_passes():
    root = Path(__file__).resolve().parents[1]
    script = root / "scripts" / "verify_adk_a2a_compliance.py"
    result = subprocess.run(  # noqa: S603 - Local test executes repository-owned verifier script.
        [sys.executable, str(script)],
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    payload = json.loads(result.stdout)
    assert payload["ok"] is True
    assert payload["meaning"] == "preview_containment_and_adk_contracts_only"
    assert payload["official_a2a_v1"] == {
        "ready": False,
        "release_blocker": "ADK_A2A_SDK_VERSION_INCOMPATIBLE",
        "pinned_google_adk": "2.4.0",
        "adk_supported_a2a_sdk": ">=0.3.4,<0.4",
        "required_a2a_v1_sdk": "1.1.0",
        "preview_endpoint_is_official_a2a": False,
    }
