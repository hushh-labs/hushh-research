# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Production runtime profiles and isolated backend build command fixtures."""

import os
import re
import subprocess
from pathlib import Path


def production_runtime_profile(workflow: str) -> str:
    step = workflow.split("- name: Sync canonical hosted runtime secrets", 1)[1].split(
        "\n      - name:", 1
    )[0]
    assert "run: bash deploy/drive/sync_runtime_config_prod.sh" in step
    root = Path(__file__).resolve().parents[3]
    profile = (root / "deploy/drive/sync_runtime_config_prod.sh").read_text(encoding="utf-8")
    assert (
        '"${PROTOCOL_PYTHON:?protocol runtime required}" '
        "scripts/ops/sync_backend_runtime_secrets.py"
    ) in profile
    return profile


def run_production_backend_build(
    deploy: str, *, drive_active: str, hosted_documents: str
) -> subprocess.CompletedProcess[str]:
    script = deploy.replace("${{ github.event.inputs.enable_one_email_kyc }}", "false")
    script = script.replace("${{ steps.drive-mode.outputs.active }}", drive_active)
    script = script.replace("${{ steps.document-mode.outputs.configured }}", hosted_documents)
    script = re.sub(r"\$\{\{.*?\}\}", "fixture", script)
    return subprocess.run(  # noqa: S603 - actual build command with cloud writes intercepted
        ["bash", "-c", "gcloud() { printf '%s\\n' \"$@\"; };\n" + script],
        env={
            **os.environ,
            "DRIVE_CANDIDATE_RUNTIME_SECRET": "fixture",
            "PHONE_DEPLOY_PHASE": "normal",
        },
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
