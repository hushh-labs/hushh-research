"""Bounded call expiry/erasure for the governed maintenance scheduler.

Operator entrypoint: python -m hushh_mcp.services.direct_call_retention --limit 100
Only aggregate counts are emitted. Installing a scheduler is a separate rollout.
"""

from __future__ import annotations

import argparse
import json

from sqlalchemy import text

from db.db_client import get_db
from hushh_mcp.services.direct_call_lifecycle import clear_call, expire_call
from hushh_mcp.services.direct_call_policy import LEASE_SECONDS


def purge_batch(*, db=None, limit: int = 100) -> dict[str, int]:
    if not 1 <= limit <= 500:
        raise ValueError("limit must be between 1 and 500")
    counts = {"expired": 0, "compacted": 0, "commands": 0}
    with (db or get_db()).engine.begin() as conn:
        rows = (
            conn.execute(
                text("""SELECT *,created_at<clock_timestamp()-interval '24 hours' AS compact
            FROM direct_calls WHERE ((public.direct_call_expired(state,expires_at,caller_seen_at,callee_seen_at,clock_timestamp(),:lease)
              OR state IN ('declined','cancelled','ended','expired'))
              AND (state IN ('preparing','ringing','connecting','active') OR offers<>'[]'::jsonb OR caller_proof<>'{}'::jsonb))
            OR (created_at<clock_timestamp()-interval '24 hours' AND state IN ('declined','cancelled','ended','expired'))
            ORDER BY expires_at,id
            LIMIT :limit FOR UPDATE SKIP LOCKED"""),
                {"limit": limit, "lease": LEASE_SECONDS},
            )
            .mappings()
            .all()
        )
        for row in rows:
            params = {"id": str(row["id"])}
            if row["compact"]:
                clear_call(conn, str(row["id"]))
                conn.execute(text("DELETE FROM direct_calls WHERE id=CAST(:id AS UUID)"), params)
                counts["compacted"] += 1
            else:
                expire_call(conn, dict(row))
                counts["expired"] += 1
        removed = conn.execute(
            text("""DELETE FROM direct_call_commands WHERE nonce IN
            (SELECT nonce FROM direct_call_commands WHERE expires_at<clock_timestamp()
            ORDER BY expires_at LIMIT :limit FOR UPDATE SKIP LOCKED) RETURNING nonce"""),
            {"limit": limit},
        ).fetchall()
        counts["commands"] = len(removed)
    return counts


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Compact expired calling state; never print content or credentials."
    )
    parser.add_argument("--limit", type=int, default=100)
    args = parser.parse_args()
    try:
        print(json.dumps(purge_batch(limit=args.limit)))
    except Exception:
        raise SystemExit(
            "Call retention failed; inspect the governed database health checks."
        ) from None
