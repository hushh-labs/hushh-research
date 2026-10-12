#!/usr/bin/env python3
"""Provision existing accounts after migration 285, without changing existing cards.

Run through the normal environment/bootstrap entry point. Dry-run is default;
--apply creates missing profiles using only account identity basics. No tokens
or personal values are printed. Safe to rerun or run beside live sign-ins.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

_MISSING_OWNERS = """
    SELECT profile.user_id FROM actor_profiles profile
    LEFT JOIN one_wallet_cards card ON card.user_id = profile.user_id
    WHERE card.user_id IS NULL AND profile.user_id > :after_id
      AND NOT EXISTS (
        SELECT 1 FROM account_deletion_tombstones tombstone
        WHERE tombstone.user_id_hash =
          'sha256:' || encode(digest(profile.user_id, 'sha256'), 'hex')
      )
    ORDER BY profile.user_id LIMIT :batch_size
"""


def _is_deletion_guard(exc: BaseException) -> bool:
    """Recognize only the DB's authoritative account-erasure write fence."""
    seen: set[int] = set()
    while id(exc) not in seen:
        seen.add(id(exc))
        if getattr(getattr(exc, "diag", None), "constraint_name", None) == (
            "account_deletion_tombstone_guard"
        ):
            return True
        nested = getattr(exc, "orig", None) or exc.__cause__ or exc.__context__
        if not isinstance(nested, BaseException):
            break
        exc = nested
    return False


def run_backfill(*, db: Any, service: Any, apply: bool, batch_size: int, max_users: int) -> dict:
    after_id = ""
    processed = 0
    skipped_deleted = 0
    while processed < max_users:
        rows = (
            db.execute_raw(
                _MISSING_OWNERS,
                {"after_id": after_id, "batch_size": min(batch_size, max_users - processed)},
            ).data
            or []
        )
        if not rows:
            break
        for row in rows:
            owner_id = str(row["user_id"])
            if apply:
                try:
                    service.ensure_card(user_id=owner_id)
                except Exception as exc:
                    # A user can erase their account after this batch was read.
                    # The DB fence remains authoritative; unrelated failures stop
                    # the job rather than reporting a successful partial run.
                    if not _is_deletion_guard(exc):
                        raise
                    skipped_deleted += 1
            after_id = owner_id
            processed += 1
    return {
        "mode": "apply" if apply else "dry-run",
        "processed": processed,
        "skippedDeleted": skipped_deleted,
        "limitReached": processed == max_users,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--batch-size", type=int, default=100)
    parser.add_argument("--max-users", type=int, default=10000)
    args = parser.parse_args()
    if not 1 <= args.batch_size <= 1000 or not 1 <= args.max_users <= 100000:
        parser.error("Use batch-size 1–1000 and max-users 1–100000.")

    from db.db_client import get_db
    from hushh_mcp.runtime_settings import hydrate_runtime_environment, one_wallet_card_enabled
    from hushh_mcp.services.one_wallet_card_service import OneWalletCardService

    hydrate_runtime_environment()
    if args.apply and not one_wallet_card_enabled():
        parser.error("Wallet Profile must be enabled before applying a backfill.")
    if args.apply and not str(os.getenv("EXTERNAL_CONNECTOR_CREDENTIAL_KEY") or "").strip():
        parser.error("Configure encrypted share-link recovery before applying a backfill.")

    try:
        result = run_backfill(
            db=get_db(),
            service=OneWalletCardService(),
            apply=args.apply,
            batch_size=args.batch_size,
            max_users=args.max_users,
        )
    except Exception as exc:
        # Database exception messages may contain bound profile values. Keep
        # the command output aggregate-only, including on failed runs.
        print(json.dumps({"status": "failed", "errorType": type(exc).__name__}))
        raise SystemExit(1) from None
    print(json.dumps(result))


if __name__ == "__main__":
    main()
