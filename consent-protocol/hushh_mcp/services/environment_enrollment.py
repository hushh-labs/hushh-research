"""Record that a person has used THIS environment.

Connect lists a stranger only once they have unlocked their vault here
(``vault_keys.environment_enrolled_at``). A database copied from another
environment carries active vaults for people who never signed in here; the
stamp is what tells them apart. Set once, on the first vault unlock.
"""

from __future__ import annotations

import asyncio
import logging

from sqlalchemy import text

from db.db_client import get_db

logger = logging.getLogger(__name__)

_STAMP = text(
    "UPDATE vault_keys SET environment_enrolled_at = now() "
    "WHERE user_id = :user_id AND vault_status = 'active' "
    "AND environment_enrolled_at IS NULL"
)


def _stamp_sync(user_id: str) -> None:
    with get_db().engine.begin() as connection:
        connection.execute(_STAMP, {"user_id": user_id})


async def stamp_environment_enrollment(user_id: str) -> None:
    """Best effort: a failed stamp never blocks the unlock; the next one retries."""
    if not user_id:
        return
    try:
        await asyncio.to_thread(_stamp_sync, user_id)
    except Exception as exc:  # noqa: BLE001 - visibility stamp, never an unlock gate
        logger.warning("environment_enrollment.stamp_failed err=%s", type(exc).__name__)
