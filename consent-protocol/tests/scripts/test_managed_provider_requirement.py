"""A failed check of the required provider ends the build; other failures stay allowed.

The aggregate rejects a failed step for the configured provider
(test_complete_provider_gate_rejects_missing_or_misbound_capability_proof[failed_step]),
so exiting 1 early never fails a build the aggregate would have passed.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from tests.test_uat_deploy_no_traffic_contract import REPO_ROOT, _read

COPIED = (
    "scripts/ci/managed_provider_requirement.py",
    "scripts/ci/managed_provider_readiness.py",
    "consent-protocol/hushh_mcp/managed_ai_config.py",
)


def _finalizer(text: str) -> str:
    return text[
        text.index("finish_provider_probe() {") : text.index("trap finish_provider_probe EXIT")
    ]


def _azure_step() -> dict:
    steps = yaml.safe_load(_read("deploy/backend.cloudbuild.yaml"))["steps"]
    return next(step for step in steps if step["id"] == "verify-azure-pwm-runtime")


FINALIZERS = {
    "azure_openai": lambda: _finalizer(_azure_step()["args"][-1]),
    "vertex": lambda: _finalizer(_read("scripts/deploy/verify-managed-vertex-runtime.sh")),
}


def _finish(tmp_path: Path, provider, probe_status, environment, selection, *, broken=False):
    for relative in COPIED:
        (tmp_path / relative).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(REPO_ROOT / relative, tmp_path / relative)
    if broken:
        (tmp_path / COPIED[0]).write_text("raise SystemExit(2)\n")
    document = json.loads(_read("consent-protocol/config/managed-ai-runtime.json"))
    document["managed_provider_selection"]["uat"] = selection
    (tmp_path / "consent-protocol/config/managed-ai-runtime.json").parent.mkdir(exist_ok=True)
    (tmp_path / "consent-protocol/config/managed-ai-runtime.json").write_text(json.dumps(document))
    stubs = tmp_path / "bin"
    stubs.mkdir(exist_ok=True)
    (stubs / "gcloud").write_text("#!/bin/bash\necho unexpected >&2\nexit 9\n")
    (stubs / "gcloud").chmod(0o755)
    script = f"set -euo pipefail\n{FINALIZERS[provider]()}\ntrap finish_provider_probe EXIT\n"
    result = subprocess.run(  # noqa: S603 - production finalizers with stubbed tools.
        ["bash", "-c", script + f"exit {probe_status}\n"],
        cwd=tmp_path,
        env={
            "PATH": os.pathsep.join(
                [str(stubs), str(Path(sys.executable).parent), os.environ["PATH"]]
            ),
            "READINESS_ENVIRONMENT": environment,
            "_DEPLOY_ENV": environment,
        },
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert "unexpected" not in result.stderr
    return result.returncode


@pytest.mark.parametrize(
    "provider,probe_status,environment,selection,expected",
    [
        ("azure_openai", 0, "uat", "azure_openai", 0),
        ("azure_openai", 1, "uat", "azure_openai", 1),
        ("azure_openai", 1, "uat", "vertex", 3),
        ("azure_openai", 1, "dev", "azure_openai", 3),
        ("vertex", 0, "uat", "vertex", 0),
        ("vertex", 1, "uat", "vertex", 1),
        ("vertex", 1, "uat", "azure_openai", 0),
    ],
)
def test_only_the_required_provider_ends_the_build(
    tmp_path, provider, probe_status, environment, selection, expected
):
    assert _finish(tmp_path, provider, probe_status, environment, selection) == expected


def test_unknown_requirement_leaves_the_verdict_to_the_aggregate(tmp_path):
    assert _finish(tmp_path, "azure_openai", 1, "uat", "azure_openai", broken=True) == 3


def test_build_allows_only_the_diagnostic_exit():
    step = _azure_step()
    assert step.get("allowExitCodes") == [3]
    assert "allowFailure" not in step
