"""
Offline database connection layer (asyncpg-compatible SQLite adapter).

Provides a SQLite-backed pool that mimics the asyncpg.Pool / Connection API used
by the peripheral services that talk to db.connection.get_pool() directly
(market cache, gmail receipts, ria_iam, actor identity, marketplace replenisher).

Activated when DB_OFFLINE=1.

The consent connector + PKM flows do NOT use this pool — they route through
db.db_client (SQLAlchemy), which has its own offline SQLite engine. This adapter
exists so the asyncpg-style call sites degrade to the same local SQLite file
instead of crashing.

Compatibility provided:
- pool.acquire() async context manager -> connection
- connection.fetch / fetchrow / fetchval / execute / executemany
- asyncpg-style positional placeholders ($1, $2, ...) translated to SQLite '?'
- pool-level fetch / fetchrow / fetchval / execute passthroughs

Caveats (documented, intentional): Postgres-specific SQL (jsonb casts, RETURNING
on some statements, ANY($1), INTERVAL, now()) is NOT translated here. Call sites
that need full parity should use db_client. This adapter targets the simple
CRUD/cache queries the peripheral services issue.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional, cast

logger = logging.getLogger(__name__)

# Default path for the offline database file (shared with db_client offline engine)
OFFLINE_DB_PATH = os.path.join(
    os.path.dirname(__file__),
    "..",
    "tmp",
    "hushh-offline.db",
)

_SCHEMA_FILE = os.path.join(os.path.dirname(__file__), "offline_schema.sql")

# Matches asyncpg positional params $1, $2, ... (not inside identifiers).
_PG_PARAM_RE = re.compile(r"\$(\d+)")


def _is_offline_mode() -> bool:
    """Check if DB_OFFLINE environment variable enables offline mode."""
    return str(os.getenv("DB_OFFLINE", "0")).strip().lower() in ("1", "true", "yes", "on")


def _get_db_path() -> str:
    """Get the database file path for offline mode."""
    path = os.getenv("OFFLINE_DB_PATH", OFFLINE_DB_PATH)
    path = os.path.abspath(path)
    db_dir = os.path.dirname(path)
    if db_dir:
        Path(db_dir).mkdir(parents=True, exist_ok=True)
    return path


def _translate_query(query: str) -> str:
    """Translate asyncpg-style $1 placeholders to SQLite '?' placeholders.

    asyncpg uses ordered $1..$n; SQLite uses positional '?'. Because params are
    supplied positionally in order, a straight replacement preserves semantics
    for the common case where each $n appears once in order. For repeated params
    callers should use db_client instead.
    """
    return _PG_PARAM_RE.sub("?", query)


class _OfflineConnection:
    """asyncpg.Connection-compatible wrapper around a sync sqlite3 connection."""

    def __init__(self, conn: sqlite3.Connection):
        self._conn = conn

    async def fetch(self, query: str, *args) -> list[dict]:
        return await asyncio.to_thread(self._fetch_sync, query, args)

    def _fetch_sync(self, query: str, args) -> list[dict]:
        cur = self._conn.execute(_translate_query(query), list(args))
        rows = cur.fetchall()
        return [dict(row) for row in rows]

    async def fetchrow(self, query: str, *args) -> Optional[dict]:
        return await asyncio.to_thread(self._fetchrow_sync, query, args)

    def _fetchrow_sync(self, query: str, args) -> Optional[dict]:
        cur = self._conn.execute(_translate_query(query), list(args))
        row = cur.fetchone()
        return dict(row) if row else None

    async def fetchval(self, query: str, *args, column: int = 0) -> Any:
        return await asyncio.to_thread(self._fetchval_sync, query, args, column)

    def _fetchval_sync(self, query: str, args, column: int) -> Any:
        cur = self._conn.execute(_translate_query(query), list(args))
        row = cur.fetchone()
        if row is None:
            return None
        return row[column]

    async def execute(self, query: str, *args) -> str:
        return await asyncio.to_thread(self._execute_sync, query, args)

    def _execute_sync(self, query: str, args) -> str:
        self._conn.execute(_translate_query(query), list(args))
        self._conn.commit()
        return "OK"

    async def executemany(self, query: str, args_iter) -> None:
        def _run():
            self._conn.executemany(_translate_query(query), [list(a) for a in args_iter])
            self._conn.commit()

        await asyncio.to_thread(_run)


class _OfflineConnectionPool:
    """asyncpg.Pool-compatible wrapper for offline SQLite."""

    def __init__(self):
        self._db_path = _get_db_path()
        self._schema_loaded = False

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path, timeout=30, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    async def init(self) -> None:
        """Initialize the database and load schema if missing."""
        if self._schema_loaded:
            return

        def _load():
            conn = self._connect()
            try:
                exists = conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='consent_audit'"
                ).fetchone()
                if not exists and os.path.exists(_SCHEMA_FILE):
                    with open(_SCHEMA_FILE, "r", encoding="utf-8") as f:
                        conn.executescript(f.read())
                        conn.commit()
                        logger.info("Loaded offline schema from %s", _SCHEMA_FILE)
            finally:
                conn.close()

        await asyncio.to_thread(_load)
        self._schema_loaded = True

    @asynccontextmanager
    async def acquire(self):
        """asyncpg-style: `async with pool.acquire() as conn:`"""
        await self.init()
        conn = await asyncio.to_thread(self._connect)
        try:
            yield _OfflineConnection(conn)
        finally:
            await asyncio.to_thread(conn.close)

    # Pool-level passthroughs (asyncpg supports pool.fetch(...) etc.)
    async def fetch(self, query: str, *args) -> list[dict]:
        async with self.acquire() as conn:
            return cast(list[dict], await conn.fetch(query, *args))

    async def fetchrow(self, query: str, *args) -> Optional[dict]:
        async with self.acquire() as conn:
            return cast(Optional[dict], await conn.fetchrow(query, *args))

    async def fetchval(self, query: str, *args) -> Any:
        async with self.acquire() as conn:
            return await conn.fetchval(query, *args)

    async def execute(self, query: str, *args) -> str:
        async with self.acquire() as conn:
            return cast(str, await conn.execute(query, *args))

    async def close(self) -> None:
        """Close the pool (no persistent connections to close for SQLite)."""
        return None

    async def status(self) -> dict:
        return {
            "type": "sqlite_offline",
            "path": self._db_path,
            "size_mb": (
                os.path.getsize(self._db_path) / (1024 * 1024)
                if os.path.exists(self._db_path)
                else 0
            ),
        }


_offline_pool: Optional[_OfflineConnectionPool] = None


async def get_offline_pool() -> _OfflineConnectionPool:
    """Return the singleton offline pool, initialized with schema."""
    global _offline_pool
    if _offline_pool is None:
        _offline_pool = _OfflineConnectionPool()
        await _offline_pool.init()
    return _offline_pool


async def get_pool() -> _OfflineConnectionPool:
    """Get the offline connection pool. Called from db/connection.py when DB_OFFLINE=1."""
    return await get_offline_pool()
