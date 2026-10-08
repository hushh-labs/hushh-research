#!/usr/bin/env python3
"""Backfill: enqueue scoring work for relationships qualified before PR2 shipped.

`sync_referral_qualification_from_onboarding` only enqueues a scoring job
(`one_referral_scoring_jobs`) at the moment a relationship TRANSITIONS to
`qualified`. A relationship that already reached `qualified` before this
scoring layer was deployed never had that transition fire under the new code
-- it has correct referral credit, but no scoring job was ever created for it,
so it has zero points in the gamification ledger.

Coordinating with live scoring so neither can double-credit is a property of
the schema, not this script: `one_referral_scoring_jobs` has a unique index on
`relationship_id`, so backfilling a relationship the live path has already
(or concurrently) enqueued is a no-op, and running this script twice changes
nothing the second time. This script never writes a score event directly; it
only enqueues the SAME durable job the live path would have, so a backfilled
relationship is scored by the SAME worker code, under the active settings
version at the time the worker actually runs -- not whatever was active when
the relationship originally qualified.

Usage:
    python scripts/backfill_referral_scoring_jobs.py            # dry run, prints what would be enqueued
    python scripts/backfill_referral_scoring_jobs.py --apply    # actually enqueues jobs
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

CONSENT_ROOT = Path(__file__).resolve().parents[1]
if str(CONSENT_ROOT) not in sys.path:
    sys.path.insert(0, str(CONSENT_ROOT))


def _qualified_relationships_without_a_scoring_job() -> list[tuple[str, str]]:
    from sqlalchemy import text

    from db.db_client import get_db_connection

    with get_db_connection() as connection:
        rows = connection.execute(
            text(
                """
                SELECT r.id, r.referrer_user_id
                  FROM one_referral_relationships r
                 WHERE r.status = 'qualified'
                   AND NOT EXISTS (
                         SELECT 1 FROM one_referral_scoring_jobs j
                          WHERE j.relationship_id = r.id
                       )
                """
            )
        ).fetchall()
    return [(str(row.id), row.referrer_user_id) for row in rows]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually enqueue jobs. Without this flag, nothing is changed.",
    )
    args = parser.parse_args()

    from dotenv import load_dotenv

    load_dotenv(CONSENT_ROOT / ".env")

    pending = _qualified_relationships_without_a_scoring_job()
    print(f"{len(pending)} qualified relationship(s) have no scoring job yet.")

    if not args.apply:
        print("Dry run (pass --apply to enqueue). No jobs created.")
        return

    from db.db_client import get_db_connection
    from hushh_mcp.services.one_referral_scoring_service import enqueue_scoring_work

    enqueued = 0
    for relationship_id, referrer_user_id in pending:
        with get_db_connection() as connection:
            enqueue_scoring_work(
                connection, relationship_id=relationship_id, user_id=referrer_user_id
            )
        enqueued += 1

    print(f"Done. {enqueued} scoring job(s) enqueued for the worker to process.")


if __name__ == "__main__":
    main()
