"""The UAT maintenance lane preserves an operator-paused Drive worker exactly."""

from __future__ import annotations

import base64
import copy
import json
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "deploy" / "drive" / "attest_paused_maintenance.py"
WORKFLOW = ROOT / ".github" / "workflows" / "deploy-uat.yml"
PREFIX = "projects/hushh-pda-uat/locations/us-central1/jobs/"
ACCOUNT = "drive-work-drain-sched@hushh-pda-uat.iam.gserviceaccount.com"
ORIGIN = "https://consent-protocol-drive-worker-abc.a.run.app"
REVISION = "consent-protocol-drive-worker-00587-qiy"


def _job(name: str, stage: str) -> dict:
    return {
        "name": PREFIX + name,
        "state": "PAUSED",
        "schedule": "* * * * *",
        "timeZone": "Etc/UTC",
        "attemptDeadline": "240s",
        "retryConfig": {
            "maxBackoffDuration": "120s",
            "maxDoublings": 3,
            "maxRetryDuration": "0s",
            "minBackoffDuration": "10s",
            "retryCount": 3,
        },
        "httpTarget": {
            "uri": ORIGIN + "/api/internal/drive-work/drain",
            "httpMethod": "POST",
            "body": base64.b64encode(
                json.dumps({"stage": stage}, separators=(",", ":")).encode()
            ).decode(),
            "headers": {
                "Content-Type": "application/json",
                "User-Agent": "Google-Cloud-Scheduler",
            },
            "oidcToken": {
                "audience": "https://api.uat.hushh.ai",
                "serviceAccountEmail": ACCOUNT,
            },
        },
    }


def _jobs() -> list[dict]:
    return [
        _job("drive-work-drain-uat", "documents"),
        _job("drive-work-suggestions-uat", "suggestions"),
        _job("drive-work-sharing-uat", "sharing"),
    ]


def _worker() -> dict:
    return {
        "metadata": {"name": "consent-protocol-drive-worker", "generation": 589},
        "status": {
            "observedGeneration": 589,
            "url": ORIGIN,
            "conditions": [{"type": "Ready", "status": "True"}],
            "traffic": [{"percent": 100, "revisionName": REVISION}],
        },
    }


def _run(
    mode: str, tmp_path: Path, jobs: list[dict], worker: dict
) -> subprocess.CompletedProcess[str]:
    scheduler_path = tmp_path / "scheduler.json"
    worker_path = tmp_path / "worker.json"
    scheduler_path.write_text(json.dumps(jobs), encoding="utf-8")
    worker_path.write_text(json.dumps(worker), encoding="utf-8")
    return subprocess.run(  # noqa: S603 - repository-owned script and fixture paths
        [
            sys.executable,
            str(HELPER),
            mode,
            "--scheduler-snapshot",
            str(scheduler_path),
            "--worker-snapshot",
            str(worker_path),
            "--baseline",
            str(tmp_path / "baseline.json"),
            "--github-output",
            str(tmp_path / "output"),
        ],
        capture_output=True,
        check=False,
        text=True,
    )


def test_exact_paused_scheduler_and_worker_round_trip(tmp_path: Path) -> None:
    jobs, worker = _jobs(), _worker()
    assert _run("capture", tmp_path, jobs, worker).returncode == 0
    baseline = json.loads((tmp_path / "baseline.json").read_text())
    assert baseline["worker"] == {"origin": ORIGIN, "revision": REVISION}
    assert set(baseline["jobs"]) == {job["name"].removeprefix(PREFIX) for job in jobs}
    assert all(job["state"] == "PAUSED" for job in baseline["jobs"].values())
    assert _run("verify", tmp_path, jobs, worker).returncode == 0
    assert (tmp_path / "output").read_text().endswith("paused_drive_unchanged=true\n")


@pytest.mark.parametrize(
    "change",
    [
        "missing",
        "enabled",
        "retarget",
        "body",
        "service_account",
        "worker_revision",
        "worker_not_ready",
        "split_traffic",
    ],
)
def test_capture_or_verify_fails_closed_on_drift(tmp_path: Path, change: str) -> None:
    jobs, worker = _jobs(), _worker()
    assert _run("capture", tmp_path, jobs, worker).returncode == 0
    before = (tmp_path / "output").read_text()
    changed_jobs, changed_worker = copy.deepcopy(jobs), copy.deepcopy(worker)
    if change == "missing":
        changed_jobs.pop()
    elif change == "enabled":
        changed_jobs[1]["state"] = "ENABLED"
    elif change == "retarget":
        changed_jobs[0]["httpTarget"]["uri"] = (
            "https://consent-protocol-drive-worker-other.a.run.app/api/internal/drive-work/drain"
        )
    elif change == "body":
        changed_jobs[2]["httpTarget"]["body"] = base64.b64encode(b"{}").decode()
    elif change == "service_account":
        changed_jobs[0]["httpTarget"]["oidcToken"]["serviceAccountEmail"] = (
            "other@hushh-pda-uat.iam.gserviceaccount.com"
        )
    elif change == "worker_revision":
        changed_worker["status"]["traffic"][0]["revisionName"] = (
            "consent-protocol-drive-worker-00588-abc"
        )
    elif change == "worker_not_ready":
        changed_worker["status"]["conditions"][0]["status"] = "False"
    else:
        changed_worker["status"]["traffic"] = [
            {"percent": 50, "revisionName": REVISION},
            {"percent": 50, "revisionName": "consent-protocol-drive-worker-00588-abc"},
        ]
    failed = _run("verify", tmp_path, changed_jobs, changed_worker)
    assert failed.returncode != 0
    assert (tmp_path / "output").read_text() == before


def test_capture_requires_all_three_jobs_paused(tmp_path: Path) -> None:
    jobs, worker = _jobs(), _worker()
    jobs[0]["state"] = "ENABLED"
    failed = _run("capture", tmp_path, jobs, worker)
    assert failed.returncode != 0
    assert not (tmp_path / "baseline.json").exists()


def test_workflow_skips_worker_mutations_only_with_verified_opt_in() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    steps = yaml.safe_load(workflow)["jobs"]["deploy"]["steps"]
    by_id = {step["id"]: step for step in steps if "id" in step}
    capture = by_id["capture-paused-drive-maintenance"]
    assert workflow.index("id: capture-paused-drive-maintenance") < workflow.index(
        "id: promote-uat-traffic"
    )
    assert "inputs.preserve_paused_drive_worker == true" in capture["if"]
    assert "steps.scope.outputs.deploy_backend" in capture["run"]
    assert "attest_paused_maintenance.py capture" in capture["run"]
    for step_id in ("capture-drive-worker-scheduler", "deploy-drive-worker"):
        assert "inputs.preserve_paused_drive_worker != true" in by_id[step_id]["if"]
    verify = by_id["verify-paused-drive-maintenance"]
    assert "inputs.preserve_paused_drive_worker == true" in verify["if"]
    assert "attest_paused_maintenance.py verify" in verify["run"]
    assert "gcloud scheduler jobs run" not in verify["run"]
    assert workflow.index("id: verify-paused-drive-maintenance") < workflow.index(
        "id: rollback-backend-after-drive-worker"
    )
    for step_id in (
        "rollback-backend-after-drive-worker",
        "rollback-frontend-after-drive-worker",
    ):
        condition = by_id[step_id]["if"]
        assert "steps.verify-paused-drive-maintenance.outcome != 'success'" in condition
        assert "steps.deploy-drive-worker.outcome != 'success'" in condition
    assert "DRIVE_WORKER_GATE_SUCCESS" in workflow
    assert "steps.verify-paused-drive-maintenance.outputs.paused_drive_unchanged" in workflow
    assert "drive_worker_gate_success" in workflow
    assert "inputs.preserve_paused_drive_worker" not in by_id["activate-account-deletion"]["if"]
    assert (
        "steps.scope.outputs.deploy_backend == 'true'" in by_id["activate-account-deletion"]["if"]
    )
    assert "verify_release_boundary.sql" in by_id["activate-account-deletion"]["run"]
    assert "steps.scope.outputs.deploy_backend == 'true'" in by_id["postdeploy-db-gate"]["if"]
