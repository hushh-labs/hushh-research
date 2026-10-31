#!/usr/bin/env python3
"""Backfill: qualify referrals whose referred user already finished onboarding.

The qualification pipeline used to require fifteen minutes of post-onboarding
engagement, and nothing ever drove a relationship's status past `signed_up` in
practice -- the pipeline was never wired end to end. That leaves relationships
sitting in an active, pre-qualified state (`signed_up`, `phone_verified`,
`onboarded`, `engaging`, `under_review`) for referred users who, in reality,
finished the full Hushh One onboarding flow long ago.

This script does not blindly mark every in-flight relationship qualified. For
each one it re-runs the exact same server-side check the live pipeline now
runs on every onboarding-completed event
(`sync_referral_qualification_from_onboarding`): it re-reads that referred
user's real `vault_keys.setup_completed` and `actor_identity_cache.phone_verified`
facts and only advances the relationships where those facts already say the
funnel is complete. A relationship whose referred user never finished
onboarding is left exactly where it is.

Usage:
    python scripts/backfill_referral_qualification.py            # dry run, prints what would change
    python scripts/backfill_referral_qualification.py --apply    # actually writes the updates
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

CONSENT_ROOT = Path(__file__).resolve().parents[1]
if str(CONSENT_ROOT) not in sys.path:
    sys.path.insert(0, str(CONSENT_ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(CONSENT_ROOT / ".env")

from sqlalchemy import text  # noqa: E402

from db.db_client import get_db_connection  # noqa: E402
from hushh_mcp.operons.referral.policy import QUALIFIED, TERMINAL_STATES  # noqa: E402
from hushh_mcp.services.one_referral_service import (  # noqa: E402
    sync_referral_qualification_from_onboarding,
)

_IN_FLIGHT_STATUSES = (
    "attributed",
    "signed_up",
    "phone_verified",
    "onboarded",
    "engaging",
    "under_review",
)
assert QUALIFIED not in _IN_FLIGHT_STATUSES
assert not (TERMINAL_STATES & set(_IN_FLIGHT_STATUSES))


def _in_flight_referred_user_ids() -> list[str]:
    with get_db_connection() as connection:
        rows = connection.execute(
            text(
                """
                SELECT referred_user_id
                  FROM one_referral_relationships
                 WHERE status = ANY(:statuses)
                """
            ),
            {"statuses": list(_IN_FLIGHT_STATUSES)},
        ).fetchall()
    return [row.referred_user_id for row in rows]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually write updates. Without this flag, nothing is changed.",
    )
    args = parser.parse_args()

    user_ids = _in_flight_referred_user_ids()
    print(f"{len(user_ids)} in-flight referral relationship(s) to re-check.")

    if not args.apply:
        print("Dry run (pass --apply to write changes). No updates made.")
        return

    updated = 0
    unchanged = 0
    for user_id in user_ids:
        result = sync_referral_qualification_from_onboarding(user_id)
        if result.get("status") == "updated":
            updated += 1
            print(f"  qualified/advanced: {user_id} -> {result.get('relationship_status')}")
        else:
            unchanged += 1

    print(f"Done. {updated} relationship(s) advanced, {unchanged} left unchanged.")


if __name__ == "__main__":
    main()
