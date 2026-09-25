"""Candidate health must prove the candidate, never a redirect to live traffic."""

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize("code,expected", [("200", 0), ("302", 1), ("503", 1)])
def test_candidate_http_gate_does_not_accept_redirects(tmp_path, code, expected):
    commands = tmp_path / "commands"
    for name, body in {
        "gcloud": 'echo "$*" >> "$COMMANDS"\n',
        "curl": 'echo "$*" >> "$COMMANDS"\nprintf "%s" "$HTTP_CODE"\n',
        "sleep": "exit 0\n",
        "python-gate": 'if [ "$1" = "-c" ]; then echo https://candidate.run.app; fi\n',
    }.items():
        path = tmp_path / name
        path.write_text("#!/bin/sh\n" + body)
        path.chmod(0o755)
    env = {
        **os.environ,
        "PATH": str(tmp_path) + ":" + os.environ["PATH"],
        "PROTOCOL_PYTHON": str(tmp_path / "python-gate"),
        "HTTP_CODE": code,
        "COMMANDS": str(commands),
    }
    run = subprocess.run(  # noqa: S603 - fixed script with isolated fake executables.
        [
            "bash",
            str(ROOT / "scripts/ci/verify-dev-candidate.sh"),
            "project",
            "region",
            "service",
            "revision",
            "registry/image@sha256:" + "a" * 64,
            "a" * 40,
            "99",
            "dev-candidate-99",
            "/health",
        ],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
    )
    assert run.returncode == expected
    calls = commands.read_text()
    assert "--update-tags=dev-candidate-99=revision" in calls
    assert "--to-" not in calls
    assert "--location" not in calls and " -L" not in calls
    assert calls.count("https://candidate.run.app/health") == (1 if expected == 0 else 5)


def test_dev_builds_immutable_candidate_before_migration_and_probes_before_promotion():
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-dev.yml").read_text())
    steps = workflow["jobs"]["deploy"]["steps"]
    names = [step["name"] for step in steps]
    assert names.index("Build and pin backend image before lifecycle migration") < names.index(
        "Apply dev DB migrations and predeploy schema gate"
    )
    assert names.index("Verify selected candidates before traffic promotion") < names.index(
        "Promote deployed revisions to dev traffic"
    )
    gate = next(step for step in steps if step.get("id") == "verify-candidates")
    assert "continue-on-error" not in gate
    assert "steps.scope.outputs.deploy_backend" in gate["run"]
    assert "steps.scope.outputs.deploy_frontend" in gate["run"]
    assert "/health" in gate["run"] and "/login" in gate["run"]
    for step in steps:
        if step.get("id") in {"verify-parity-1", "verify-parity-2"}:
            assert "--require-voice" in step["run"] and "--require-calendar" in step["run"]


def test_dev_observations_use_order_safe_serving_state():
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-dev.yml").read_text())
    steps = workflow["jobs"]["deploy"]["steps"]
    for step in steps:
        if step.get("id") in {"predeploy-state", "current-state", "final-state"}:
            assert "resolve-cloud-run-serving-state.py" in step["run"]
            assert "status.traffic[0]" not in step["run"]
            assert 'echo "backend_revision=${backend_revision}"' in step["run"]
            assert 'echo "frontend_revision=${frontend_revision}"' in step["run"]


@pytest.mark.parametrize("legacy_interface", [None, "missing-probe", "unprotected-retention"])
def test_candidate_interfaces_are_checked_before_mutating_steps(tmp_path, legacy_interface):
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-dev.yml").read_text())
    steps = workflow["jobs"]["deploy"]["steps"]
    names = [step["name"] for step in steps]
    assert names.index("Validate candidate build capabilities") < names.index(
        "Sync canonical hosted runtime secrets"
    )
    step = next(step for step in steps if step["name"] == "Validate candidate build capabilities")
    program = step["run"].split("<<'PYBUILD'\n", 1)[1].rsplit("PYBUILD", 1)[0]
    for relative in (
        "scripts/ci/verify-dev-candidate.sh",
        "scripts/ci/cloudrun-retention.sh",
        "scripts/ci/verify-cloudrun-revision-provenance.py",
        "scripts/ops/verify-env-secrets-parity.py",
        "deploy/backend.cloudbuild.yaml",
    ):
        destination = tmp_path / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / relative, destination)
    if legacy_interface == "missing-probe":
        (tmp_path / "scripts/ci/verify-dev-candidate.sh").unlink()
    elif legacy_interface == "unprotected-retention":
        (tmp_path / "scripts/ci/cloudrun-retention.sh").write_text(
            "#!/bin/bash\necho 'Usage: retention <service> [region] [keep_count]'\n"
        )
    result = subprocess.run(  # noqa: S603 - checked-in workflow program in an isolated fixture.
        [sys.executable, "-c", program],
        cwd=tmp_path,
        env={**os.environ, "BUILD_POD_IMAGE": "false", "DEPLOY_BACKEND": "true"},
        text=True,
        capture_output=True,
        timeout=30,
    )
    assert result.returncode == (1 if legacy_interface else 0), result.stderr
    if legacy_interface:
        assert "Candidate deployment interface is incompatible" in result.stderr
