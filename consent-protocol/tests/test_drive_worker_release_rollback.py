"""A cancelled private-worker rollout restores the exact prior scheduler set."""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from tests.helpers.drive_worker_gcloud import (
    FAKE_BASH,
    FAKE_GCLOUD,
    worker_release_environment,
    write_executables,
)

ROOT = Path(__file__).resolve().parents[2]
WORKER_RELEASE = ROOT / "deploy" / "drive" / "deploy_worker_service.sh"
API_ORIGIN = "https://api.uat.hushh.ai"
WORKER_ORIGIN = "https://consent-protocol-drive-worker-abc.a.run.app"
PATH = "/api/internal/drive-work/drain"
PREFIX = "projects/hushh-pda-uat/locations/us-central1/jobs/"
ACCOUNT = "drive-work-drain-sched@hushh-pda-uat.iam.gserviceaccount.com"
SCANNER_AMD64_IMAGE = (
    "mirror.gcr.io/clamav/clamav@sha256:"
    "e8388295191bff0893fb889d9415ae975491201c989b205e30c9057b1985d36a"
)
WRONG_SCANNER_IMAGE = "mirror.gcr.io/clamav/clamav@sha256:" + "0" * 64


def _job(name: str, stage: str | None, schedule: str, deadline: str) -> dict:
    body = {} if stage is None else {"stage": stage}
    return {
        "name": PREFIX + name,
        "schedule": schedule,
        "timeZone": "Etc/UTC",
        "state": "ENABLED",
        "attemptDeadline": deadline,
        "retryConfig": {
            "retryCount": 3,
            "minBackoffDuration": "10s",
            "maxBackoffDuration": "120s",
            "maxDoublings": 3,
            "maxRetryDuration": "0s",
        },
        "httpTarget": {
            "uri": API_ORIGIN + PATH,
            "httpMethod": "POST",
            "body": base64.b64encode(json.dumps(body, separators=(",", ":")).encode()).decode(),
            "headers": {
                "Content-Type": "application/json",
                "User-Agent": "Google-Cloud-Scheduler",
            },
            "oidcToken": {"audience": API_ORIGIN, "serviceAccountEmail": ACCOUNT},
        },
    }


def _release_jobs(*, optional: bool, worker_target: bool = False, legacy_suggestions: bool = False):
    document = "drive-work-drain-uat"
    jobs = {
        document: _job(
            document,
            "documents" if worker_target else None,
            "* * * * *" if worker_target else "*/2 * * * *",
            "240s" if worker_target else "120s",
        )
    }
    if optional:
        for name, stage in (
            ("drive-work-suggestions-uat", "suggestions"),
            ("drive-work-sharing-uat", "sharing"),
        ):
            cron = (
                "2-59/4 * * * *" if legacy_suggestions and stage == "suggestions" else "* * * * *"
            )
            jobs[name] = _job(name, stage, cron, "240s")
    if worker_target:
        for job in jobs.values():
            job["httpTarget"]["uri"] = WORKER_ORIGIN + PATH
    return jobs


@pytest.mark.parametrize("resume_drift", ["", "state", "audience", "body"])
def test_uat_worker_setup_resumes_a_paused_suggestions_job(tmp_path: Path, resume_drift):
    fake_bin = write_executables(tmp_path / "bin", {"gcloud": FAKE_GCLOUD})
    name = "drive-work-suggestions-uat"
    paused = _job(name, "suggestions", "* * * * *", "240s")
    paused["state"] = "PAUSED"
    state_path = tmp_path / "scheduler.json"
    state_path.write_text(json.dumps({"jobs": {name: paused}, "mutations": 0}), encoding="utf-8")
    environment = os.environ.copy()
    environment.update(
        {
            "PATH": f"{fake_bin}:{environment['PATH']}",
            "MOCK_SCHEDULER_STATE": str(state_path),
            "BACKEND_URL": API_ORIGIN,
            "OIDC_AUDIENCE": API_ORIGIN,
            "JOB_NAME": name,
            "STAGE": "suggestions",
            "CRON": "* * * * *",
            "MOCK_RESUME_DRIFT": resume_drift,
        }
    )
    result = subprocess.run(  # noqa: S603 - fixed repository-owned release helper
        ["/bin/bash", "deploy/drive/setup_work_drain_scheduler.sh"],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        check=False,
        text=True,
        timeout=20,
    )
    assert (result.returncode == 0) is (not resume_drift), result.stdout + result.stderr
    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert state["jobs"][name]["state"] == ("PAUSED" if resume_drift == "state" else "ENABLED")


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ((), None),
        (("state",), "PAUSED"),
        (("schedule",), "2-59/4 * * * *"),
        (("timeZone",), "Asia/Kolkata"),
        (("attemptDeadline",), "120s"),
        (("retryConfig", "retryCount"), 2),
        (("httpTarget", "uri"), API_ORIGIN + PATH),
        (("httpTarget", "httpMethod"), "GET"),
        (("httpTarget", "headers", "Content-Type"), "text/plain"),
        (("httpTarget", "oidcToken", "audience"), "https://foreign.invalid"),
        (("httpTarget", "oidcToken", "serviceAccountEmail"), "foreign@example.invalid"),
        (("httpTarget", "body"), base64.b64encode(b'{"stage":"documents"}').decode()),
    ],
)
def test_worker_scheduler_reuses_only_the_full_verified_contract(tmp_path, field, value):
    fake_bin = write_executables(tmp_path / "bin", {"gcloud": FAKE_GCLOUD})
    name = "drive-work-suggestions-uat"
    expected = _job(name, "suggestions", "* * * * *", "240s")
    expected["httpTarget"]["uri"] = WORKER_ORIGIN + PATH
    current = json.loads(json.dumps(expected))
    if field:
        parent = current
        for key in field[:-1]:
            parent = parent[key]
        parent[field[-1]] = value
    state_path = tmp_path / "scheduler.json"
    jobs = {
        job: _job(job, stage, "* * * * *", "240s")
        for job, stage in (
            ("drive-work-drain-uat", "documents"),
            ("drive-work-suggestions-uat", "suggestions"),
            ("drive-work-sharing-uat", "sharing"),
        )
    }
    for job in jobs.values():
        job["httpTarget"]["uri"] = WORKER_ORIGIN + PATH
    jobs[name] = current
    state_path.write_text(json.dumps({"jobs": jobs, "mutations": 0}))
    result = subprocess.run(  # noqa: S603 - fixed repository helper and synthetic CLI transport.
        [
            sys.executable,
            "deploy/drive/work_drain_scheduler_snapshot.py",
            "plan-configuration",
            "--worker-origin",
            WORKER_ORIGIN,
        ],
        cwd=ROOT,
        env={
            **os.environ,
            "PATH": f"{fake_bin}:{os.environ['PATH']}",
            "MOCK_SCHEDULER_STATE": str(state_path),
            "MOCK_WORKER_ORIGIN": WORKER_ORIGIN,
            "BACKEND_URL": WORKER_ORIGIN,
            "OIDC_AUDIENCE": API_ORIGIN,
            "JOB_NAME": name,
            "STAGE": "suggestions",
        },
        capture_output=True,
        text=True,
        check=False,
        timeout=20,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    state = json.loads(state_path.read_text())
    assert result.stdout.split() == ([name] if field else [])
    assert state["mutations"] == 0
    assert state["jobs"][name] == current


@pytest.mark.parametrize("malformed", ["row", "duplicate", "foreign", "missing_name"])
@pytest.mark.parametrize("command", ["capture", "plan-configuration"])
def test_worker_scheduler_inventory_fails_closed_before_mutation(tmp_path, malformed, command):
    fake_bin = write_executables(tmp_path / "bin", {"gcloud": FAKE_GCLOUD})
    name = "drive-work-drain-uat"
    job = _job(name, "documents", "* * * * *", "240s")
    job["httpTarget"]["uri"] = WORKER_ORIGIN + PATH
    jobs = {name: job}
    if malformed == "row":
        jobs["invalid"] = None
    elif malformed == "duplicate":
        jobs["duplicate"] = job
    elif malformed == "foreign":
        job["name"] = "projects/foreign/locations/us-central1/jobs/" + name
    else:
        job.pop("name")
    state_path = tmp_path / "scheduler.json"
    state_path.write_text(json.dumps({"jobs": jobs, "mutations": 0}))
    result = subprocess.run(  # noqa: S603 - fixed repository helper and bounded parameter choices.
        [
            sys.executable,
            "deploy/drive/work_drain_scheduler_snapshot.py",
            command,
            "--snapshot",
            str(tmp_path / "snapshot.json"),
            "--worker-origin",
            WORKER_ORIGIN,
        ],
        cwd=ROOT,
        env={
            **os.environ,
            "PATH": f"{fake_bin}:{os.environ['PATH']}",
            "MOCK_SCHEDULER_STATE": str(state_path),
            "MOCK_WORKER_ORIGIN": WORKER_ORIGIN,
        },
        capture_output=True,
        text=True,
        check=False,
        timeout=20,
    )
    assert result.returncode != 0
    assert json.loads(state_path.read_text())["mutations"] == 0
    assert not (tmp_path / "snapshot.json").exists()


@pytest.mark.parametrize(
    ("quoted_job", "timestamp_value", "json_output", "valid"),
    [
        (True, '"2026-09-23T00:00:00Z"', True, True),
        (True, "2026-09-23T00:00:00Z", True, False),
        (True, '"not-a-time"', True, False),
        (True, '"2026-02-30T00:00:00Z"', True, False),
        (True, '"2026-09-23T00:00:00+00:00"', True, False),
        (True, '"2026-09-23T00:00:00.123Z"', True, False),
        (False, '"2026-09-23T00:00:00Z"', True, False),
        (True, '"2026-09-23T00:00:00Z"', False, False),
    ],
)
def test_mock_cloud_logging_requires_quoted_filter_and_json(
    tmp_path: Path,
    quoted_job: bool,
    timestamp_value: str,
    json_output: bool,
    valid: bool,
):
    fake_gcloud = write_executables(tmp_path, {"gcloud": FAKE_GCLOUD}) / "gcloud"
    job_name = "drive-work-drain-uat"
    state_path = tmp_path / "scheduler.json"
    state_path.write_text(
        json.dumps(
            {
                "jobs": {job_name: _job(job_name, None, "*/2 * * * *", "120s")},
                "mutations": 0,
                "triggered": [job_name],
            }
        ),
        encoding="utf-8",
    )
    job_value = f'"{job_name}"' if quoted_job else job_name
    query = (
        'resource.type="cloud_scheduler_job" AND '
        f"resource.labels.job_id={job_value} AND timestamp>={timestamp_value}"
    )
    environment = os.environ.copy()
    environment["MOCK_SCHEDULER_STATE"] = str(state_path)
    result = subprocess.run(  # noqa: S603 - repository-owned test fixture
        [
            str(fake_gcloud),
            "logging",
            "read",
            query,
            "--format=json" if json_output else "--format=text",
        ],
        env=environment,
        capture_output=True,
        check=False,
        text=True,
    )
    if valid:
        assert result.returncode == 0, result.stderr
        assert json.loads(result.stdout)[0]["jsonPayload"]["jobName"].endswith(job_name)
    else:
        assert result.returncode == 76


@pytest.mark.parametrize("existing_new_jobs", [False, True])
@pytest.mark.parametrize("restore_succeeds", [True, False])
def test_term_after_partial_retarget_restores_exact_job_set_or_quarantines(
    tmp_path: Path, existing_new_jobs: bool, restore_succeeds: bool
):
    fake_bin = write_executables(tmp_path / "bin", {"gcloud": FAKE_GCLOUD, "bash": FAKE_BASH})
    initial_jobs = _release_jobs(optional=existing_new_jobs, legacy_suggestions=True)
    state_path = tmp_path / "scheduler.json"
    state_path.write_text(json.dumps({"jobs": initial_jobs, "mutations": 0}), encoding="utf-8")
    setup_count = tmp_path / "setup-count"
    environment = worker_release_environment(
        fake_bin, state_path, setup_count, origin=WORKER_ORIGIN, scanner_image=SCANNER_AMD64_IMAGE
    )
    environment["MOCK_RESTORE_FAIL"] = str(not restore_succeeds).lower()
    result = subprocess.run(  # noqa: S603 - fixed repository-owned release helper
        ["/bin/bash", str(WORKER_RELEASE)],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        check=False,
        text=True,
        timeout=20,
    )

    output = result.stdout + result.stderr
    assert result.returncode == 143, output
    assert setup_count.read_text(encoding="utf-8") == "2"
    assert "Drive worker candidate failed" in output
    final_state = json.loads(state_path.read_text(encoding="utf-8"))
    if restore_succeeds:
        assert final_state["jobs"] == initial_jobs
        assert "CRITICAL" not in output
    else:
        assert final_state["invoker_removed"] is True
        assert all(job["state"] == "PAUSED" for job in final_state["jobs"].values())
        assert "CRITICAL: Drive worker rollback is incomplete" in output


def _release_probe_binaries(tmp_path: Path) -> Path:
    fake_bin = write_executables(tmp_path / "bin", {"gcloud": FAKE_GCLOUD, "bash": FAKE_BASH})
    fake_sleep = fake_bin / "sleep"
    fake_sleep.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    fake_sleep.chmod(0o755)
    # Exercise retry and exhaustion with two observations, rather than launching
    # the same verifier 55 times. Production's 55-attempt request stays checked.
    fake_seq = fake_bin / "seq"
    fake_seq.write_text(
        '#!/bin/sh\n[ "$#" = 2 ] && [ "$1" = 1 ] && [ "$2" = 55 ] || exit 77\n'
        "printf '1\\n2\\n'\n",
        encoding="utf-8",
    )
    fake_seq.chmod(0o755)
    return fake_bin


@pytest.mark.parametrize(
    ("processing_enabled", "log_failure", "all_jobs_present"),
    [
        (True, "none", False),
        (True, "none", True),
        (True, "wrong_url", False),
        (True, "missing", False),
        (False, "none", False),
        (False, "none", True),
    ],
)
@pytest.mark.parametrize("wrong_scanner_child", [False, True])
def test_success_requires_all_three_fixed_stage_jobs_and_fresh_200_logs(
    tmp_path: Path,
    processing_enabled: bool,
    log_failure: str,
    all_jobs_present: bool,
    wrong_scanner_child: bool,
):
    fake_bin = _release_probe_binaries(tmp_path)
    initial_jobs = _release_jobs(
        optional=all_jobs_present, worker_target=processing_enabled and all_jobs_present
    )
    original_document = initial_jobs["drive-work-drain-uat"]
    state_path = tmp_path / "scheduler.json"
    state_path.write_text(
        json.dumps(
            {
                "jobs": initial_jobs,
                "mutations": 0,
                "existing_worker": processing_enabled and all_jobs_present,
            }
        ),
        encoding="utf-8",
    )
    setup_count = tmp_path / "setup-count"
    environment = worker_release_environment(
        fake_bin,
        state_path,
        setup_count,
        origin=WORKER_ORIGIN,
        scanner_image=WRONG_SCANNER_IMAGE if wrong_scanner_child else SCANNER_AMD64_IMAGE,
    )
    environment.update(
        {
            "MOCK_TERMINATE_AFTER_SETUP": "false",
            "MOCK_FAIL_LOG_JOB": "drive-work-sharing-uat" if log_failure == "wrong_url" else "",
            "MOCK_MISSING_LOG_JOB": "drive-work-sharing-uat" if log_failure == "missing" else "",
            "MOCK_DEFER_LOG_JOB": "drive-work-sharing-uat" if log_failure == "none" else "",
            "DRIVE_WORK_DRAIN_ENABLED": str(processing_enabled).lower(),
        }
    )
    result = subprocess.run(  # noqa: S603 - fixed repository-owned release helper
        ["/bin/bash", str(WORKER_RELEASE)],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        check=False,
        text=True,
        # The two-probe failure path also restores the scheduler set. Give the
        # fixture watchdog time to observe rollback; production polling is unchanged.
        timeout=60,
    )
    output = result.stdout + result.stderr
    state = json.loads(state_path.read_text(encoding="utf-8"))
    if wrong_scanner_child:
        assert result.returncode != 0
        assert "scanner image digest mismatch" in output
        assert not setup_count.exists(), output
        assert state["jobs"] == initial_jobs
        return
    assert state["deployed_drain_enabled"] == str(processing_enabled).lower()
    if not processing_enabled:
        assert result.returncode == 0, output
        assert not setup_count.exists()
        assert not state.get("triggered")
        assert set(state["jobs"]) == set(initial_jobs)
        assert all(job["state"] == "PAUSED" for job in state["jobs"].values())
        assert "background processing paused" in output
        return
    if all_jobs_present:
        assert not setup_count.exists()
        assert state["mutations"] == 0
    else:
        assert setup_count.read_text(encoding="utf-8") == "3", output
    assert state["triggered"] == [
        "drive-work-drain-uat",
        "drive-work-suggestions-uat",
        "drive-work-sharing-uat",
    ]
    assert state["first_log_triggered"] == state["triggered"]
    assert state["log_reads"] == {
        "drive-work-drain-uat": 1,
        "drive-work-suggestions-uat": 1,
        "drive-work-sharing-uat": 2,
    }
    if log_failure != "none":
        assert result.returncode != 0
        assert "drive-work-sharing-uat produced no fresh 200" in output
        assert state["jobs"] == {"drive-work-drain-uat": original_document}
    else:
        assert result.returncode == 0, output
        assert "all three schedulers returned 200" in output
        assert set(state["jobs"]) == set(state["triggered"])
        for name, stage in (
            ("drive-work-drain-uat", "documents"),
            ("drive-work-suggestions-uat", "suggestions"),
            ("drive-work-sharing-uat", "sharing"),
        ):
            target = state["jobs"][name]["httpTarget"]
            assert target["uri"] == WORKER_ORIGIN + PATH
            assert json.loads(base64.b64decode(target["body"])) == {"stage": stage}
