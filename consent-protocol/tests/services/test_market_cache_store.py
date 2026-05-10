from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from hushh_mcp.services.market_cache_store import MarketCacheStoreService


def test_normalize_json_value_serializes_nested_non_json_payloads():
    value = {
        "generated_at": datetime(2026, 3, 27, 12, 0, tzinfo=timezone.utc),
        "rows": [
            {
                "price": Decimal("123.45"),
                "bad_number": float("inf"),
                "source_tags": {"alpha", "beta"},
            }
        ],
    }

    normalized = MarketCacheStoreService._normalize_json_value(value)

    assert normalized["generated_at"] == "2026-03-27T12:00:00+00:00"
    assert normalized["rows"][0]["price"] == 123.45
    assert normalized["rows"][0]["bad_number"] is None
    assert sorted(normalized["rows"][0]["source_tags"]) == ["alpha", "beta"]

# Opt-9: ensure_table removed from per-request hot paths

def _make_service_with_table_ready() -> MarketCacheStoreService:
    """Return a service instance that considers the table already initialised."""
    service = MarketCacheStoreService()
    service._table_ready = True
    return service


def _mock_pool_with_conn(fetchrow_return=None, fetch_return=None):
    """Build a mock asyncpg pool + connection sufficient for hot-path tests."""
    conn = AsyncMock()
    conn.fetchrow = AsyncMock(return_value=fetchrow_return)
    conn.fetch = AsyncMock(return_value=fetch_return or [])
    conn.execute = AsyncMock(return_value=None)
    conn.__aenter__ = AsyncMock(return_value=conn)
    conn.__aexit__ = AsyncMock(return_value=None)

    pool = MagicMock()
    pool.acquire = MagicMock(return_value=conn)

    return pool, conn


@pytest.mark.asyncio
async def test_get_entry_does_not_call_ensure_table_when_table_is_ready():
    """`get_entry` must NOT call `ensure_table` — it is guaranteed ready at startup."""
    service = _make_service_with_table_ready()

    ensure_calls = []

    async def spy_ensure_table():
        ensure_calls.append(1)

    service.ensure_table = spy_ensure_table

    pool, conn = _mock_pool_with_conn(fetchrow_return=None)

    with patch("hushh_mcp.services.market_cache_store.get_pool", AsyncMock(return_value=pool)):
        result = await service.get_entry("some-key")

    assert ensure_calls == [], (
        "get_entry called ensure_table; after opt-9 this must never happen on the hot path"
    )
    assert result is None  # fetchrow returned None → entry not found


@pytest.mark.asyncio
async def test_set_entry_does_not_call_ensure_table_when_table_is_ready():
    """`set_entry` must NOT call `ensure_table` — it is guaranteed ready at startup."""
    service = _make_service_with_table_ready()

    ensure_calls = []

    async def spy_ensure_table():
        ensure_calls.append(1)

    service.ensure_table = spy_ensure_table

    pool, conn = _mock_pool_with_conn()

    with patch("hushh_mcp.services.market_cache_store.get_pool", AsyncMock(return_value=pool)):
        await service.set_entry(
            cache_key="test-key",
            payload={"price": 100},
            fresh_ttl_seconds=60,
            stale_ttl_seconds=120,
        )

    assert ensure_calls == [], (
        "set_entry called ensure_table; after opt-9 this must never happen on the hot path"
    )


@pytest.mark.asyncio
async def test_delete_expired_does_not_call_ensure_table_when_table_is_ready():
    """`delete_expired` must NOT call `ensure_table` — it is guaranteed ready at startup."""
    service = _make_service_with_table_ready()

    ensure_calls = []

    async def spy_ensure_table():
        ensure_calls.append(1)

    service.ensure_table = spy_ensure_table

    pool, conn = _mock_pool_with_conn(fetch_return=[])

    with patch("hushh_mcp.services.market_cache_store.get_pool", AsyncMock(return_value=pool)):
        deleted = await service.delete_expired()

    assert ensure_calls == [], (
        "delete_expired called ensure_table; after opt-9 this must never happen on the hot path"
    )
    assert deleted == 0


@pytest.mark.asyncio
async def test_ensure_table_is_idempotent_once_table_is_ready():
    """After `_table_ready=True`, calling `ensure_table` directly must be a no-op (no DB call)."""
    service = _make_service_with_table_ready()

    pool_calls = []

    async def spy_get_pool():
        pool_calls.append(1)
        return MagicMock()

    with patch("hushh_mcp.services.market_cache_store.get_pool", spy_get_pool):
        await service.ensure_table()

    assert pool_calls == [], (
        "ensure_table hit the DB even though _table_ready was True; "
        "the early-return guard is broken"
    )


@pytest.mark.asyncio
async def test_ensure_table_sets_table_ready_flag_on_first_call():
    """On first call (cold start), `ensure_table` must set `_table_ready=True`."""
    service = MarketCacheStoreService()
    assert service._table_ready is False

    conn = AsyncMock()
    conn.execute = AsyncMock(return_value=None)
    conn.__aenter__ = AsyncMock(return_value=conn)
    conn.__aexit__ = AsyncMock(return_value=None)

    pool = MagicMock()
    pool.acquire = MagicMock(return_value=conn)

    with patch("hushh_mcp.services.market_cache_store.get_pool", AsyncMock(return_value=pool)):
        await service.ensure_table()

    assert service._table_ready is True