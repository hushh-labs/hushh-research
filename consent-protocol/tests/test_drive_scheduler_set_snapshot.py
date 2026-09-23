"""Outer UAT gate must attest every fixed Drive scheduler job after rollback."""

from __future__ import annotations

import base64
import json
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
VERIFIER = ROOT / "deploy" / "drive" / "verify_scheduler_state.py"
UAT_WORKFLOW = ROOT / ".github" / "workflows" / "deploy-uat.yml"
PREFIX = "projects/hushh-pda-uat/locations/us-central1/jobs/"
ACCOUNT = "drive-work-drain-sched@hushh-pda-uat.iam.gserviceaccount.com"
API = "https://api.uat.hushh.ai"


def _job(name: str, *, stage: str, schedule: str, legacy: bool = False) -> dict:
    body = b"{}" if legacy else json.dumps({"stage": stage}, separators=(",", ":")).encode()
    return {
        "name": PREFIX + name,
        "state": "ENABLED",
        "schedule": schedule,
        "timeZone": "Etc/UTC",
        "attemptDeadline": "120s" if legacy else "240s",
        "retryConfig": {
            "maxBackoffDuration": "120s",
            "maxDoublings": 3,
            "maxRetryDuration": "0s",
            "minBackoffDuration": "10s",
            "retryCount": 3,
        },
        "httpTarget": {
            "uri": API + "/api/internal/drive-work/drain",
            "httpMethod": "POST",
            "body": base64.b64encode(body).decode(),
            "headers": {
                "Content-Type": "application/json",
                "User-Agent": "Google-Cloud-Scheduler",
            },
            "oidcToken": {"audience": API, "serviceAccountEmail": ACCOUNT},
        },
    }


def _run(
    mode: str, tmp_path: Path, jobs: list[dict], *, worker_origin: str = ""
) -> subprocess.CompletedProcess[str]:
    snapshot = tmp_path / "jobs.json"
    snapshot.write_text(json.dumps(jobs), encoding="utf-8")
    return subprocess.run(  # noqa: S603 - repository-owned helper and test fixture
        [
            "python3",
            str(VERIFIER),
            mode,
            "--snapshot",
            str(snapshot),
            "--canonical",
            str(tmp_path / "baseline.json"),
            "--worker-origin",
            worker_origin,
            "--github-output",
            str(tmp_path / "output"),
        ],
        capture_output=True,
        check=False,
        text=True,
    )


def test_capture_and_verify_legacy_doc_with_absent_new_jobs(tmp_path: Path):
    docs = _job("drive-work-drain-uat", stage="documents", schedule="*/2 * * * *", legacy=True)
    captured = _run("capture-set", tmp_path, [docs])
    assert captured.returncode == 0, captured.stderr
    assert json.loads((tmp_path / "baseline.json").read_text()) == {
        "drive-work-drain-uat": {
            "uri": API + "/api/internal/drive-work/drain",
            "audience": API,
            "body": "e30=",
            "schedule": "*/2 * * * *",
            "timeZone": "Etc/UTC",
            "state": "ENABLED",
            "attemptDeadline": "120s",
            "retryConfig": docs["retryConfig"],
            "headers": docs["httpTarget"]["headers"],
        }
    }
    verified = _run("verify-set", tmp_path, [docs])
    assert verified.returncode == 0, verified.stderr
    assert (tmp_path / "output").read_text().endswith("restored=true\n")


@pytest.mark.parametrize(
    "change", ["retarget", "new_job", "deadline", "body", "oidc", "headers", "retry"]
)
def test_verify_rejects_partial_or_substituted_rollback(tmp_path: Path, change: str):
    docs = _job("drive-work-drain-uat", stage="documents", schedule="*/2 * * * *", legacy=True)
    assert _run("capture-set", tmp_path, [docs]).returncode == 0
    after = json.loads(json.dumps(docs))
    jobs = [after]
    if change == "retarget":
        after["httpTarget"]["uri"] = (
            "https://consent-protocol-drive-worker-abc.a.run.app/api/internal/drive-work/drain"
        )
    elif change == "new_job":
        jobs.append(_job("drive-work-sharing-uat", stage="sharing", schedule="* * * * *"))
    elif change == "deadline":
        after["attemptDeadline"] = "240s"
    elif change == "body":
        after["httpTarget"]["body"] = base64.b64encode(b'{"stage":"documents"}').decode()
    elif change == "headers":
        after["httpTarget"]["headers"]["X-Extra"] = "unexpected"
    elif change == "retry":
        after["retryConfig"]["retryCount"] = 99
    else:
        after["httpTarget"]["oidcToken"]["serviceAccountEmail"] = "wrong@example.invalid"
    failed = _run("verify-set", tmp_path, jobs)
    assert failed.returncode != 0
    assert (tmp_path / "output").read_text().count("restored=true") == 0


def test_capture_accepts_exact_three_stage_jobs(tmp_path: Path):
    jobs = [
        _job("drive-work-drain-uat", stage="documents", schedule="*/4 * * * *"),
        _job("drive-work-suggestions-uat", stage="suggestions", schedule="2-59/4 * * * *"),
        _job("drive-work-sharing-uat", stage="sharing", schedule="* * * * *"),
    ]
    assert _run("capture-set", tmp_path, jobs).returncode == 0
    assert _run("verify-set", tmp_path, jobs).returncode == 0


def test_worker_target_must_match_verified_service_origin(tmp_path: Path):
    docs = _job("drive-work-drain-uat", stage="documents", schedule="*/4 * * * *")
    docs["httpTarget"]["uri"] = (
        "https://consent-protocol-drive-worker-lookalike.a.run.app/api/internal/drive-work/drain"
    )
    actual_origin = "https://consent-protocol-drive-worker-actual.a.run.app"
    assert _run("capture-set", tmp_path, [docs], worker_origin=actual_origin).returncode != 0
    docs["httpTarget"]["uri"] = actual_origin + "/api/internal/drive-work/drain"
    assert _run("capture-set", tmp_path, [docs], worker_origin=actual_origin).returncode == 0


def test_existing_runtime_api_target_uses_its_registered_audience(tmp_path: Path):
    docs = _job("drive-work-drain-uat", stage="documents", schedule="*/2 * * * *", legacy=True)
    runtime = "https://consent-protocol-f2gsa4kfsq-uc.a.run.app"
    docs["httpTarget"]["uri"] = runtime + "/api/internal/drive-work/drain"
    docs["httpTarget"]["oidcToken"]["audience"] = runtime
    assert _run("capture-set", tmp_path, [docs]).returncode == 0
    docs["httpTarget"]["oidcToken"]["audience"] = API
    assert _run("capture-set", tmp_path, [docs]).returncode != 0


def test_uat_gate_captures_all_jobs_and_quarantines_unrestored_scheduler():
    workflow = UAT_WORKFLOW.read_text(encoding="utf-8")
    capture = workflow.split("id: capture-drive-worker-scheduler", 1)[1].split(
        "id: deploy-drive-worker", 1
    )[0]
    verify = workflow.split("id: verify-drive-worker-scheduler-rollback", 1)[1].split(
        "id: final-state", 1
    )[0]
    assert "gcloud scheduler jobs list" in capture
    assert "verify_scheduler_state.py capture-set" in capture
    assert "--canonical /tmp/uat-drive-worker-pre-scheduler-canonical.json" in capture
    assert '--worker-origin "$WORKER_ORIGIN"' in capture
    assert "gcloud scheduler jobs list" in verify
    assert "verify_scheduler_state.py verify-set" in verify
    assert "--canonical /tmp/uat-drive-worker-pre-scheduler-canonical.json" in verify
    assert "work_drain_scheduler_snapshot.py quarantine" in verify
