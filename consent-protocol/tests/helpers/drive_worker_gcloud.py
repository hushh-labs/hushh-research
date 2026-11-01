"""Synthetic CLI transport for worker release and cancellation contracts."""

import os
import sys
from pathlib import Path


def write_executables(directory: Path, sources: dict[str, str]) -> Path:
    """Keep synthetic CLI creation identical across release and resume probes."""
    directory.mkdir(exist_ok=True)
    for name, source in sources.items():
        executable = directory / name
        executable.write_text(source, encoding="utf-8")
        executable.chmod(0o755)
    return directory


def write_worker_gcloud_fixture(fake_bin: Path) -> None:
    import shlex
    import sys

    fake_bin.mkdir()
    fake_gcloud = fake_bin / "gcloud.py"
    fake_gcloud.write_text(
        """#!/usr/bin/env python3
import json
import os
import re
import shutil
import subprocess
import sys

args = sys.argv[1:]
with open(os.environ["MOCK_GCLOUD_CALLS"], "a", encoding="utf-8") as log:
    log.write(json.dumps(args) + "\\n")
command = [arg for arg in args if arg != "--quiet"]
state = os.environ["MOCK_WORKER_STATE"]
if command[:4] == ["run", "services", "describe", "consent-protocol"]:
    print(json.dumps({"status": {"traffic": [{"revisionName": "consent-protocol-01234-api", "percent": 100}]}}))
elif command[:4] == ["run", "revisions", "describe", "consent-protocol-01234-api"]:
    print(json.dumps({
        "metadata": {"name": "consent-protocol-01234-api"},
        "spec": {"serviceAccountName": os.environ["RUNTIME_SERVICE_ACCOUNT"], "containers": [{
            "image": os.environ["IMAGE_REFERENCE"],
            "env": [{"name": key, "value": value} for key, value in {
                "HUSHH_DEPLOY_SHA": os.environ["DEPLOY_SHA"],
                "HUSHH_DEPLOY_RUN_ID": os.environ["RELEASE_RUN_ID"],
                "HUSHH_DEPLOY_ENV": "uat", "HUSHH_UAT_MANAGED_TEXT_PROVIDER": "azure_openai", "HUSHH_UAT_MANAGED_AI_PROVIDER": "azure_openai",
            }.items()],
        }]}, "status": {"conditions": [{"type": "Ready", "status": "True"}]},
    }))
elif command[:3] == ["run", "services", "list"]:
    if state == "list_error":
        sys.exit(77)
    names = ["consent-protocol-drive-worker"] if state in ("existing", "ambiguous", "failed_first_create") else []
    print(json.dumps([{"metadata": {"name": name}} for name in names]))
elif command[:3] == ["run", "services", "describe"]:
    traffic = ([{"revisionName": "worker-previous-00001", "percent": 100}]
               if state == "existing" else
               [{"revisionName": "worker-previous-00001", "percent": 50},
                {"revisionName": "worker-previous-00002", "percent": 50}]
               if state == "ambiguous" else [])
    if "--format=value(status.url)" in command:
        print("https://consent-protocol-drive-worker-abc.a.run.app")
    else:
        print(json.dumps({"status": {"traffic": traffic, "url": "https://consent-protocol-drive-worker-abc.a.run.app"}}))
elif command[:3] == ["scheduler", "jobs", "list"]:
    print(os.environ["MOCK_SCHEDULER_JOB"])
elif command[:3] == ["scheduler", "jobs", "describe"]:
    if "--format=json" in command:
        print(json.dumps(json.loads(os.environ["MOCK_SCHEDULER_JOB"])[0]))
    else:
        sys.exit(78)
elif command[:2] == ["run", "deploy"]:
    if state == "cancel_during_deploy":
        subprocess.run([shutil.which("bash") or "bash", "-c", 'kill -TERM "$1"', "signal", os.environ["MOCK_WORKER_PARENT_PID"]], check=True)
        sys.exit(0)
    sys.exit(79)
else:
    sys.exit(80)
""",
        encoding="utf-8",
    )
    shell = fake_bin / "gcloud"
    shell.write_text(
        '#!/usr/bin/env bash\nexport MOCK_WORKER_PARENT_PID="$PPID"\n'
        f'exec {shlex.quote(sys.executable)} "$(dirname "$0")/gcloud.py" "$@"\n'
    )
    shell.chmod(0o755)
    if os.name == "nt":
        (fake_bin / "gcloud.cmd").write_text(
            f'@"{sys.executable}" "%~dp0gcloud.py" %*\n', encoding="utf-8", newline=""
        )


FAKE_GCLOUD = """#!/usr/bin/env python3
import base64
import json
import os
import sys
from datetime import datetime
from pathlib import Path

args = [arg for arg in sys.argv[1:] if arg != "--quiet"]
state_path = Path(os.environ["MOCK_SCHEDULER_STATE"])
state = json.loads(state_path.read_text())
jobs = state["jobs"]

def flag(name, default=None):
    return next((item.split("=", 1)[1] for item in args if item.startswith(name + "=")), default)

def save():
    state_path.write_text(json.dumps(state, sort_keys=True))

if args[:4] == ["run", "services", "describe", "consent-protocol"]:
    print(json.dumps({"status": {"traffic": [{"revisionName": "consent-protocol-01234-api", "percent": 100}]}}))
elif args[:4] == ["run", "revisions", "describe", "consent-protocol-01234-api"]:
    print(json.dumps({
        "metadata": {"name": "consent-protocol-01234-api"},
        "spec": {"serviceAccountName": os.environ["RUNTIME_SERVICE_ACCOUNT"], "containers": [{
            "image": os.environ["IMAGE_REFERENCE"],
            "env": [{"name": key, "value": value} for key, value in {
                "HUSHH_DEPLOY_SHA": os.environ["DEPLOY_SHA"],
                "HUSHH_DEPLOY_RUN_ID": os.environ["RELEASE_RUN_ID"],
                "HUSHH_DEPLOY_ENV": "uat", "HUSHH_UAT_MANAGED_TEXT_PROVIDER": "azure_openai", "HUSHH_UAT_MANAGED_AI_PROVIDER": "azure_openai",
            }.items()],
        }]}, "status": {"conditions": [{"type": "Ready", "status": "True"}]},
    }))
elif args[:3] == ["run", "services", "list"]:
    print(json.dumps([{"metadata": {"name": "consent-protocol-drive-worker"}}]
                     if state.get("existing_worker") else []))
elif args[:3] == ["run", "services", "describe"]:
    if "--format=value(status.latestCreatedRevisionName)" in args:
        print("consent-protocol-drive-worker-00001-abc")
    elif "--format=value(status.url)" in args:
        print(os.environ["MOCK_WORKER_ORIGIN"])
    elif "--format=json" in args:
        print(json.dumps({"status": {"url": os.environ["MOCK_WORKER_ORIGIN"],
                         "traffic": [{"revisionName": "worker-previous-00001", "percent": 100}]}}))
    else:
        sys.exit(70)
elif args[:3] == ["run", "revisions", "describe"]:
    # A revision reports its own scale. The service-level floor stays on the
    # service, and Cloud Run omits a zero revision floor.
    scaling = state.get("deployed_scaling", {})
    annotations = {"autoscaling.knative.dev/maxScale": scaling.get("--max-instances")}
    if scaling.get("--min-instances") not in (None, "0"):
        annotations["autoscaling.knative.dev/minScale"] = scaling["--min-instances"]
    print(json.dumps({
        "metadata": {"labels": {"deploy-sha": os.environ["DEPLOY_SHA"]},
                     "annotations": annotations},
        "spec": {"containerConcurrency": int(scaling.get("--concurrency") or 0),
                 "containers": [
            {"name": "drive-worker", "image": os.environ["IMAGE_REFERENCE"],
             "env": [{"name": "DRIVE_WORK_DRAIN_ENABLED",
                      "value": state.get("deployed_drain_enabled", "true")},
                     {"name": "DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER",
                      "value": state["deployed_semantic_model_provider"]},
                     {"name": "DRIVE_REQUEST_ACTIVITY_UNION_ENABLED",
                      "value": state["deployed_activity_union_enabled"]},
                     {"name": "DRIVE_REQUEST_ACTIVITY_UNION_PAUSED",
                      "value": state["deployed_activity_union_paused"]},
                     {"name": "HUSHH_UAT_MANAGED_TEXT_PROVIDER",
                      "value": state["deployed_managed_text_provider"]},
                     {"name": "HUSHH_UAT_MANAGED_AI_PROVIDER",
                      "value": state["deployed_managed_ai_provider"]}]},
            {"name": "clamav", "image": os.environ["MOCK_CLAMAV_IMAGE"]},
        ]},
        "status": {"conditions": [{"type": "Ready", "status": "True"}]},
    }))
elif args[:2] == ["run", "deploy"]:
    state["deployed_managed_text_provider"] = flag("--set-env-vars").split("HUSHH_UAT_MANAGED_TEXT_PROVIDER=", 1)[1].split("|", 1)[0]
    state["deployed_managed_ai_provider"] = flag("--set-env-vars").split("HUSHH_UAT_MANAGED_AI_PROVIDER=", 1)[1].split("|", 1)[0]
    state["deployed_drain_enabled"] = flag("--set-env-vars").split("DRIVE_WORK_DRAIN_ENABLED=", 1)[1].split("|", 1)[0]
    state["deployed_semantic_model_provider"] = flag("--set-env-vars").split("DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER=", 1)[1].split("|", 1)[0]
    state["deployed_activity_union_enabled"] = flag("--set-env-vars").split("DRIVE_REQUEST_ACTIVITY_UNION_ENABLED=", 1)[1].split("|", 1)[0]
    state["deployed_activity_union_paused"] = flag("--set-env-vars").split("DRIVE_REQUEST_ACTIVITY_UNION_PAUSED=", 1)[1].split("|", 1)[0]
    state["deployed_scaling"] = {
        name: flag(name)
        for name in ("--concurrency", "--max-instances", "--min-instances", "--max", "--min")
    }
    save()
elif args[:3] in (
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
    elif "--format=value(state)" in args:
        print(job["state"])
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
    if args[2] == "resume":
        mutation = os.environ.get("MOCK_RESUME_DRIFT", "")
        if mutation == "state":
            jobs[args[3]]["state"] = "PAUSED"
        elif mutation == "audience":
            jobs[args[3]]["httpTarget"]["oidcToken"]["audience"] = "https://foreign.invalid"
        elif mutation == "body":
            jobs[args[3]]["httpTarget"]["body"] = base64.b64encode(b'{"stage":"documents"}').decode()
    save()
elif args[:3] == ["scheduler", "jobs", "run"]:
    state.setdefault("triggered", []).append(args[3])
    save()
elif args[:2] == ["logging", "read"]:
    # Every authorized trigger must precede receipt polling; otherwise the
    # release pays an independent log-indexing wait for each stage.
    state.setdefault("first_log_triggered", list(state.get("triggered", [])))
    query = args[2]
    timestamp_term = next((term.strip() for term in query.split(" AND ")
                           if term.strip().startswith("timestamp>=")), "")
    job = next((name for name in jobs
                if 'resource.labels.job_id="' + name + '"' in query), "")
    timestamp_value = timestamp_term.removeprefix("timestamp>=")
    try:
        timestamp_valid = (timestamp_value.startswith('"')
                           and timestamp_value.endswith('"')
                           and datetime.fromisoformat(timestamp_value[1:-1]).strftime(
                               "%Y-%m-%dT%H:%M:%SZ") == timestamp_value[1:-1])
    except ValueError:
        timestamp_valid = False
    if not timestamp_valid or not job or "--format=json" not in args:
        print("invalid Cloud Logging filter or output format", file=sys.stderr)
        sys.exit(76)
    reads = state.setdefault("log_reads", {})
    reads[job] = reads.get(job, 0) + 1
    save()
    if (job == os.environ.get("MOCK_MISSING_LOG_JOB")
        or (job == os.environ.get("MOCK_DEFER_LOG_JOB") and reads[job] == 1)):
        print("[]")
    elif job in state.get("triggered", []):
        url = jobs[job]["httpTarget"]["uri"]
        if job == os.environ.get("MOCK_FAIL_LOG_JOB"):
            # A stale success against the old API must not attest the worker.
            url = "https://api.uat.hushh.ai/api/internal/drive-work/drain"
        print(json.dumps([{"jsonPayload": {
            "@type": "type.googleapis.com/google.cloud.scheduler.logging.AttemptFinished",
            "jobName": "projects/hushh-pda-uat/locations/us-central1/jobs/" + job,
            "url": url,
            "debugInfo": "URL_CRAWLED. Original HTTP response code number = 200",
        }}]))
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


def worker_release_environment(fake_bin, state_path, setup_count, *, origin, scanner_image):
    """One synthetic release identity for the success and rollback rehearsals."""
    environment = os.environ.copy()
    environment.update(
        {
            "PATH": f"{fake_bin}:{Path(sys.executable).parent}:{environment['PATH']}",
            "MOCK_SCHEDULER_STATE": str(state_path),
            "MOCK_SETUP_COUNT": str(setup_count),
            "MOCK_TERMINATE_AFTER_SETUP": "true",
            "MOCK_WORKER_ORIGIN": origin,
            "MOCK_CLAMAV_IMAGE": scanner_image,
            "IMAGE_REFERENCE": "gcr.io/hushh-pda-uat/consent-protocol@sha256:" + "a" * 64,
            "DEPLOY_SHA": "b" * 40,
            "RUNTIME_SERVICE_ACCOUNT": "consent-protocol-runtime@hushh-pda-uat.iam.gserviceaccount.com",
            "CLOUDSQL_INSTANCE": "hushh-pda-uat:us-central1:hushh-uat-pg",
            "RELEASE_RUN_ID": "12345",
        }
    )
    return environment
