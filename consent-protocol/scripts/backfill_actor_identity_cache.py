#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import logging

from db.connection import get_pool
from hushh_mcp.services.actor_identity_service import ActorIdentityService

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("actor_identity_backfill")


async def main() -> None:
    pool = await get_pool()
    identity_service = ActorIdentityService()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
          SELECT user_id
          FROM actor_profiles
          ORDER BY created_at ASC NULLS LAST, user_id ASC
          """
        )

    user_ids = [
        str(row["user_id"] or "").strip() for row in rows if str(row["user_id"] or "").strip()
    ]
    logger.info("Found %s actor profiles to backfill.", len(user_ids))

    completed = 0
    for user_id in user_ids:
        await identity_service.sync_from_firebase(user_id, force=True)
        completed += 1
        if completed % 25 == 0:
            logger.info("Backfilled %s/%s identities...", completed, len(user_ids))

    logger.info("Actor identity cache backfill complete: %s users processed.", completed)


if __name__ == "__main__":
    asyncio.run(main())
