"""Minimal pool holders using asyncpg's actual acquisition machinery."""

from __future__ import annotations

import asyncio

import asyncpg

from db import connection as _connection  # noqa: F401 -- install acquire guardrail


class _Holder:
    """Stands in for asyncpg's PoolConnectionHolder."""

    def __init__(self, connection: object = "connection", fail: BaseException | None = None):
        self._connection = connection
        self._fail = fail
        self._timeout: float | None = "untouched"  # type: ignore[assignment]

    async def acquire(self):
        if self._fail is not None:
            raise self._fail
        return self._connection


class _Pool:
    """Only what asyncpg's real ``Pool._acquire`` touches.

    ``_acquire`` and ``acquire`` are the genuine asyncpg implementations, so the
    unbounded-wait branch and the holder bookkeeping are exercised for real.
    """

    _closing = False

    def __init__(self) -> None:
        self._queue: asyncio.Queue = asyncio.Queue()  # empty == fully starved
        self.released: list = []

    def _check_init(self) -> None:
        return None

    async def release(self, connection, *, timeout=None):  # noqa: ARG002
        self.released.append(connection)

    _acquire = asyncpg.pool.Pool._acquire
    acquire = asyncpg.pool.Pool.acquire
