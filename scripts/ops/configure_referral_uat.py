"""Activate the existing UAT referral runtime config or install its bounded scheduler.

Seed config before the governed deployment; install/run the scheduler only after
the exact deployed revision and migration have been verified. No production target
or arbitrary token audience is accepted. Secret payloads remain process-only.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from pathlib import Path

from sync_backend_runtime_secrets import _retained_referral_config

PROJECT = "hushh-pda-uat"
REGION = "us-central1"
ORIGIN = "https://api.uat.hushh.ai"
ACCOUNT_ID = "referral-scoring-sched"
ACCOUNT = f"{ACCOUNT_ID}@{PROJECT}.iam.gserviceaccount.com"
JOB = "referral-scoring-drain-uat"
SECRET = "BACKEND_RUNTIME_CONFIG_JSON"


def _cloud(*args: str, check: bool = True, payload: str | None = None):
    executable = shutil.which("gcloud") or shutil.which("gcloud.cmd")
    if not executable:
        raise RuntimeError("gcloud is required")
    result = subprocess.run(
        [executable, *args, f"--project={PROJECT}"],
        input=payload,
        text=True,
        capture_output=True,
        check=False,
    )
    if check and result.returncode:
        raise RuntimeError(
            f"UAT operation {args[0]} {args[1]} failed; exit={result.returncode}"
        )
    return result


def configure_runtime() -> None:
    raw = _cloud("secrets", "versions", "access", "latest", f"--secret={SECRET}").stdout
    config = json.loads(raw)
    if not isinstance(config, dict) or config.get("environment") != "uat":
        raise RuntimeError("Existing runtime config is not UAT")
    if (
        config.get("cloudsql_instance_connection_name")
        != "hushh-pda-uat:us-central1:hushh-uat-pg"
    ):
        raise RuntimeError("UAT database instance pin does not match")
    config.update(
        {
            "referral_scoring_drain_enabled": True,
            "referral_scoring_drain_scheduler_audience": ORIGIN,
            "referral_scoring_drain_scheduler_project_id": PROJECT,
            "referral_scoring_drain_scheduler_service_account_email": ACCOUNT,
        }
    )
    _retained_referral_config(config, project=PROJECT, environment="uat")
    next_payload = json.dumps(config, separators=(",", ":"), sort_keys=True)
    if json.loads(raw) != config:
        # Existing secret/write primitive; no file or command-line payload.
        import sys

        result = subprocess.run(
            [
                sys.executable,
                str(Path(__file__).with_name("upsert_gcp_secret.py")),
                "--project",
                PROJECT,
                "--secret",
                SECRET,
                "--stdin",
            ],
            input=next_payload,
            text=True,
            capture_output=True,
            check=False,
        )
        if result.returncode:
            raise RuntimeError("UAT runtime config write failed")
    print("UAT referral runtime configuration verified; payload withheld")


def configure_scheduler(*, run: bool) -> None:
    # The public UAT gateway verifies this OIDC identity in application code.
    # Cloud Scheduler's managed service agent already owns token minting;
    # this operator does not broaden project or service-account IAM grants.
    if _cloud("iam", "service-accounts", "describe", ACCOUNT, check=False).returncode:
        _cloud(
            "iam",
            "service-accounts",
            "create",
            ACCOUNT_ID,
            "--display-name=UAT referral scoring scheduler",
        )
    exists = (
        _cloud(
            "scheduler", "jobs", "describe", JOB, f"--location={REGION}", check=False
        ).returncode
        == 0
    )
    _cloud(
        "scheduler",
        "jobs",
        "update" if exists else "create",
        "http",
        JOB,
        f"--location={REGION}",
        "--schedule=* * * * *",
        "--time-zone=Etc/UTC",
        f"--uri={ORIGIN}/api/internal/referral-scoring/drain",
        "--http-method=POST",
        "--message-body={}",
        f"--oidc-service-account-email={ACCOUNT}",
        f"--oidc-token-audience={ORIGIN}",
        "--attempt-deadline=120s",
        "--max-retry-attempts=3",
        "--min-backoff=10s",
        "--max-backoff=120s",
        "--max-doublings=3",
        "--update-headers=Content-Type=application/json"
        if exists
        else "--headers=Content-Type=application/json",
    )
    evidence = json.loads(
        _cloud(
            "scheduler",
            "jobs",
            "describe",
            JOB,
            f"--location={REGION}",
            "--format=json",
        ).stdout
    )
    target = evidence.get("httpTarget", {})
    if (
        evidence.get("state"),
        evidence.get("schedule"),
        target.get("uri"),
        target.get("httpMethod"),
        target.get("oidcToken"),
    ) != (
        "ENABLED",
        "* * * * *",
        f"{ORIGIN}/api/internal/referral-scoring/drain",
        "POST",
        {"serviceAccountEmail": ACCOUNT, "audience": ORIGIN},
    ):
        raise RuntimeError("UAT scheduler does not match its fixed contract")
    if run:
        _cloud("scheduler", "jobs", "run", JOB, f"--location={REGION}")
    print(f"UAT scheduler {JOB} verified; run_requested={run}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("config", "scheduler"))
    parser.add_argument("--run", action="store_true")
    args = parser.parse_args()
    if args.phase == "config":
        configure_runtime()
    else:
        configure_scheduler(run=args.run)


if __name__ == "__main__":
    main()
