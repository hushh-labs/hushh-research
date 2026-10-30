"""Bounded, dry-run-first promotion of exact historical disconnect evidence.

Run after migration 205. Feed is presentation-only at runtime; this one-time
repair promotes only two agreeing events from the canonical current episode.
Unknown/incomplete history stays suppressed. No contacts or identities printed.
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime
from pathlib import Path
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

BATCH_SQL = """
WITH batch AS (
  SELECT id, user_a_id, user_b_id, revoked_at FROM connections
  WHERE status = 'revoked' AND revoked_at IS NOT NULL
    AND revoked_by_side IS NULL AND revoked_by_at IS NULL
    AND (CAST(:after_id AS UUID) IS NULL OR id > CAST(:after_id AS UUID))
  ORDER BY id LIMIT :batch_size
)
SELECT c.*, evidence.* FROM batch c
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS event_count, COUNT(DISTINCT f.user_id) AS owner_count,
    COUNT(DISTINCT f.source_row_id) AS episode_count,
    COUNT(*) FILTER (WHERE f.metadata @> '{"actor_is_self": true}'::jsonb) AS self_count,
    COUNT(*) FILTER (WHERE f.metadata @> '{"actor_is_self": false}'::jsonb) AS peer_count,
    MAX(f.user_id) FILTER (WHERE f.metadata @> '{"actor_is_self": true}'::jsonb) AS actor_user_id,
    MIN(f.source_row_id) AS source_row_id
  FROM feed_events f
  WHERE f.user_id IN (c.user_a_id, c.user_b_id)
    AND f.source_domain = 'connections' AND f.event_type = 'connection_revoked'
    AND f.created_at = c.revoked_at
    AND LEFT(f.source_row_id, 37) = c.id::text || ':'
) evidence ON TRUE ORDER BY c.id
"""

APPLY_SQL = """
UPDATE connections SET revoked_by_side = CASE
    WHEN user_a_id = :actor THEN 'a' WHEN user_b_id = :actor THEN 'b' END,
  revoked_by_at = revoked_at
WHERE id = CAST(:id AS UUID) AND status = 'revoked'
  AND :actor IN (user_a_id, user_b_id)
  AND revoked_at = :observed_revoked_at
  AND revoked_by_side IS NULL AND revoked_by_at IS NULL
RETURNING id
"""


def verified_disconnect_actor(row: dict) -> str | None:
    if tuple(
        row.get(key)
        for key in ("event_count", "owner_count", "episode_count", "self_count", "peer_count")
    ) != (2, 2, 1, 1, 1):
        return None
    actor = row.get("actor_user_id")
    if actor not in (row.get("user_a_id"), row.get("user_b_id")) or not actor:
        return None
    source = str(row.get("source_row_id") or "")
    if not source.startswith(f"{row['id']}:"):
        return None
    try:
        episode = datetime.fromisoformat(source[37:])
        revoked = row["revoked_at"]
        if isinstance(revoked, str):
            revoked = datetime.fromisoformat(revoked)
        if episode.tzinfo is None or episode != revoked:
            return None
    except (ValueError, TypeError):
        return None
    return str(actor)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--expected-database")
    parser.add_argument("--after-id", type=UUID)
    parser.add_argument("--batch-size", type=int, default=100)
    parser.add_argument("--max-batches", type=int, default=20)
    args = parser.parse_args()
    if not 1 <= args.batch_size <= 1000 or not 1 <= args.max_batches <= 1000:
        parser.error("Use positive bounded batch limits up to 1000.")
    from db.db_client import get_db

    db = get_db()
    if args.apply:
        database = db.execute_raw("SELECT current_database() AS name", {}).data[0]["name"]
        if not args.expected_database or database != args.expected_database:
            parser.error("Exact expected database is required; no backfill was performed.")
    cursor = str(args.after_id) if args.after_id else None
    for _ in range(args.max_batches):
        rows = db.execute_raw(BATCH_SQL, {"after_id": cursor, "batch_size": args.batch_size}).data
        if not rows:
            print("Complete; no further candidate rows.")
            return
        eligible = applied = 0
        for row in rows:
            actor = verified_disconnect_actor(row)
            if actor:
                eligible += 1
                if args.apply:
                    applied += len(
                        db.execute_raw(
                            APPLY_SQL,
                            {
                                "id": str(row["id"]),
                                "actor": actor,
                                "observed_revoked_at": row["revoked_at"],
                            },
                        ).data
                    )
        cursor = str(rows[-1]["id"])
        print(f"examined={len(rows)} eligible={eligible} applied={applied} cursor={cursor}")
        time.sleep(0.05)
    print(f"Batch limit reached; resume with --after-id {cursor}.")


if __name__ == "__main__":
    main()
