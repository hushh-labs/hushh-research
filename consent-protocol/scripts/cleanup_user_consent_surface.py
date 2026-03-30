#!/usr/bin/env python3
"""User-scoped consent/invite cleanup with dry-run snapshots.

This script is intended for local and UAT Kai-test-user resets without touching
PKM blobs, vault keys, or other encrypted personal data.

Usage:
  python scripts/cleanup_user_consent_surface.py
  python scripts/cleanup_user_consent_surface.py --user-id <firebase_uid>
  python scripts/cleanup_user_consent_surface.py --apply
  python scripts/cleanup_user_consent_surface.py --apply --report /tmp/kai-consent-cleanup.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import text
from sqlalchemy.exc import OperationalError

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from db.db_client import get_db_connection  # noqa: E402

SAFE_APPLY_ENVIRONMENTS = {"development", "dev", "local", "staging", "uat", "test"}


def _active_environment() -> str:
    return (
        str(
            os.getenv("ENVIRONMENT")
            or os.getenv("ENVIRONMENT_MODE")
            or os.getenv("APP_ENV")
            or "unknown"
        )
        .strip()
        .lower()
    )


def _table_exists(conn, table_name: str) -> bool:
    return bool(
        conn.execute(
            text("SELECT to_regclass(:regclass_name) IS NOT NULL"),
            {"regclass_name": f"public.{table_name}"},
        ).scalar()
    )


def _scalar_int(conn, sql: str, params: dict[str, object]) -> int:
    value = conn.execute(text(sql), params).scalar()
    return int(value or 0)


def _group_rows(conn, sql: str, params: dict[str, object]) -> list[dict[str, object]]:
    return [dict(row) for row in conn.execute(text(sql), params).mappings().all()]


def _load_ria_profile_ids(conn, user_id: str) -> list[str]:
    if not _table_exists(conn, "ria_profiles"):
        return []
    rows = conn.execute(
        text("SELECT id FROM ria_profiles WHERE user_id = :user_id"),
        {"user_id": user_id},
    ).mappings()
    return [str(row["id"]) for row in rows]


def _load_relationship_ids(conn, user_id: str, ria_profile_ids: list[str]) -> list[str]:
    if not _table_exists(conn, "advisor_investor_relationships"):
        return []

    conditions = ["investor_user_id = :user_id"]
    params: dict[str, object] = {"user_id": user_id}
    if ria_profile_ids:
        conditions.append("ria_profile_id::text = ANY(CAST(:ria_profile_ids AS text[]))")
        params["ria_profile_ids"] = ria_profile_ids

    rows = conn.execute(
        text(
            f"""
            SELECT id
            FROM advisor_investor_relationships
            WHERE {" OR ".join(conditions)}
            """
        ),
        params,
    ).mappings()
    return [str(row["id"]) for row in rows]


def _snapshot(conn, user_id: str) -> dict[str, object]:
    ria_profile_ids = _load_ria_profile_ids(conn, user_id)
    relationship_ids = _load_relationship_ids(conn, user_id, ria_profile_ids)

    params = {
        "user_id": user_id,
        "ria_profile_ids": ria_profile_ids or [],
        "relationship_ids": relationship_ids or [],
    }

    snapshot: dict[str, object] = {
        "user_id": user_id,
        "environment": _active_environment(),
        "ria_profile_ids": ria_profile_ids,
        "relationship_ids": relationship_ids,
    }

    if _table_exists(conn, "consent_audit"):
        snapshot["consent_audit"] = {
            "count": _scalar_int(
                conn,
                "SELECT COUNT(*) FROM consent_audit WHERE user_id = :user_id",
                params,
            ),
            "by_action": _group_rows(
                conn,
                """
                SELECT action, COUNT(*)::int AS row_count
                FROM consent_audit
                WHERE user_id = :user_id
                GROUP BY action
                ORDER BY row_count DESC, action ASC
                """,
                params,
            ),
        }

    if _table_exists(conn, "consent_exports"):
        snapshot["consent_exports"] = {
            "count": _scalar_int(
                conn,
                "SELECT COUNT(*) FROM consent_exports WHERE user_id = :user_id",
                params,
            ),
            "by_refresh_status": _group_rows(
                conn,
                """
                SELECT COALESCE(refresh_status, 'unknown') AS refresh_status, COUNT(*)::int AS row_count
                FROM consent_exports
                WHERE user_id = :user_id
                GROUP BY COALESCE(refresh_status, 'unknown')
                ORDER BY row_count DESC, refresh_status ASC
                """,
                params,
            ),
        }

    if _table_exists(conn, "consent_export_refresh_jobs"):
        snapshot["consent_export_refresh_jobs"] = {
            "count": _scalar_int(
                conn,
                "SELECT COUNT(*) FROM consent_export_refresh_jobs WHERE user_id = :user_id",
                params,
            )
        }

    if _table_exists(conn, "ria_client_invites"):
        snapshot["ria_client_invites"] = {
            "count": _scalar_int(
                conn,
                """
                SELECT COUNT(*)
                FROM ria_client_invites
                WHERE target_investor_user_id = :user_id
                   OR accepted_by_user_id = :user_id
                   OR (
                     COALESCE(CARDINALITY(CAST(:ria_profile_ids AS text[])), 0) > 0
                     AND ria_profile_id::text = ANY(CAST(:ria_profile_ids AS text[]))
                   )
                """,
                params,
            ),
            "by_status": _group_rows(
                conn,
                """
                SELECT status, COUNT(*)::int AS row_count
                FROM ria_client_invites
                WHERE target_investor_user_id = :user_id
                   OR accepted_by_user_id = :user_id
                   OR (
                     COALESCE(CARDINALITY(CAST(:ria_profile_ids AS text[])), 0) > 0
                     AND ria_profile_id::text = ANY(CAST(:ria_profile_ids AS text[]))
                   )
                GROUP BY status
                ORDER BY row_count DESC, status ASC
                """,
                params,
            ),
        }

    if _table_exists(conn, "advisor_investor_relationships"):
        snapshot["advisor_investor_relationships"] = {
            "count": _scalar_int(
                conn,
                """
                SELECT COUNT(*)
                FROM advisor_investor_relationships
                WHERE investor_user_id = :user_id
                   OR (
                     COALESCE(CARDINALITY(CAST(:ria_profile_ids AS text[])), 0) > 0
                     AND ria_profile_id::text = ANY(CAST(:ria_profile_ids AS text[]))
                   )
                """,
                params,
            ),
            "by_status": _group_rows(
                conn,
                """
                SELECT status, COUNT(*)::int AS row_count
                FROM advisor_investor_relationships
                WHERE investor_user_id = :user_id
                   OR (
                     COALESCE(CARDINALITY(CAST(:ria_profile_ids AS text[])), 0) > 0
                     AND ria_profile_id::text = ANY(CAST(:ria_profile_ids AS text[]))
                   )
                GROUP BY status
                ORDER BY row_count DESC, status ASC
                """,
                params,
            ),
        }

    if _table_exists(conn, "relationship_share_grants"):
        snapshot["relationship_share_grants"] = {
            "count": _scalar_int(
                conn,
                """
                SELECT COUNT(*)
                FROM relationship_share_grants
                WHERE provider_user_id = :user_id
                   OR receiver_user_id = :user_id
                   OR (
                     COALESCE(CARDINALITY(CAST(:relationship_ids AS text[])), 0) > 0
                     AND relationship_id::text = ANY(CAST(:relationship_ids AS text[]))
                   )
                """,
                params,
            ),
            "by_status": _group_rows(
                conn,
                """
                SELECT status, COUNT(*)::int AS row_count
                FROM relationship_share_grants
                WHERE provider_user_id = :user_id
                   OR receiver_user_id = :user_id
                   OR (
                     COALESCE(CARDINALITY(CAST(:relationship_ids AS text[])), 0) > 0
                     AND relationship_id::text = ANY(CAST(:relationship_ids AS text[]))
                   )
                GROUP BY status
                ORDER BY row_count DESC, status ASC
                """,
                params,
            ),
        }

    if _table_exists(conn, "relationship_share_events"):
        snapshot["relationship_share_events"] = {
            "count": _scalar_int(
                conn,
                """
                SELECT COUNT(*)
                FROM relationship_share_events
                WHERE provider_user_id = :user_id
                   OR receiver_user_id = :user_id
                   OR (
                     COALESCE(CARDINALITY(CAST(:relationship_ids AS text[])), 0) > 0
                     AND relationship_id::text = ANY(CAST(:relationship_ids AS text[]))
                   )
                """,
                params,
            ),
            "by_event_type": _group_rows(
                conn,
                """
                SELECT event_type, COUNT(*)::int AS row_count
                FROM relationship_share_events
                WHERE provider_user_id = :user_id
                   OR receiver_user_id = :user_id
                   OR (
                     COALESCE(CARDINALITY(CAST(:relationship_ids AS text[])), 0) > 0
                     AND relationship_id::text = ANY(CAST(:relationship_ids AS text[]))
                   )
                GROUP BY event_type
                ORDER BY row_count DESC, event_type ASC
                """,
                params,
            ),
        }

    if _table_exists(conn, "user_push_tokens"):
        snapshot["user_push_tokens"] = {
            "count": _scalar_int(
                conn,
                "SELECT COUNT(*) FROM user_push_tokens WHERE user_id = :user_id",
                params,
            )
        }

    if _table_exists(conn, "internal_access_events"):
        snapshot["internal_access_events"] = {
            "count": _scalar_int(
                conn,
                "SELECT COUNT(*) FROM internal_access_events WHERE user_id = :user_id",
                params,
            )
        }

    return snapshot


def _apply_cleanup(conn, user_id: str) -> None:
    ria_profile_ids = _load_ria_profile_ids(conn, user_id)
    relationship_ids = _load_relationship_ids(conn, user_id, ria_profile_ids)
    params = {
        "user_id": user_id,
        "ria_profile_ids": ria_profile_ids or [],
        "relationship_ids": relationship_ids or [],
    }

    if _table_exists(conn, "relationship_share_events"):
        conn.execute(
            text(
                """
                DELETE FROM relationship_share_events
                WHERE provider_user_id = :user_id
                   OR receiver_user_id = :user_id
                   OR (
                     COALESCE(CARDINALITY(CAST(:relationship_ids AS text[])), 0) > 0
                     AND relationship_id::text = ANY(CAST(:relationship_ids AS text[]))
                   )
                """
            ),
            params,
        )

    if _table_exists(conn, "relationship_share_grants"):
        conn.execute(
            text(
                """
                DELETE FROM relationship_share_grants
                WHERE provider_user_id = :user_id
                   OR receiver_user_id = :user_id
                   OR (
                     COALESCE(CARDINALITY(CAST(:relationship_ids AS text[])), 0) > 0
                     AND relationship_id::text = ANY(CAST(:relationship_ids AS text[]))
                   )
                """
            ),
            params,
        )

    if _table_exists(conn, "consent_export_refresh_jobs"):
        conn.execute(
            text("DELETE FROM consent_export_refresh_jobs WHERE user_id = :user_id"),
            params,
        )

    if _table_exists(conn, "consent_exports"):
        conn.execute(text("DELETE FROM consent_exports WHERE user_id = :user_id"), params)

    if _table_exists(conn, "ria_client_invites"):
        conn.execute(
            text(
                """
                DELETE FROM ria_client_invites
                WHERE target_investor_user_id = :user_id
                   OR accepted_by_user_id = :user_id
                   OR (
                     COALESCE(CARDINALITY(CAST(:ria_profile_ids AS text[])), 0) > 0
                     AND ria_profile_id::text = ANY(CAST(:ria_profile_ids AS text[]))
                   )
                """
            ),
            params,
        )

    if _table_exists(conn, "consent_audit"):
        conn.execute(text("DELETE FROM consent_audit WHERE user_id = :user_id"), params)

    if _table_exists(conn, "internal_access_events"):
        conn.execute(text("DELETE FROM internal_access_events WHERE user_id = :user_id"), params)

    if _table_exists(conn, "user_push_tokens"):
        conn.execute(text("DELETE FROM user_push_tokens WHERE user_id = :user_id"), params)

    if _table_exists(conn, "advisor_investor_relationships"):
        conn.execute(
            text(
                """
                DELETE FROM advisor_investor_relationships
                WHERE investor_user_id = :user_id
                   OR (
                     COALESCE(CARDINALITY(CAST(:ria_profile_ids AS text[])), 0) > 0
                     AND ria_profile_id::text = ANY(CAST(:ria_profile_ids AS text[]))
                   )
                """
            ),
            params,
        )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Dry-run or apply consent/invite cleanup for one user without deleting PKM."
    )
    parser.add_argument("--user-id", help="Firebase user id to clean; defaults to KAI_TEST_USER_ID")
    parser.add_argument("--apply", action="store_true", help="Apply the cleanup instead of dry-run")
    parser.add_argument("--report", help="Optional path to write the JSON before/after report")
    args = parser.parse_args()

    user_id = str(args.user_id or os.getenv("KAI_TEST_USER_ID") or "").strip()
    if not user_id:
        print("Missing user id. Pass --user-id or set KAI_TEST_USER_ID.", file=sys.stderr)
        return 2

    environment = _active_environment()
    if args.apply and environment not in SAFE_APPLY_ENVIRONMENTS:
        print(
            f"Refusing to apply cleanup in environment={environment!r}. "
            f"Allowed apply environments: {sorted(SAFE_APPLY_ENVIRONMENTS)}",
            file=sys.stderr,
        )
        return 3

    try:
        with get_db_connection() as conn:
            before = _snapshot(conn, user_id)
            if args.apply:
                _apply_cleanup(conn, user_id)
                after = _snapshot(conn, user_id)
            else:
                after = before
    except OperationalError as exc:
        unix_socket = str(os.getenv("DB_UNIX_SOCKET") or "").strip()
        if unix_socket:
            print(
                "Database connection failed. This environment is configured for a Cloud SQL Unix "
                f"socket at {unix_socket!r}, but that socket is not available here. "
                "Start the Cloud SQL proxy / mount the socket, or switch the env file to a host-based DB target.",
                file=sys.stderr,
            )
        else:
            print(f"Database connection failed: {exc}", file=sys.stderr)
        return 4

    report = {
        "mode": "apply" if args.apply else "dry-run",
        "user_id": user_id,
        "before": before,
        "after": after,
    }
    payload = json.dumps(report, indent=2, sort_keys=True)
    print(payload)

    if args.report:
        report_path = Path(args.report)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(f"{payload}\n", encoding="utf-8")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
