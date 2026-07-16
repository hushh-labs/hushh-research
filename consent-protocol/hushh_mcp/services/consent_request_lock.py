"""Cross-instance serialization for consent request creation."""

from __future__ import annotations

import asyncio
import hashlib
import os
from contextlib import asynccontextmanager
from typing import AsyncIterator

from db.connection import get_pool

_local_locks: dict[int, asyncio.Lock] = {}
_local_locks_guard = asyncio.Lock()


def consent_request_lock_key(*, agent_id: str, user_id: str, scope: str) -> int:
    digest = hashlib.sha256(f"{agent_id}\0{user_id}\0{scope}".encode()).digest()[:8]
    return int.from_bytes(digest, byteorder="big", signed=True)


async def _local_lock(key: int) -> asyncio.Lock:
    async with _local_locks_guard:
        return _local_locks.setdefault(key, asyncio.Lock())


def _uses_local_lock() -> bool:
    return (
        str(os.getenv("DB_OFFLINE", "")).strip().lower() in {"1", "true", "yes", "on"}
        or str(os.getenv("TESTING", "")).strip().lower() == "true"
        or bool(os.getenv("PYTEST_CURRENT_TEST"))
    )


@asynccontextmanager
async def serialize_consent_request(
    *,
    agent_id: str,
    user_id: str,
    scope: str,
) -> AsyncIterator[None]:
    """Serialize one app/user/scope request lane across Cloud Run instances.

    Postgres is the current shared coordination tier. This seam can move to a
    Redis/Memorystore distributed lock later without changing route contracts.
    """

    key = consent_request_lock_key(agent_id=agent_id, user_id=user_id, scope=scope)
    if _uses_local_lock():
        lock = await _local_lock(key)
        async with lock:
            yield
        return

    pool = await get_pool()
    async with pool.acquire() as connection:
        await connection.execute("SELECT pg_advisory_lock($1)", key)
        try:
            yield
        finally:
            await connection.execute("SELECT pg_advisory_unlock($1)", key)
