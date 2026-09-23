"""A cancelled private-worker rollout restores the exact prior scheduler set."""

from __future__ import annotations

import base64
import json
import os
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
WORKER_RELEASE = ROOT / "deploy" / "drive" / "deploy_worker_service.sh"
API_ORIGIN = "https://api.uat.hushh.ai"
WORKER_ORIGIN = "https://consent-protocol-drive-worker-abc.a.run.app"
PATH = "/api/internal/drive-work/drain"
PREFIX = "projects/hushh-pda-uat/locations/us-central1/jobs/"
ACCOUNT = "drive-work-drain-sched@hushh-pda-uat.iam.gserviceaccount.com"


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


FAKE_GCLOUD = """#!/usr/bin/env python3
import base64
import json
import os
import sys
from pathlib import Path

args = [arg for arg in sys.argv[1:] if arg != "--quiet"]
state_path = Path(os.environ["MOCK_SCHEDULER_STATE"])
state = json.loads(state_path.read_text())
jobs = state["jobs"]

def flag(name, default=None):
    return next((item.split("=", 1)[1] for item in args if item.startswith(name + "=")), default)

def save():
    state_path.write_text(json.dumps(state, sort_keys=True))

if args[:3] == ["run", "services", "list"]:
    print("[]")
elif args[:3] == ["run", "services", "describe"]:
    if "--format=value(status.latestCreatedRevisionName)" in args:
        print("consent-protocol-drive-worker-00001-abc")
    elif "--format=value(status.url)" in args:
        print(os.environ["MOCK_WORKER_ORIGIN"])
    else:
        sys.exit(70)
elif args[:3] == ["run", "revisions", "describe"]:
    print(json.dumps({
        "metadata": {"labels": {"deploy-sha": os.environ["DEPLOY_SHA"]}},
        "spec": {"containers": [
            {"name": "drive-worker", "image": os.environ["IMAGE_REFERENCE"]},
            {"name": "clamav", "image": os.environ["MOCK_CLAMAV_IMAGE"]},
        ]},
        "status": {"conditions": [{"type": "Ready", "status": "True"}]},
    }))
elif args[:2] == ["run", "deploy"] or args[:3] in (
    ["run", "services", "add-iam-policy-binding"],
    ["run", "services", "update-traffic"],
):
    pass
elif args[:3] == ["run", "services", "remove-iam-policy-binding"]:
    state["invoker_removed"] = True
    save()
elif args[:3] == ["iam", "service-accounts", "describe"]:
    pass
elif args[:3] == ["scheduler", "jobs", "list"]:
    print(json.dumps(list(jobs.values())))
elif args[:3] == ["scheduler", "jobs", "describe"]:
    name = args[3]
    if name not in jobs:
        sys.exit(71)
    job = jobs[name]
    if "--format=json" in args:
        print(json.dumps(job))
    elif any(item.startswith("--format=value(state,schedule,") for item in args):
        target = job["httpTarget"]
        print("\\t".join((job["state"], job["schedule"], target["uri"],
                          target["httpMethod"], target["oidcToken"]["serviceAccountEmail"],
                          target["oidcToken"]["audience"])))
    else:
        print(name)
elif args[:4] in (["scheduler", "jobs", "create", "http"],
                 ["scheduler", "jobs", "update", "http"]):
    name = args[4]
    old = jobs.get(name)
    if args[2] == "update" and old is None:
        sys.exit(72)
    if args[2] == "create" and old is not None:
        sys.exit(73)
    if (os.environ.get("MOCK_RESTORE_FAIL") == "true" and state["mutations"] >= 2
        and name == "drive-work-drain-uat" and flag("--schedule") == "*/2 * * * *"):
        sys.exit(74)
    job = {
        "name": "projects/hushh-pda-uat/locations/us-central1/jobs/" + name,
        "schedule": flag("--schedule"),
        "timeZone": flag("--time-zone"),
        "state": "ENABLED" if old is None else old["state"],
        "attemptDeadline": flag("--attempt-deadline"),
        "retryConfig": {
            "retryCount": int(flag("--max-retry-attempts")),
            "minBackoffDuration": flag("--min-backoff"),
            "maxBackoffDuration": flag("--max-backoff"),
            "maxDoublings": int(flag("--max-doublings")),
            "maxRetryDuration": flag("--max-retry-duration", "0s"),
        },
        "httpTarget": {
            "uri": flag("--uri"),
            "httpMethod": flag("--http-method"),
            "body": base64.b64encode(flag("--message-body").encode()).decode(),
            "headers": {
                "Content-Type": "application/json",
                "User-Agent": "Google-Cloud-Scheduler",
            },
            "oidcToken": {
                "audience": flag("--oidc-token-audience"),
                "serviceAccountEmail": flag("--oidc-service-account-email"),
            },
        },
    }
    jobs[name] = job
    state["mutations"] += 1
    save()
elif args[:3] == ["scheduler", "jobs", "delete"]:
    jobs.pop(args[3])
    save()
elif args[:3] in (["scheduler", "jobs", "pause"], ["scheduler", "jobs", "resume"]):
    jobs[args[3]]["state"] = "PAUSED" if args[2] == "pause" else "ENABLED"
    save()
elif args[:3] == ["scheduler", "jobs", "run"]:
    state.setdefault("triggered", []).append(args[3])
    save()
elif args[:2] == ["logging", "read"]:
    job = next((name for name in jobs if "resource.labels.job_id=" + name in args[2]), "")
    if job in state.get("triggered", []) and job != os.environ.get("MOCK_FAIL_LOG_JOB"):
        print(json.dumps([{"textPayload": "URL_CRAWLED. Original HTTP response code number = 200"}]))
    else:
        print("[]")
else:
    print("unmocked gcloud:", args, file=sys.stderr)
    sys.exit(75)
"""

FAKE_BASH = """#!/usr/bin/env python3
import os
import signal
import subprocess
import sys
from pathlib import Path

if sys.argv[1:] != ["deploy/drive/setup_work_drain_scheduler.sh"]:
    sys.exit(80)
result = subprocess.run(["/bin/bash", *sys.argv[1:]], check=False)
if result.returncode:
    sys.exit(result.returncode)
count_path = Path(os.environ["MOCK_SETUP_COUNT"])
count = int(count_path.read_text()) + 1 if count_path.exists() else 1
count_path.write_text(str(count))
if count == 2 and os.environ.get("MOCK_TERMINATE_AFTER_SETUP", "true") == "true":
    os.kill(os.getppid(), signal.SIGTERM)
"""


@pytest.mark.parametrize("existing_new_jobs", [False, True])
@pytest.mark.parametrize("restore_succeeds", [True, False])
def test_term_after_partial_retarget_restores_exact_job_set_or_quarantines(
    tmp_path: Path, existing_new_jobs: bool, restore_succeeds: bool
):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_gcloud = fake_bin / "gcloud"
    fake_gcloud.write_text(FAKE_GCLOUD, encoding="utf-8")
    fake_gcloud.chmod(0o755)
    fake_bash = fake_bin / "bash"
    fake_bash.write_text(FAKE_BASH, encoding="utf-8")
    fake_bash.chmod(0o755)
    initial_jobs = {
        "drive-work-drain-uat": _job("drive-work-drain-uat", None, "*/2 * * * *", "120s")
    }
    if existing_new_jobs:
        initial_jobs["drive-work-suggestions-uat"] = _job(
            "drive-work-suggestions-uat", "suggestions", "2-59/4 * * * *", "240s"
        )
        initial_jobs["drive-work-sharing-uat"] = _job(
            "drive-work-sharing-uat", "sharing", "* * * * *", "240s"
        )
    state_path = tmp_path / "scheduler.json"
    state_path.write_text(json.dumps({"jobs": initial_jobs, "mutations": 0}), encoding="utf-8")
    setup_count = tmp_path / "setup-count"
    clamav_image = next(
        line.split('"')[1]
        for line in WORKER_RELEASE.read_text(encoding="utf-8").splitlines()
        if line.startswith("readonly CLAMAV_IMAGE=")
    )
    environment = os.environ.copy()
    environment.update(
        {
            "PATH": f"{fake_bin}:{environment['PATH']}",
            "MOCK_SCHEDULER_STATE": str(state_path),
            "MOCK_SETUP_COUNT": str(setup_count),
            "MOCK_RESTORE_FAIL": str(not restore_succeeds).lower(),
            "MOCK_WORKER_ORIGIN": WORKER_ORIGIN,
            "MOCK_CLAMAV_IMAGE": clamav_image,
            "IMAGE_REFERENCE": "gcr.io/hushh-pda-uat/consent-protocol@sha256:" + "a" * 64,
            "DEPLOY_SHA": "b" * 40,
            "RUNTIME_SERVICE_ACCOUNT": (
                "consent-protocol-runtime@hushh-pda-uat.iam.gserviceaccount.com"
            ),
            "CLOUDSQL_INSTANCE": "hushh-pda-uat:us-central1:hushh-uat-pg",
            "RELEASE_RUN_ID": "12345",
        }
    )
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


@pytest.mark.parametrize("missing_sharing_200", [False, True])
def test_success_requires_all_three_fixed_stage_jobs_and_fresh_200_logs(
    tmp_path: Path, missing_sharing_200: bool
):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    for name, source in (("gcloud", FAKE_GCLOUD), ("bash", FAKE_BASH)):
        executable = fake_bin / name
        executable.write_text(source, encoding="utf-8")
        executable.chmod(0o755)
    fake_sleep = fake_bin / "sleep"
    fake_sleep.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    fake_sleep.chmod(0o755)
    original_document = _job("drive-work-drain-uat", None, "*/2 * * * *", "120s")
    state_path = tmp_path / "scheduler.json"
    state_path.write_text(
        json.dumps({"jobs": {"drive-work-drain-uat": original_document}, "mutations": 0}),
        encoding="utf-8",
    )
    setup_count = tmp_path / "setup-count"
    clamav_image = next(
        line.split('"')[1]
        for line in WORKER_RELEASE.read_text(encoding="utf-8").splitlines()
        if line.startswith("readonly CLAMAV_IMAGE=")
    )
    environment = os.environ.copy()
    environment.update(
        {
            "PATH": f"{fake_bin}:{environment['PATH']}",
            "MOCK_SCHEDULER_STATE": str(state_path),
            "MOCK_SETUP_COUNT": str(setup_count),
            "MOCK_TERMINATE_AFTER_SETUP": "false",
            "MOCK_FAIL_LOG_JOB": "drive-work-sharing-uat" if missing_sharing_200 else "",
            "MOCK_WORKER_ORIGIN": WORKER_ORIGIN,
            "MOCK_CLAMAV_IMAGE": clamav_image,
            "IMAGE_REFERENCE": "gcr.io/hushh-pda-uat/consent-protocol@sha256:" + "a" * 64,
            "DEPLOY_SHA": "b" * 40,
            "RUNTIME_SERVICE_ACCOUNT": ACCOUNT.replace(
                "drive-work-drain-sched", "consent-protocol-runtime"
            ),
            "CLOUDSQL_INSTANCE": "hushh-pda-uat:us-central1:hushh-uat-pg",
            "RELEASE_RUN_ID": "12345",
        }
    )
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
    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert setup_count.read_text(encoding="utf-8") == "3", output
    assert state["triggered"] == [
        "drive-work-drain-uat",
        "drive-work-suggestions-uat",
        "drive-work-sharing-uat",
    ]
    if missing_sharing_200:
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
