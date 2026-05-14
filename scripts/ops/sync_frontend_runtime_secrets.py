#!/usr/bin/env python3
"""Sync canonical frontend runtime secrets into GCP Secret Manager."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
UPSERT_SECRET_SCRIPT = REPO_ROOT / "scripts" / "ops" / "upsert_gcp_secret.py"


def _run(cmd: list[str], *, input_text: str | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        cmd,
        input=input_text,
        text=True,
        capture_output=True,
    )
    if check and result.returncode != 0:
        sys.stderr.write(result.stderr or result.stdout)
        raise SystemExit(result.returncode)
    return result


def _read_secret(project: str, secret: str) -> str:
    result = _run(
        [
            "gcloud",
            "secrets",
            "versions",
            "access",
            "latest",
            "--secret",
            secret,
            "--project",
            project,
        ],
        check=False,
    )
    if result.returncode != 0:
        return ""
    return (result.stdout or "").strip()


def _resolve_first(project: str, names: tuple[str, ...]) -> str:
    for name in names:
        value = _read_secret(project, name)
        if value:
            return value
    return ""


def _upsert_secret(project: str, secret: str, value: str) -> None:
    _run(
        [
            sys.executable,
            str(UPSERT_SECRET_SCRIPT),
            "--project",
            project,
            "--secret",
            secret,
            "--stdin",
        ],
        input_text=value,
    )


def _measurement_secret_names(environment: str) -> tuple[str, ...]:
    if environment == "production":
        return (
            "NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID",
            "NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_PRODUCTION",
        )
    return (
        "NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID",
        "NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_UAT",
        "NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_STAGING",
    )


def _gtm_secret_names(environment: str) -> tuple[str, ...]:
    if environment == "production":
        return (
            "NEXT_PUBLIC_GTM_ID",
            "NEXT_PUBLIC_GTM_ID_PRODUCTION",
        )
    return (
        "NEXT_PUBLIC_GTM_ID",
        "NEXT_PUBLIC_GTM_ID_UAT",
        "NEXT_PUBLIC_GTM_ID_STAGING",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument(
        "--environment",
        required=True,
        choices=("uat", "production"),
        help="Deploy environment used to resolve legacy measurement/GTM secret names.",
    )
    args = parser.parse_args()

    sync_summary: list[str] = []

    measurement_id = _resolve_first(args.project, _measurement_secret_names(args.environment))
    if measurement_id:
        _upsert_secret(args.project, "NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID", measurement_id)
        sync_summary.append("NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID")

    gtm_id = _resolve_first(args.project, _gtm_secret_names(args.environment))
    if gtm_id:
        _upsert_secret(args.project, "NEXT_PUBLIC_GTM_ID", gtm_id)
        sync_summary.append("NEXT_PUBLIC_GTM_ID")

    print(
        json.dumps(
            {
                "project": args.project,
                "environment": args.environment,
                "synced_secrets": sorted(sync_summary),
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
