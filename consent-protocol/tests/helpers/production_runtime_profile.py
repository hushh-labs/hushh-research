# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Production runtime profiles and isolated backend build command fixtures."""

import os
import re
import subprocess
import tempfile
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
    deploy: str, *, drive_active: str, hosted_documents: str, restoration_run: str = ""
) -> subprocess.CompletedProcess[str]:
    script = deploy.replace("${{ github.event.inputs.enable_one_email_kyc }}", "false")
    script = script.replace("${{ steps.drive-mode.outputs.active }}", drive_active)
    script = script.replace("${{ steps.document-mode.outputs.configured }}", hosted_documents)
    script = script.replace("${{ inputs.restoration_validation_run }}", restoration_run)
    script = re.sub(r"\$\{\{.*?\}\}", "fixture", script)
    root = Path(__file__).resolve().parents[3]
    with tempfile.TemporaryDirectory() as folder:
        temporary = Path(folder)
        cloud = temporary / "gcloud"
        cloud.write_text(
            '#!/bin/bash\nset -euo pipefail\nprintf "%s\\n" "$@" >> "$BUILD_CALLS"\n'
            'case "$1 $2" in\n'
            '"builds submit") echo 11111111-1111-4111-8111-111111111111 ;;\n'
            '"builds describe") echo SUCCESS ;;\n'
            "*) exit 99 ;;\nesac\n"
        )
        cloud.chmod(0o755)
        tools = temporary / "release-tools"
        tools.mkdir()
        (tools / "await-prebuilt-image.sh").write_text(
            (root / "scripts/ci/await-prebuilt-image.sh").read_text()
        )
        calls = temporary / "calls"
        result = subprocess.run(  # noqa: S603 - actual build and waiter, cloud calls intercepted
            ["bash", "-c", script],
            cwd=root,
            env={
                **os.environ,
                "PATH": str(temporary) + os.pathsep + os.environ["PATH"],
                "BUILD_CALLS": str(calls),
                "GITHUB_OUTPUT": str(temporary / "outputs"),
                "RUNNER_TEMP": str(temporary),
                "DRIVE_CANDIDATE_RUNTIME_SECRET": "fixture",
                "PHONE_DEPLOY_PHASE": "normal",
            },
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        )
        # Existing callers inspect the actual build arguments, including those
        # captured by asynchronous submission rather than printed to stdout.
        return subprocess.CompletedProcess(
            result.args, result.returncode, calls.read_text(), result.stderr
        )
