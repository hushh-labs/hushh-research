"""Postgres-backed L2 cache for Kai generalized market modules.

Read/write policy:
- L1: process-local in-memory cache
- L2: Postgres table `kai_market_cache_entries`
- L3: external live providers

This service only stores non-sensitive generalized market payloads.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Awaitable, Callable

from db.connection import get_pool

logger = logging.getLogger(__name__)


@dataclass
class MarketCacheStoreEntry:
    cache_key: str
    payload: Any
    fresh_until_ts: float
    stale_until_ts: float
    updated_at_ts: float
    provider_status: dict[str, Any]

    def is_fresh(self, now_ts: float | None = None) -> bool:
        now = time.time() if now_ts is None else now_ts
        return now <= self.fresh_until_ts

    def is_stale_servable(self, now_ts: float | None = None) -> bool:
        now = time.time() if now_ts is None else now_ts
        return now <= self.stale_until_ts

    def age_seconds(self, now_ts: float | None = None) -> int:
        now = time.time() if now_ts is None else now_ts
        return max(0, int(now - self.updated_at_ts))


class MarketCacheStoreService:
    def __init__(self) -> None:
        self._table_ready = False
        self._init_lock = asyncio.Lock()

    async def ensure_table(self) -> None:
        if self._table_ready:
            return
        async with self._init_lock:
            if self._table_ready:
                return
            pool = await get_pool()
            async with pool.acquire() as conn:
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS kai_market_cache_entries (
                        cache_key TEXT PRIMARY KEY,
                        payload_json JSONB NOT NULL,
                        fresh_until TIMESTAMPTZ NOT NULL,
                        stale_until TIMESTAMPTZ NOT NULL,
                        provider_status_json JSONB DEFAULT '{}'::jsonb,
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_kai_market_cache_fresh_until ON kai_market_cache_entries(fresh_until)"
                )
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_kai_market_cache_stale_until ON kai_market_cache_entries(stale_until)"
                )
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_kai_market_cache_updated_at ON kai_market_cache_entries(updated_at DESC)"
                )
            self._table_ready = True

    @staticmethod
    def _to_ts(value: Any) -> float:
        if isinstance(value, datetime):
            if value.tzinfo is None:
                value = value.replace(tzinfo=timezone.utc)
            return value.timestamp()
        if isinstance(value, (int, float)):
            return float(value)
        return time.time()

    @staticmethod
    def _to_json_obj(value: Any) -> Any:
        if isinstance(value, (dict, list)):
            return value
        if isinstance(value, str):
            try:
                parsed = json.loads(value)
                if isinstance(parsed, (dict, list)):
                    return parsed
            except Exception:
                return value
        return value

    @classmethod
    def _normalize_json_value(cls, value: Any) -> Any:
        if value is None or isinstance(value, (bool, int, str)):
            return value
        if isinstance(value, float):
            return value if math.isfinite(value) else None
        if isinstance(value, Decimal):
            return float(value) if value.is_finite() else None
        if isinstance(value, datetime):
            normalized = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
            return normalized.isoformat()
        if isinstance(value, (tuple, list, set)):
            return [cls._normalize_json_value(item) for item in value]
        if isinstance(value, dict):
            return {str(key): cls._normalize_json_value(item) for key, item in value.items()}
        return str(value)

    async def get_entry(self, cache_key: str) -> MarketCacheStoreEntry | None:
        await self.ensure_table()
        pool = await get_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT
                    cache_key,
                    payload_json,
                    fresh_until,
                    stale_until,
                    updated_at,
                    provider_status_json
                FROM kai_market_cache_entries
                WHERE cache_key = $1
                """,
                cache_key,
            )
        if row is None:
            return None

        return MarketCacheStoreEntry(
            cache_key=str(row["cache_key"]),
            payload=self._to_json_obj(row["payload_json"]),
            fresh_until_ts=self._to_ts(row["fresh_until"]),
            stale_until_ts=self._to_ts(row["stale_until"]),
            updated_at_ts=self._to_ts(row["updated_at"]),
            provider_status=(
                self._to_json_obj(row["provider_status_json"])
                if isinstance(self._to_json_obj(row["provider_status_json"]), dict)
                else {}
            ),
        )

    async def set_entry(
        self,
        *,
        cache_key: str,
        payload: Any,
        fresh_ttl_seconds: int,
        stale_ttl_seconds: int,
        provider_status: dict[str, Any] | None = None,
    ) -> None:
        await self.ensure_table()

        now = datetime.now(timezone.utc)
        fresh_until = now.timestamp() + max(1, int(fresh_ttl_seconds))
        stale_until = now.timestamp() + max(1, int(stale_ttl_seconds))
        normalized_payload = self._normalize_json_value(payload)
        provider_payload = self._normalize_json_value(provider_status or {})

        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO kai_market_cache_entries (
                    cache_key,
                    payload_json,
                    fresh_until,
                    stale_until,
                    provider_status_json,
                    updated_at
                )
                VALUES (
                    $1,
                    $2::jsonb,
                    to_timestamp($3),
                    to_timestamp($4),
                    $5::jsonb,
                    NOW()
                )
                ON CONFLICT (cache_key)
                DO UPDATE SET
                    payload_json = EXCLUDED.payload_json,
                    fresh_until = EXCLUDED.fresh_until,
                    stale_until = EXCLUDED.stale_until,
                    provider_status_json = EXCLUDED.provider_status_json,
                    updated_at = NOW()
                """,
                cache_key,
                json.dumps(normalized_payload, separators=(",", ":"), ensure_ascii=False),
                fresh_until,
                stale_until,
                json.dumps(provider_payload, separators=(",", ":"), ensure_ascii=False),
            )

    async def delete_expired(self, *, max_rows: int = 500) -> int:
        await self.ensure_table()
        pool = await get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                DELETE FROM kai_market_cache_entries
                WHERE cache_key IN (
                    SELECT cache_key
                    FROM kai_market_cache_entries
                    WHERE stale_until < NOW()
                    ORDER BY stale_until ASC
                    LIMIT $1
                )
                RETURNING cache_key
                """,
                max(1, int(max_rows)),
            )
        deleted = len(rows)
        if deleted:
            logger.info("[Kai Market Cache] purged %s expired L2 rows", deleted)
        return deleted

    async def try_with_advisory_lock(
        self,
        *,
        lock_key: int,
        callback: Callable[[], Awaitable[None]],
    ) -> bool:
        """Run callback only if advisory lock was acquired on this DB connection."""
        pool = await get_pool()
        async with pool.acquire() as conn:
            acquired = await conn.fetchval("SELECT pg_try_advisory_lock($1)", int(lock_key))
            if not acquired:
                return False
            try:
                await callback()
                return True
            finally:
                await conn.execute("SELECT pg_advisory_unlock($1)", int(lock_key))


_market_cache_store_service: MarketCacheStoreService | None = None


def get_market_cache_store_service() -> MarketCacheStoreService:
    global _market_cache_store_service
    if _market_cache_store_service is None:
        _market_cache_store_service = MarketCacheStoreService()
    return _market_cache_store_service
