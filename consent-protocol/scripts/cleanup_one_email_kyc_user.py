#!/usr/bin/env python3
"""User-scoped One Email workflow cleanup with dry-run snapshots.

This reset is intentionally narrower than the general consent cleanup. It
removes One Email workflow rows and One Email consent ledger rows for one user
while preserving vault keys, PKM data, verified aliases, and client connector
public metadata.
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
ONE_EMAIL_SOURCE = "one_email_kyc_v1"
ONE_EMAIL_AGENT_ID = "agent_kyc"


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


def _count(conn, sql: str, params: dict[str, object]) -> int:
    value = conn.execute(text(sql), params).scalar()
    return int(value or 0)


def _group(conn, sql: str, params: dict[str, object]) -> list[dict[str, object]]:
    return [dict(row) for row in conn.execute(text(sql), params).mappings().all()]


def _snapshot(conn, user_id: str) -> dict[str, object]:
    params = {
        "user_id": user_id,
        "source": ONE_EMAIL_SOURCE,
        "agent_id": ONE_EMAIL_AGENT_ID,
    }
    snapshot: dict[str, object] = {
        "user_id": user_id,
        "environment": _active_environment(),
    }
    if _table_exists(conn, "one_kyc_workflows"):
        snapshot["one_kyc_workflows"] = {
            "count": _count(
                conn,
                "SELECT COUNT(*) FROM one_kyc_workflows WHERE user_id = :user_id",
                params,
            ),
            "by_status": _group(
                conn,
                """
                SELECT status, COUNT(*)::int AS row_count
                FROM one_kyc_workflows
                WHERE user_id = :user_id
                GROUP BY status
                ORDER BY row_count DESC, status ASC
                """,
                params,
            ),
        }
    if _table_exists(conn, "consent_audit"):
        snapshot["one_email_consent_audit"] = {
            "count": _count(
                conn,
                """
                SELECT COUNT(*)
                FROM consent_audit
                WHERE user_id = :user_id
                  AND (
                    metadata->>'request_source' = :source
                    OR metadata->>'source' = :source
                    OR agent_id = :agent_id
                    OR request_id LIKE 'okyc_%'
                  )
                """,
                params,
            ),
            "by_action": _group(
                conn,
                """
                SELECT action, COUNT(*)::int AS row_count
                FROM consent_audit
                WHERE user_id = :user_id
                  AND (
                    metadata->>'request_source' = :source
                    OR metadata->>'source' = :source
                    OR agent_id = :agent_id
                    OR request_id LIKE 'okyc_%'
                  )
                GROUP BY action
                ORDER BY row_count DESC, action ASC
                """,
                params,
            ),
        }
    if _table_exists(conn, "consent_exports"):
        snapshot["one_email_consent_exports"] = {
            "count": _count(
                conn,
                """
                SELECT COUNT(*)
                FROM consent_exports
                WHERE user_id = :user_id
                  AND consent_token IN (
                    SELECT token_id
                    FROM consent_audit
                    WHERE user_id = :user_id
                      AND token_id IS NOT NULL
                      AND (
                        metadata->>'request_source' = :source
                        OR metadata->>'source' = :source
                        OR agent_id = :agent_id
                        OR request_id LIKE 'okyc_%'
                      )
                  )
                """,
                params,
            )
        }
    return snapshot


def _apply_cleanup(conn, user_id: str) -> None:
    params = {
        "user_id": user_id,
        "source": ONE_EMAIL_SOURCE,
        "agent_id": ONE_EMAIL_AGENT_ID,
    }
    if _table_exists(conn, "consent_export_refresh_jobs"):
        conn.execute(
            text(
                """
                DELETE FROM consent_export_refresh_jobs
                WHERE user_id = :user_id
                  AND consent_token IN (
                    SELECT token_id
                    FROM consent_audit
                    WHERE user_id = :user_id
                      AND token_id IS NOT NULL
                      AND (
                        metadata->>'request_source' = :source
                        OR metadata->>'source' = :source
                        OR agent_id = :agent_id
                        OR request_id LIKE 'okyc_%'
                      )
                  )
                """
            ),
            params,
        )
    if _table_exists(conn, "consent_exports"):
        conn.execute(
            text(
                """
                DELETE FROM consent_exports
                WHERE user_id = :user_id
                  AND consent_token IN (
                    SELECT token_id
                    FROM consent_audit
                    WHERE user_id = :user_id
                      AND token_id IS NOT NULL
                      AND (
                        metadata->>'request_source' = :source
                        OR metadata->>'source' = :source
                        OR agent_id = :agent_id
                        OR request_id LIKE 'okyc_%'
                      )
                  )
                """
            ),
            params,
        )
    if _table_exists(conn, "consent_audit"):
        conn.execute(
            text(
                """
                DELETE FROM consent_audit
                WHERE user_id = :user_id
                  AND (
                    metadata->>'request_source' = :source
                    OR metadata->>'source' = :source
                    OR agent_id = :agent_id
                    OR request_id LIKE 'okyc_%'
                  )
                """
            ),
            params,
        )
    if _table_exists(conn, "one_kyc_workflows"):
        conn.execute(
            text("DELETE FROM one_kyc_workflows WHERE user_id = :user_id"),
            params,
        )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Dry-run or apply One Email KYC cleanup for one user."
    )
    parser.add_argument("--user-id", help="Firebase user id to clean; defaults to REVIEWER_UID")
    parser.add_argument("--apply", action="store_true", help="Apply cleanup instead of dry-run")
    parser.add_argument("--report", help="Optional path to write the JSON report")
    args = parser.parse_args()

    user_id = str(
        args.user_id or os.getenv("REVIEWER_UID") or os.getenv("KAI_TEST_USER_ID") or ""
    ).strip()
    if not user_id:
        print("Missing user id. Pass --user-id or set REVIEWER_UID.", file=sys.stderr)
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
        print(f"Database connection failed: {exc}", file=sys.stderr)
        return 4

    report = {
        "mode": "apply" if args.apply else "dry-run",
        "user_id": user_id,
        "preserved": [
            "vault_keys",
            "pkm_data",
            "pkm_index",
            "actor_verified_email_aliases",
            "one_kyc_client_connectors",
        ],
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
