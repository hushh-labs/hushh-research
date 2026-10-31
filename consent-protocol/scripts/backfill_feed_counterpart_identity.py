"""Explicit, bounded, resumable backfill of server-only Feed identity links.

Run after migration 202, outside the migration transaction. Default is dry-run;
--apply additionally requires the exact current database name. No user identity
or photo is printed. Already-purged source records cannot be reconstructed.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from db.db_client import get_db  # noqa: E402

BATCH_SQL = """
WITH candidates AS MATERIALIZED (
  SELECT f.* FROM feed_events f
  WHERE f.id > :after_id AND f.source_domain IN ('connections', 'location')
    AND NOT EXISTS (SELECT 1 FROM feed_event_counterparts c WHERE c.feed_event_id = f.id)
  ORDER BY f.id LIMIT :batch_size
), resolved AS MATERIALIZED (
  SELECT f.id, public.resolve_feed_counterpart_user_id(
    f.user_id, f.source_domain, f.event_type, f.source_row_id) AS counterpart_user_id
  FROM candidates f
), inserted AS (
  INSERT INTO feed_event_counterparts(feed_event_id, counterpart_user_id)
  SELECT r.id, r.counterpart_user_id FROM resolved r
  WHERE r.counterpart_user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM account_deletion_tombstones t
      WHERE t.user_id_hash = 'sha256:' || encode(digest(r.counterpart_user_id, 'sha256'), 'hex'))
  ON CONFLICT (feed_event_id) DO NOTHING
  RETURNING feed_event_id
)
SELECT (SELECT MAX(id) FROM candidates) AS next_cursor,
       (SELECT COUNT(*) FROM candidates) AS examined,
       (SELECT COUNT(*) FROM inserted) AS inserted
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--expected-database")
    parser.add_argument("--after-id", type=int, default=0)
    parser.add_argument("--batch-size", type=int, default=250)
    parser.add_argument("--max-batches", type=int, default=20)
    args = parser.parse_args()
    if not 1 <= args.batch_size <= 1000 or not 1 <= args.max_batches <= 1000 or args.after_id < 0:
        parser.error("Use positive bounded batch limits and a nonnegative cursor.")
    db = get_db()
    if not args.apply:
        print("Dry run: no changes. Use --apply --expected-database NAME after migration 202.")
        return
    database = db.execute_raw("SELECT current_database() AS name", {}).data[0]["name"]
    if not args.expected_database or database != args.expected_database:
        parser.error("Exact expected database is required; no backfill was performed.")
    cursor = args.after_id
    for _ in range(args.max_batches):
        for attempt in range(3):
            try:
                result = db.execute_raw(
                    BATCH_SQL, {"after_id": cursor, "batch_size": args.batch_size}
                ).data[0]
                break
            except Exception:
                # Erasure can race a batch after resolution. Retry the same
                # cursor so the next snapshot excludes the deleted identity.
                if attempt == 2:
                    raise RuntimeError(f"Backfill paused; resume after cursor {cursor}.") from None
                time.sleep(0.1 * (attempt + 1))
        if result["next_cursor"] is None:
            print(f"Complete through cursor {cursor}.")
            return
        cursor = int(result["next_cursor"])
        print(f"cursor={cursor} examined={result['examined']} inserted={result['inserted']}")
        time.sleep(0.05)
    print(f"Batch budget reached; resume with --after-id {cursor}.")


if __name__ == "__main__":
    main()
