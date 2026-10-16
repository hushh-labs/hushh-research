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
import sys
from contextlib import contextmanager
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


def serving_revision():
    service = json.loads(
        _cloud(
            "run",
            "services",
            "describe",
            "consent-protocol",
            f"--region={REGION}",
            "--format=json",
        ).stdout
    )
    serving = [r for r in service["status"]["traffic"] if r.get("percent", 0)]
    if len(serving) != 1 or serving[0]["percent"] != 100:
        raise RuntimeError("UAT backend must have one fully serving revision")
    return json.loads(
        _cloud(
            "run",
            "revisions",
            "describe",
            serving[0]["revisionName"],
            f"--region={REGION}",
            "--format=json",
        ).stdout
    )


@contextmanager
def uat_database(revision=None):
    """Use the verified serving revision's database and process-only credentials."""
    from google.cloud.sql.connector import Connector
    from google.oauth2.credentials import Credentials

    revision = revision or serving_revision()
    envs = {
        item["name"]: item for item in revision["spec"]["containers"][0].get("env", [])
    }

    def value(name):
        entry = envs.get(name, {})
        if "value" in entry:
            return entry["value"]
        ref = entry.get("valueFrom", {}).get("secretKeyRef", {})
        return (
            _cloud(
                "secrets", "versions", "access", ref["key"], f"--secret={ref['name']}"
            ).stdout.strip()
            if ref
            else None
        )

    config = json.loads(value(SECRET) or "{}")
    instance = config.get("cloudsql_instance_connection_name")
    if (
        config.get("environment") != "uat"
        or instance != f"{PROJECT}:{REGION}:hushh-uat-pg"
    ):
        raise RuntimeError("UAT database pin does not match")
    token = _cloud("auth", "print-access-token").stdout.strip()
    with Connector(
        credentials=Credentials(token=token), refresh_strategy="LAZY"
    ) as connector:
        connection = connector.connect(
            instance,
            "pg8000",
            user=value("DB_USER"),
            password=value("DB_PASSWORD"),
            db=config.get("db_name") or "postgres",
            timeout=15,
        )
        try:
            yield connection
        finally:
            connection.rollback()
            connection.close()


def configure_prizes(*, apply: bool, sha: str | None) -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "consent-protocol"))
    from db.referral_prize_activation import activate_weekly_prizes_sql

    revision = serving_revision()
    if apply:
        if not sha:
            raise RuntimeError(
                "Prize activation requires the verified deployed main SHA"
            )
        labels = revision["metadata"].get("labels", {})
        local_sha = subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True
        ).stdout.strip()
        if labels.get("deploy-sha") != sha or local_sha != sha:
            raise RuntimeError(
                "Activation code and serving UAT revision must match the verified SHA"
            )
        root = Path(__file__).resolve().parents[2]
        for relative in (
            "consent-protocol/db/referral_prize_activation.py",
            "consent-protocol/db/migration_authority.py",
            "scripts/ops/configure_referral_uat.py",
        ):
            committed = subprocess.run(
                ["git", "show", f"{sha}:{relative}"],
                capture_output=True,
                text=True,
                check=False,
            )
            if (
                committed.returncode
                or committed.stdout != (root / relative).read_text()
            ):
                raise RuntimeError(
                    "Activation source must be committed in the deployed SHA"
                )
    try:
        with uat_database(revision) as connection:
            cursor = connection.cursor()
            if apply:
                cursor.execute("SET LOCAL lock_timeout='5s'")
                cursor.execute("SET LOCAL statement_timeout='30s'")
                cursor.execute(activate_weekly_prizes_sql())
                connection.commit()
            else:
                cursor.execute("SET TRANSACTION READ ONLY")
            cursor.execute(
                "SELECT version,feature_active FROM one_referral_program_settings WHERE activated_at IS NOT NULL AND retired_at IS NULL"
            )
            version, active = cursor.fetchone()
            print(
                json.dumps(
                    {
                        "environment": "uat",
                        "settings_version": version,
                        "weekly_prizes_enabled": active,
                        "applied": apply,
                    }
                )
            )
    except Exception as exc:  # noqa: BLE001 -- driver errors may contain credentials
        raise RuntimeError(
            f"UAT prize operation failed: {type(exc).__name__}"
        ) from None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("config", "scheduler", "prizes"))
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--sha")
    args = parser.parse_args()
    if args.phase == "config":
        configure_runtime()
    elif args.phase == "scheduler":
        configure_scheduler(run=args.run)
    else:
        configure_prizes(apply=args.apply, sha=args.sha)


if __name__ == "__main__":
    main()
