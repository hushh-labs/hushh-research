#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import logging

from firebase_admin import auth

from api.utils.firebase_admin import get_firebase_auth_app
from db.connection import get_pool
from hushh_mcp.services.actor_identity_service import ActorIdentityService

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("actor_identity_backfill")


async def main(
    *,
    missing_phones_only: bool = False,
    execute: bool = False,
    limit: int = 100,
    after_user_id: str = "",
) -> str | None:
    pool = await get_pool()
    identity_service = ActorIdentityService()
    async with pool.acquire() as conn:
        rows = (
            await conn.fetch(
                """
          SELECT profile.user_id
          FROM actor_profiles profile
          LEFT JOIN actor_identity_cache identity ON identity.user_id = profile.user_id
          WHERE profile.public_profile_status = 'active'
            AND profile.user_id > $2
            AND (identity.phone_verified IS DISTINCT FROM TRUE
                 OR NULLIF(BTRIM(identity.phone_number), '') IS NULL)
          ORDER BY profile.user_id
          LIMIT $1
          """,
                limit,
                after_user_id,
            )
            if missing_phones_only
            else await conn.fetch(
                """
          SELECT user_id
          FROM actor_profiles
          WHERE user_id > $2
          ORDER BY user_id
          LIMIT $1
          """,
                limit,
                after_user_id,
            )
        )

    user_ids = [
        str(row["user_id"] or "").strip() for row in rows if str(row["user_id"] or "").strip()
    ]
    logger.info("Found %s actor profiles to backfill.", len(user_ids))
    next_cursor = user_ids[-1] if len(user_ids) == limit else None
    if not execute:
        logger.info("Dry run: no identity changes. Use --execute to apply this bounded repair.")
        return next_cursor
    if missing_phones_only:
        # Skip phone-less/deleted accounts in bounded provider batches. Each
        # actual repair still obtains fresh proof through the canonical writer.
        app = get_firebase_auth_app()
        if app is None:
            raise RuntimeError("Firebase identity verification is unavailable.")
        phone_candidates = []
        for offset in range(0, len(user_ids), 100):
            try:
                records = await asyncio.to_thread(
                    auth.get_users,
                    [auth.UidIdentifier(uid) for uid in user_ids[offset : offset + 100]],
                    app=app,
                )
            except Exception:
                raise RuntimeError(
                    "Provider identity verification failed; retry the repair."
                ) from None
            phone_candidates.extend(
                record.uid
                for record in records.users
                if not record.disabled and record.phone_number
            )
        logger.info(
            "Enabled provider-phone candidates: %s; other profiles unchanged: %s.",
            len(phone_candidates),
            len(user_ids) - len(phone_candidates),
        )
        user_ids = phone_candidates

    completed = 0
    verified = 0
    failed = 0
    for user_id in user_ids:
        try:
            if missing_phones_only:
                result = await identity_service.sync_verified_phone_from_firebase(
                    user_id, missing_only=True
                )
                verified += int(
                    bool(result and result.get("phone_verified") and result.get("phone_number"))
                )
            else:
                await identity_service.sync_from_firebase(user_id, force=True)
        except Exception as exc:
            # Provider/persistence errors can contain private identity details.
            logger.warning("Identity repair unavailable: %s", type(exc).__name__)
            failed += 1
        completed += 1
        if completed % 25 == 0:
            logger.info("Backfilled %s/%s identities...", completed, len(user_ids))

    logger.info("Actor identity cache backfill complete: %s users processed.", completed)
    if missing_phones_only:
        logger.info(
            "Verified phone repairs: %s; unchanged: %s; failed: %s.",
            verified,
            completed - verified - failed,
            failed,
        )
    if failed:
        raise RuntimeError("Some identity repairs failed; retry the bounded repair.")
    return next_cursor


async def run_batches(*, missing_phones_only=False, execute=False, limit=100, all_batches=False):
    cursor = ""
    while True:
        cursor = await main(
            missing_phones_only=missing_phones_only,
            execute=execute,
            limit=limit,
            after_user_id=cursor,
        )
        if cursor is None:
            return
        if not all_batches:
            logger.info(
                "Batch limit reached. Use --all to scan remaining profiles in bounded batches."
            )
            return


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Repair actor identity cache from fresh Firebase evidence."
    )
    parser.add_argument(
        "--missing-phones-only",
        action="store_true",
        help="Preserve all existing verified phone bindings.",
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Apply changes; default is a read-only candidate count.",
    )
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument(
        "--all",
        action="store_true",
        help="Continue through bounded batches, including past phone-less profiles.",
    )
    args = parser.parse_args()
    if not 1 <= args.limit <= 1000:
        parser.error("--limit must be between 1 and 1000")
    asyncio.run(
        run_batches(
            missing_phones_only=args.missing_phones_only,
            execute=args.execute,
            limit=args.limit,
            all_batches=args.all,
        )
    )
