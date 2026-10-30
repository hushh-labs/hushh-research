"""Source and installed-contract qualification for lifecycle release activation."""

from __future__ import annotations

import json
import re
import runpy
from pathlib import Path

POLICY = "consent-protocol/config/account-deletion-authority.json"
MIGRATION = "423_account_shared_provider_authority.sql"
PHONE_MIGRATION = "425_account_phone_transfers.sql"
PHONE_ACTION_MIGRATION = "431_phone_recovery_actions.sql"


def supports_current_contract(sha: str, *, run, rollback: bool = False) -> bool:
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        return False
    try:
        policy = json.loads(run(["git", "show", f"{sha}:{POLICY}"]))
        manifest = json.loads(
            run(
                [
                    "git",
                    "show",
                    f"{sha}:consent-protocol/db/release_migration_manifest.json",
                ]
            )
        )
        migrations = manifest.get("ordered_migrations", [])
        return (
            policy.get("version") == 1
            and MIGRATION in migrations
            and (
                not rollback
                or all(
                    name in migrations
                    for name in (PHONE_MIGRATION, PHONE_ACTION_MIGRATION)
                )
            )
        )
    except (RuntimeError, ValueError):
        return False


def restoration_authority():
    return runpy.run_path(str(Path(__file__).with_name("compatibility_restoration.py")))


def supports_restoration_source(sha: str) -> bool:
    try:
        restoration_authority()["qualify_source"](sha)
        return True
    except (ValueError, RuntimeError, OSError):
        return False


def qualify_restoration_database(args, pg):
    if not getattr(args, "production_restoration", False):
        return
    if args.project != "hushh-pda" or args.db_name != "hushh_vault":
        raise ValueError("restoration_requires_production_target")
    import psycopg2

    authority = restoration_authority()
    record = authority["qualify_source"](args.expected_sha)
    connection = psycopg2.connect(
        host=pg["PGHOST"],
        port=pg["PGPORT"],
        dbname=pg["PGDATABASE"],
        user=pg["PGUSER"],
        password=pg["PGPASSWORD"],
        connect_timeout=10,
    )
    try:
        connection.set_session(readonly=True)
        proof = authority["qualify_schema"](
            connection, record, require_empty_documents=True
        )
        fence = runpy.run_path(
            str(Path(__file__).with_name("document_restoration_fence.py"))
        )
        fence["verify"](
            connection, source=args.expected_sha, run_id=args.expected_run_id
        )
        return {
            **proof,
            "sourceSha": args.expected_sha,
            "runId": args.expected_run_id,
            "documentFence": "verified",
        }
    finally:
        connection.close()


def qualify_cli(argv, current, restoration):
    if len(argv) != 3:
        return False
    if argv[1] == "--qualify-restoration-source":
        if not restoration(argv[2]):
            raise SystemExit("Source is not the exact reviewed production restoration")
        return True
    if argv[1] not in ("--qualify-source", "--qualify-rollback-source"):
        return False
    rollback = argv[1] == "--qualify-rollback-source"
    if not current(argv[2], rollback=rollback):
        raise SystemExit(
            "Target lacks the phone/device admission rollback contract (migrations 425 and 431)"
            if rollback
            else "Target lacks the current account lifecycle producer contract"
        )
    return True
