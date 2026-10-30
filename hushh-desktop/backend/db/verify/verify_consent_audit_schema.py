#!/usr/bin/env python3
"""
Verify consent_audit table exists in Supabase with columns required for the
consent request flow (pending list, SSE, approve/deny).

Run from consent-protocol with DB_* env set (or .env):
  python db/verify/verify_consent_audit_schema.py

If verification fails, run in Supabase SQL Editor:
  consent-protocol/db/legacy/init_supabase_schema.sql (or the consent_audit block, lines 81-106).
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"))

# Required columns for consent request flow (from db/legacy/init_supabase_schema.sql / consent_db.py)
REQUIRED_COLUMNS = [
    "id",
    "token_id",
    "user_id",
    "agent_id",
    "scope",
    "action",
    "issued_at",
    "expires_at",
    "revoked_at",
    "metadata",
    "token_type",
    "ip_address",
    "user_agent",
    "request_id",  # Required for pending/SSE
    "scope_description",
    "poll_timeout_at",  # Required for pending timeout
]


def main() -> int:
    try:
        from sqlalchemy import text

        from db.db_client import get_db_connection
    except ImportError as e:
        print("Error: could not import db_client.", e, file=sys.stderr)
        print(
            "Run from consent-protocol with: python db/verify/verify_consent_audit_schema.py",
            file=sys.stderr,
        )
        return 1

    if not all(os.getenv(k) for k in ("DB_USER", "DB_PASSWORD", "DB_HOST")):
        print(
            "DB_USER, DB_PASSWORD, DB_HOST are not set. Set them or use .env.",
            file=sys.stderr,
        )
        print(
            "You can still verify in Supabase Dashboard → SQL Editor:",
            file=sys.stderr,
        )
        print(
            "  SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'consent_audit';",
            file=sys.stderr,
        )
        print(
            "If consent_audit is missing, run db/legacy/init_supabase_schema.sql in Supabase.",
            file=sys.stderr,
        )
        return 1

    try:
        with get_db_connection() as conn:
            result = conn.execute(
                text(
                    """
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'consent_audit'
                    ORDER BY ordinal_position;
                    """
                )
            )
            rows = result.fetchall()
    except Exception as e:
        print(f"Database error: {e}", file=sys.stderr)
        return 1

    if not rows:
        print("Table consent_audit does not exist.", file=sys.stderr)
        print(
            "Run consent-protocol/db/legacy/init_supabase_schema.sql in Supabase SQL Editor (or the consent_audit block, lines 81-106).",
            file=sys.stderr,
        )
        return 1

    present = {r[0] for r in rows}
    missing = [c for c in REQUIRED_COLUMNS if c not in present]
    if missing:
        print(f"consent_audit is missing columns: {', '.join(missing)}", file=sys.stderr)
        print(
            "Run consent-protocol/db/legacy/init_supabase_schema.sql in Supabase SQL Editor (or the consent_audit block, lines 81-106).",
            file=sys.stderr,
        )
        return 1

    print("OK: consent_audit exists with all required columns for the consent request flow.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
