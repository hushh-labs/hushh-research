#!/usr/bin/env python3
"""Generate a production migration release manifest artifact.

The manifest is immutable release evidence for DB governance:
- git SHA
- migration files included in the release
- operator
- timestamp
- pre-deploy backup evidence metadata
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCRIPT_PATH = Path(__file__).resolve()
REPO_ROOT = SCRIPT_PATH.parents[2]
DEFAULT_MIGRATIONS_DIR = REPO_ROOT / "consent-protocol" / "db" / "migrations"
MIGRATION_PATTERN = re.compile(r"^(?P<version>\d{3,})_[a-z0-9_]+\.sql$")


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _git_sha(explicit_sha: str) -> str:
    if explicit_sha:
        return explicit_sha.strip()
    if os.getenv("GITHUB_SHA"):
        return str(os.getenv("GITHUB_SHA")).strip()

    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        check=False,
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )
    if result.returncode == 0:
        return result.stdout.strip()
    return "unknown"


def _read_backup_report(path: Path | None) -> dict[str, Any] | None:
    if path is None:
        return None
    if not path.exists():
        return None
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _extract_backup_evidence(report: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(report, dict):
        return {
            "backup_report_status": None,
            "backup_object_uri": None,
            "backup_checksum_sha256": None,
            "backup_completed_at": None,
        }

    latest = report.get("latest_backup")
    latest_dict = latest if isinstance(latest, dict) else {}

    return {
        "backup_report_status": report.get("status"),
        "backup_object_uri": latest_dict.get("backup_object_uri")
        or report.get("backup_object_uri"),
        "backup_checksum_sha256": latest_dict.get("checksum_sha256")
        or report.get("checksum_sha256"),
        "backup_completed_at": latest_dict.get("backup_completed_at")
        or report.get("backup_completed_at"),
    }


def _collect_migrations(migrations_dir: Path) -> tuple[list[dict[str, Any]], str]:
    matched: list[tuple[int, str, Path]] = []
    for path in migrations_dir.iterdir():
        if not path.is_file():
            continue
        match = MIGRATION_PATTERN.match(path.name)
        if not match:
            continue
        matched.append((int(match.group("version")), path.name, path))

    matched.sort(key=lambda item: (item[0], item[1]))
    records: list[dict[str, Any]] = []
    digest = hashlib.sha256()
    for version, filename, path in matched:
        content = path.read_bytes()
        file_sha = hashlib.sha256(content).hexdigest()
        records.append(
            {
                "version": version,
                "filename": filename,
                "sha256": file_sha,
                "bytes": len(content),
            }
        )
        digest.update(filename.encode("utf-8"))
        digest.update(b"\0")
        digest.update(file_sha.encode("utf-8"))
        digest.update(b"\0")
    return records, digest.hexdigest()


def run(args: argparse.Namespace) -> int:
    migrations_dir = Path(args.migrations_dir).resolve()
    output_path = Path(args.output).resolve()
    backup_report_path = (
        Path(args.backup_report_path).resolve() if args.backup_report_path else None
    )

    if not migrations_dir.exists():
        print(f"ERROR: migrations directory not found: {migrations_dir}", file=sys.stderr)
        return 2

    migration_records, manifest_hash = _collect_migrations(migrations_dir)
    if not migration_records:
        print("ERROR: no versioned migrations found", file=sys.stderr)
        return 2

    backup_report = _read_backup_report(backup_report_path)
    backup_evidence = _extract_backup_evidence(backup_report)

    manifest = {
        "manifest_type": "prod_migration_release_manifest",
        "generated_at": _utc_now_iso(),
        "environment": args.environment,
        "operator": args.operator or os.getenv("GITHUB_ACTOR") or os.getenv("USER") or "unknown",
        "git_sha": _git_sha(args.git_sha),
        "release": {
            "workflow": os.getenv("GITHUB_WORKFLOW", ""),
            "run_id": os.getenv("GITHUB_RUN_ID", ""),
            "run_attempt": os.getenv("GITHUB_RUN_ATTEMPT", ""),
            "ref": os.getenv("GITHUB_REF", ""),
        },
        "backup_gate": {
            "backup_report_path": str(backup_report_path) if backup_report_path else "",
            "backup_report_status": backup_evidence.get("backup_report_status"),
            "backup_object_uri": backup_evidence.get("backup_object_uri"),
            "backup_checksum_sha256": backup_evidence.get("backup_checksum_sha256"),
            "backup_completed_at": backup_evidence.get("backup_completed_at"),
        },
        "migrations": {
            "dir": str(migrations_dir),
            "count": len(migration_records),
            "highest_version": max(record["version"] for record in migration_records),
            "manifest_hash": manifest_hash,
            "files": migration_records,
        },
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Wrote migration release manifest: {output_path}")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate release manifest for production DB governance."
    )
    parser.add_argument(
        "--output",
        required=True,
        help="Output JSON file path.",
    )
    parser.add_argument(
        "--migrations-dir",
        default=str(DEFAULT_MIGRATIONS_DIR),
        help=f"Migration SQL directory (default: {DEFAULT_MIGRATIONS_DIR}).",
    )
    parser.add_argument(
        "--environment",
        default="production",
        help="Environment label for manifest metadata.",
    )
    parser.add_argument(
        "--backup-report-path",
        default="",
        help="Optional backup gate JSON report path.",
    )
    parser.add_argument(
        "--operator",
        default="",
        help="Optional operator identity override.",
    )
    parser.add_argument(
        "--git-sha",
        default="",
        help="Optional git SHA override.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    sys.exit(run(parse_args()))
