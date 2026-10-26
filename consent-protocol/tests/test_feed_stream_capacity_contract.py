"""Shared-backend Feed capacity and ordinary API/Voice headroom contracts."""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import pytest
import yaml

from tests._deploy_contract import backend_deploy_script as _backend_deploy
from tests._deploy_contract import managed_vertex_probe_surface

REPO_ROOT = Path(__file__).resolve().parents[2]


def _read(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def test_uat_runtime_capacity_is_bounded_and_revision_safe() -> None:
    workflow = _read(".github/workflows/deploy-uat.yml")
    backend_build = managed_vertex_probe_surface()
    backend_deploy = _backend_deploy()
    frontend_build = _read("deploy/frontend.cloudbuild.yaml")

    assert '"--cpu=${_CLOUD_RUN_CPU}"' in backend_deploy
    assert '"--concurrency=${_CLOUD_RUN_CONCURRENCY}"' in backend_deploy
    assert '"--memory=${_CLOUD_RUN_MEMORY}"' in backend_deploy
    assert '"_CLOUD_RUN_MEMORY=${_CLOUD_RUN_MEMORY}"' in backend_build
    assert "_CLOUD_RUN_CPU=2" in workflow
    assert "_CLOUD_RUN_CONCURRENCY=20" in workflow
    # Quiet, long-lived Feed requests can fill a worker before the default
    # 60%-of-20 scale target. Keep shared API/Voice headroom while scaling earlier.
    assert "_CLOUD_RUN_SCALING_CONCURRENCY_TARGET=0.20" in workflow
    from api.routes.document_feed_stream import MAX_STREAMS_PER_WORKER

    assert 20 * 0.20 < MAX_STREAMS_PER_WORKER

    assert '"--memory=${_CLOUD_RUN_MEMORY}"' in frontend_build
    assert '"--concurrency=${_CLOUD_RUN_CONCURRENCY}"' in frontend_build
    assert '"--max=${_CLOUD_RUN_MAX_INSTANCES}"' in frontend_build
    assert '"--min=${_CLOUD_RUN_MIN_INSTANCES}"' in frontend_build
    assert '"--min-instances=0"' in frontend_build
    assert "_CLOUD_RUN_MEMORY=1Gi" in workflow
    assert "_CLOUD_RUN_TIMEOUT_SECONDS=300" in workflow
    assert "_CLOUD_RUN_CONCURRENCY=10" in workflow
    assert "_CLOUD_RUN_MIN_INSTANCES=2" in workflow
    assert "_CLOUD_RUN_MAX_INSTANCES=10" in workflow


@pytest.mark.parametrize("target", ["", "0.20"])
def test_backend_scaling_target_reaches_real_deploy_command_without_cutting_headroom(
    target: str,
) -> None:
    config = yaml.safe_load(_read("deploy/backend.cloudbuild.yaml"))
    step = next(s for s in config["steps"] if s.get("id") == "deploy-backend")
    body = _backend_deploy()
    packed = next(e for e in step["env"] if e.startswith("_CLOUD_RUN_CAPACITY="))
    assert "scaling_target=${_CLOUD_RUN_SCALING_CONCURRENCY_TARGET}" in packed
    assert config["substitutions"]["_CLOUD_RUN_SCALING_CONCURRENCY_TARGET"] == ""
    values = {
        **config["substitutions"],
        "_CLOUD_RUN_CONCURRENCY": "20",
        "_CLOUD_RUN_SCALING_CONCURRENCY_TARGET": target,
        "_CLOUD_RUN_MAX_INSTANCES": "5",
        "_CLOUD_RUN_MIN_INSTANCES": "2",
    }
    # Execute the authored command construction with synthetic values; no cloud
    # commands, secrets, providers, application requests, or live mutation.
    assert "source scripts/deploy/backend-capacity-settings.sh" in body
    command = body[body.index('image_reference="${_IMAGE_REFERENCE}"') :]
    packed = re.sub(r"\$\{(_[A-Z0-9_]+)\}", lambda m: str(values[m[1]]), packed)
    result = subprocess.run(  # noqa: S603 - repository command construction, fake gcloud only.
        [
            "bash",
            "-c",
            "set -euo pipefail\nPROJECT_ID=test\ndeploy_labels=test\nenv_var_string=test\nsecrets=test\n"
            "source scripts/deploy/backend-capacity-settings.sh\n"
            "source scripts/deploy/backend-phone-rollback.sh\n"
            'gcloud() { printf "%s\\n" "$@"; }\n' + command,
        ],
        cwd=REPO_ROOT,
        env={
            **os.environ,
            **{key: str(value) for key, value in values.items()},
            "_CLOUD_RUN_CAPACITY": packed.split("=", 1)[1],
            "_CLOUD_RUN_CONCURRENCY": "80",
            "_CLOUD_RUN_SCALING_CONCURRENCY_TARGET": "",
        },
        capture_output=True,
        text=True,
        check=True,
        timeout=5,
    )
    args = result.stdout.splitlines()
    assert "--concurrency=20" in args
    assert "--max=5" in args and "--min=2" in args
    assert "--no-cpu-throttling" in args
    assert [a for a in args if a.startswith("--scaling-concurrency-target=")] == (
        [f"--scaling-concurrency-target={target}"] if target else []
    )


@pytest.mark.parametrize(
    "target,valid",
    [
        ("", True),
        ("0.1", True),
        ("0.20", True),
        ("0.95", True),
        ("20", False),
        ("disabled", False),
        ("0.96", False),
        ("0.099", False),
    ],
)
def test_backend_scaling_target_validation_cannot_disable_or_overrun_scaling(
    target: str,
    valid: bool,
) -> None:
    validation = _read("scripts/deploy/backend-capacity-settings.sh")
    result = subprocess.run(  # noqa: S603 - exact authored validation, no cloud calls.
        ["bash", "-c", "set -euo pipefail\n" + validation],
        env={
            **os.environ,
            "_CLOUD_RUN_SCALING_CONCURRENCY_TARGET": target,
            "_CLOUD_RUN_CAPACITY": "",
        },
        capture_output=True,
        text=True,
        check=False,
        timeout=5,
    )
    assert (result.returncode == 0) is valid


def test_backend_capacity_keeps_shared_limits_and_reviewed_environment_memory() -> None:
    """Production OOM-killed live chat turns; throttled CPU stalled first turns."""
    production_workflow = _read(".github/workflows/deploy-production.yml")
    uat_workflow = _read(".github/workflows/deploy-uat.yml")

    backend_build = managed_vertex_probe_surface()
    # The Cloud Build wrapper delegates deployment to the canonical script.
    assert "scripts/deploy/backend-deploy.sh" in backend_build
    backend_deploy = _read("scripts/deploy/backend-deploy.sh")
    command = backend_deploy.split("cmd=(", 1)[1].split("\n)", 1)[0]
    # Background warmups need CPU outside requests on every shared lane.
    assert '"--no-cpu-throttling"' in command

    for setting in (
        "_CLOUD_RUN_CPU=2",
        "_CLOUD_RUN_CONCURRENCY=20",
    ):
        assert setting in uat_workflow
        assert setting in production_workflow

    # The measured UAT working set exceeded the 80% memory gate on 4Gi.
    # Its isolated 6Gi trial must not change production before its own acceptance.
    assert "_CLOUD_RUN_MEMORY=6Gi" in uat_workflow
    assert "_CLOUD_RUN_MEMORY=4Gi" in production_workflow


def test_capacity_knobs_travel_packed_and_unpack_to_the_same_names() -> None:
    config = yaml.safe_load(_read("deploy/backend.cloudbuild.yaml"))
    step = next(s for s in config["steps"] if s.get("id") == "deploy-backend")
    packed = [e for e in step.get("env") or [] if e.startswith("_CLOUD_RUN_CAPACITY=")]
    assert len(packed) == 1, "the capacity knobs must travel as exactly one packed entry"
    for key in (
        "max=${_CLOUD_RUN_MAX_INSTANCES}",
        "cpu=${_CLOUD_RUN_CPU}",
        "no_traffic=${_CLOUD_RUN_NO_TRAFFIC}",
    ):
        assert key in packed[0]
    assert not any(e.startswith("_CLOUD_RUN_CPU=") for e in step.get("env") or [])
    script = (REPO_ROOT / "scripts/deploy/backend-capacity-settings.sh").read_text(encoding="utf-8")
    assert 'cpu) _CLOUD_RUN_CPU="${_value}" ;;' in script
    assert '"--cpu=${_CLOUD_RUN_CPU}"' in _backend_deploy()
