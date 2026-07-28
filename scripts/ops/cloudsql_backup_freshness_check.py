#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Production Cloud SQL backup freshness gate.

Production recovery is provided by Cloud SQL automated backups plus
point-in-time recovery (PITR) on the production instance. This check replaces
the retired GCS logical-backup freshness gate: it asserts that the instance
still has backups and PITR enabled, and that the most recent successful
automated backup is within the allowed age before a production deploy runs.

Exit codes:
  0 - posture is healthy (or --warn-only was requested)
  1 - posture is stale/misconfigured and the deploy must not proceed
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


def _run_gcloud(args: list[str]) -> str:
    result = subprocess.run(
        ["gcloud", *args],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"gcloud {' '.join(args)} failed: {result.stderr.strip() or result.stdout.strip()}"
        )
    return result.stdout


def _parse_timestamp(value: str) -> datetime | None:
    raw = (value or "").strip()
    if not raw:
        return None
    # Cloud SQL emits RFC3339 with a trailing Z or an explicit offset.
    normalized = raw.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def build_report(project_id: str, instance: str, max_age_hours: int) -> dict[str, Any]:
    now = datetime.now(tz=timezone.utc)

    describe_raw = _run_gcloud(
        [
            "sql",
            "instances",
            "describe",
            instance,
            f"--project={project_id}",
            "--format=json",
        ]
    )
    describe = json.loads(describe_raw)
    backup_config = (describe.get("settings") or {}).get("backupConfiguration") or {}
    backups_enabled = bool(backup_config.get("enabled"))
    pitr_enabled = bool(backup_config.get("pointInTimeRecoveryEnabled"))

    backups_raw = _run_gcloud(
        [
            "sql",
            "backups",
            "list",
            f"--instance={instance}",
            f"--project={project_id}",
            "--limit=20",
            "--format=json",
        ]
    )
    backups = json.loads(backups_raw) or []
    successful = [b for b in backups if str(b.get("status", "")).upper() == "SUCCESSFUL"]

    latest: dict[str, Any] | None = None
    latest_at: datetime | None = None
    for backup in successful:
        stamp = _parse_timestamp(
            str(backup.get("endTime") or backup.get("windowStartTime") or "")
        )
        if stamp and (latest_at is None or stamp > latest_at):
            latest_at = stamp
            latest = backup

    age_hours: float | None = None
    if latest_at is not None:
        age_hours = (now - latest_at).total_seconds() / 3600.0

    failures: list[str] = []
    if not backups_enabled:
        failures.append("Automated backups are disabled on the production instance.")
    if not pitr_enabled:
        failures.append("Point-in-time recovery is disabled on the production instance.")
    if latest_at is None:
        failures.append("No successful automated backup was found.")
    elif age_hours is not None and age_hours > max_age_hours:
        failures.append(
            f"Latest successful backup is {age_hours:.1f}h old (max {max_age_hours}h)."
        )

    return {
        "status": "ok" if not failures else "stale",
        "checked_at": now.isoformat(),
        "project_id": project_id,
        "instance": instance,
        "backups_enabled": backups_enabled,
        "point_in_time_recovery_enabled": pitr_enabled,
        "retained_backups": (backup_config.get("backupRetentionSettings") or {}).get(
            "retainedBackups"
        ),
        "transaction_log_retention_days": backup_config.get("transactionLogRetentionDays"),
        "max_age_hours": max_age_hours,
        "latest_backup": {
            "id": str(latest.get("id")) if latest else None,
            "completed_at": latest_at.isoformat() if latest_at else None,
            "age_hours": round(age_hours, 2) if age_hours is not None else None,
            "type": latest.get("type") if latest else None,
        },
        "failures": failures,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify production Cloud SQL backup + PITR posture before deploy."
    )
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--instance", required=True, help="Cloud SQL instance name")
    parser.add_argument("--max-age-hours", type=int, default=30)
    parser.add_argument("--report-path", default="")
    parser.add_argument(
        "--warn-only",
        action="store_true",
        help="Report posture without failing the deploy.",
    )
    args = parser.parse_args()

    try:
        report = build_report(args.project_id, args.instance, args.max_age_hours)
    except Exception as exc:  # noqa: BLE001 - surface the reason to the deploy log
        report = {
            "status": "error",
            "error": str(exc),
            "project_id": args.project_id,
            "instance": args.instance,
            "failures": [f"Backup posture check failed to run: {exc}"],
        }

    if args.report_path:
        path = Path(args.report_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(json.dumps(report, indent=2))

    if report.get("failures") and not args.warn_only:
        for failure in report["failures"]:
            print(f"BACKUP POSTURE FAILURE: {failure}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
