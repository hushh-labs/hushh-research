import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from hushh_mcp.services.market_cache_store import MarketCacheStoreEntry, MarketCacheStoreService

# ---------------------------------------------------------------------------
# MarketCacheStoreEntry — pure method tests (no DB required)
# ---------------------------------------------------------------------------

_NOW = 1_700_000_000.0  # fixed epoch second for deterministic checks


def _make_entry(
    *,
    fresh_until: float,
    stale_until: float,
    updated_at: float = _NOW - 60,
) -> MarketCacheStoreEntry:
    return MarketCacheStoreEntry(
        cache_key="test-key",
        payload={"value": 42},
        fresh_until_ts=fresh_until,
        stale_until_ts=stale_until,
        updated_at_ts=updated_at,
        provider_status={},
    )


class TestMarketCacheStoreEntryIsFresh:
    def test_fresh_when_now_before_fresh_until(self):
        entry = _make_entry(fresh_until=_NOW + 60, stale_until=_NOW + 120)
        assert entry.is_fresh(now_ts=_NOW) is True

    def test_still_fresh_when_now_equals_fresh_until(self):
        # is_fresh uses <=, so exact equality still counts as fresh
        entry = _make_entry(fresh_until=_NOW, stale_until=_NOW + 60)
        assert entry.is_fresh(now_ts=_NOW) is True

    def test_not_fresh_when_now_past_fresh_until(self):
        entry = _make_entry(fresh_until=_NOW - 1, stale_until=_NOW + 60)
        assert entry.is_fresh(now_ts=_NOW) is False


class TestMarketCacheStoreEntryIsStaleServable:
    def test_stale_servable_when_now_before_stale_until(self):
        entry = _make_entry(fresh_until=_NOW - 10, stale_until=_NOW + 120)
        assert entry.is_stale_servable(now_ts=_NOW) is True

    def test_still_stale_servable_when_now_equals_stale_until(self):
        # is_stale_servable uses <=, so exact equality still counts as servable
        entry = _make_entry(fresh_until=_NOW - 10, stale_until=_NOW)
        assert entry.is_stale_servable(now_ts=_NOW) is True

    def test_not_stale_servable_when_now_past_stale_until(self):
        entry = _make_entry(fresh_until=_NOW - 10, stale_until=_NOW - 1)
        assert entry.is_stale_servable(now_ts=_NOW) is False

    def test_fresh_entry_is_also_stale_servable(self):
        entry = _make_entry(fresh_until=_NOW + 60, stale_until=_NOW + 120)
        assert entry.is_fresh(now_ts=_NOW) is True
        assert entry.is_stale_servable(now_ts=_NOW) is True


class TestMarketCacheStoreEntryAgeSeconds:
    def test_age_reflects_seconds_since_updated_at(self):
        entry = _make_entry(
            fresh_until=_NOW + 60,
            stale_until=_NOW + 120,
            updated_at=_NOW - 300,
        )
        assert entry.age_seconds(now_ts=_NOW) == 300

    def test_age_is_zero_when_updated_at_in_future(self):
        entry = _make_entry(
            fresh_until=_NOW + 60,
            stale_until=_NOW + 120,
            updated_at=_NOW + 10,
        )
        assert entry.age_seconds(now_ts=_NOW) == 0

    def test_age_is_zero_when_updated_at_equals_now(self):
        entry = _make_entry(
            fresh_until=_NOW + 60,
            stale_until=_NOW + 120,
            updated_at=_NOW,
        )
        assert entry.age_seconds(now_ts=_NOW) == 0

    def test_age_truncates_fractional_seconds(self):
        entry = _make_entry(
            fresh_until=_NOW + 60,
            stale_until=_NOW + 120,
            updated_at=_NOW - 90.9,
        )
        assert entry.age_seconds(now_ts=_NOW) == 90


class TestMarketCacheStoreToTs:
    def test_aware_datetime_converted_correctly(self):
        dt = datetime(2024, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
        result = MarketCacheStoreService._to_ts(dt)
        assert result == dt.timestamp()

    def test_naive_datetime_treated_as_utc(self):
        naive = datetime(2024, 1, 1, 12, 0, 0)
        aware = naive.replace(tzinfo=timezone.utc)
        result = MarketCacheStoreService._to_ts(naive)
        assert result == aware.timestamp()

    def test_int_input_returns_float(self):
        result = MarketCacheStoreService._to_ts(1_700_000_000)
        assert result == 1_700_000_000.0
        assert isinstance(result, float)

    def test_float_input_returned_as_is(self):
        result = MarketCacheStoreService._to_ts(1_700_000_000.5)
        assert result == 1_700_000_000.5


class TestMarketCacheStoreToJsonObj:
    def test_dict_returned_as_is(self):
        d = {"a": 1}
        assert MarketCacheStoreService._to_json_obj(d) is d

    def test_list_returned_as_is(self):
        lst = [1, 2, 3]
        assert MarketCacheStoreService._to_json_obj(lst) is lst

    def test_valid_json_string_parsed_to_dict(self):
        result = MarketCacheStoreService._to_json_obj('{"key": "value"}')
        assert result == {"key": "value"}

    def test_valid_json_string_parsed_to_list(self):
        result = MarketCacheStoreService._to_json_obj("[1, 2, 3]")
        assert result == [1, 2, 3]

    def test_invalid_json_string_returned_as_is(self):
        raw = "not-json"
        result = MarketCacheStoreService._to_json_obj(raw)
        assert result == raw

    def test_non_dict_non_list_json_string_returned_as_is(self):
        result = MarketCacheStoreService._to_json_obj('"just a string"')
        assert result == '"just a string"'


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


@pytest.mark.asyncio
async def test_advisory_refresh_keeps_request_pool_free_for_cache_writes():
    """A one-slot request pool must remain usable while the refresh owns its lock."""
    service = _make_service_with_table_ready()
    request_slot = asyncio.Semaphore(1)
    request_conn = AsyncMock()
    request_conn.fetchval.return_value = True

    @asynccontextmanager
    async def acquire_request_conn():
        async with request_slot:
            yield request_conn

    pool = MagicMock()
    pool.acquire = acquire_request_conn
    get_pool = AsyncMock(return_value=pool)
    lock_conn = AsyncMock()
    lock_conn.fetchval.return_value = True
    connect = AsyncMock(return_value=lock_conn)

    async def write_from_refresh():
        await service.set_entry(
            cache_key="macro:us",
            payload={"value": 1},
            fresh_ttl_seconds=60,
            stale_ttl_seconds=120,
        )

    with (
        patch("hushh_mcp.services.market_cache_store._is_offline_mode", return_value=False),
        patch("hushh_mcp.services.market_cache_store.get_pool", get_pool),
        patch("hushh_mcp.services.market_cache_store.open_dedicated_connection", connect),
    ):
        acquired = await asyncio.wait_for(
            service.try_with_advisory_lock(lock_key=42, callback=write_from_refresh),
            timeout=0.5,
        )

    assert acquired is True
    assert get_pool.await_count == 1  # The callback's L2 write only.
    request_conn.execute.assert_awaited_once()
    lock_conn.fetchval.assert_awaited_once_with("SELECT pg_try_advisory_lock($1)", 42)
    lock_conn.close.assert_awaited_once_with(timeout=5)


@pytest.mark.asyncio
async def test_advisory_lock_miss_closes_session_without_running_callback():
    service = MarketCacheStoreService()
    lock_conn = AsyncMock()
    lock_conn.fetchval.return_value = False
    callback = AsyncMock()

    with (
        patch("hushh_mcp.services.market_cache_store._is_offline_mode", return_value=False),
        patch(
            "hushh_mcp.services.market_cache_store.open_dedicated_connection",
            AsyncMock(return_value=lock_conn),
        ),
    ):
        acquired = await service.try_with_advisory_lock(lock_key=42, callback=callback)

    assert acquired is False
    callback.assert_not_awaited()
    lock_conn.close.assert_awaited_once_with(timeout=5)


@pytest.mark.asyncio
async def test_advisory_lock_callback_cancellation_closes_session():
    service = MarketCacheStoreService()
    lock_conn = AsyncMock()
    lock_conn.fetchval.return_value = True
    lock_conn.close.side_effect = RuntimeError("close failed")
    lock_conn.terminate = MagicMock()
    callback_started = asyncio.Event()

    async def blocked_callback():
        callback_started.set()
        await asyncio.Event().wait()

    with (
        patch("hushh_mcp.services.market_cache_store._is_offline_mode", return_value=False),
        patch(
            "hushh_mcp.services.market_cache_store.open_dedicated_connection",
            AsyncMock(return_value=lock_conn),
        ),
    ):
        task = asyncio.create_task(
            service.try_with_advisory_lock(lock_key=42, callback=blocked_callback)
        )
        await callback_started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    lock_conn.close.assert_awaited_once_with(timeout=5)
    lock_conn.terminate.assert_called_once()


@pytest.mark.asyncio
async def test_offline_market_refresh_keeps_existing_unlocked_behavior():
    service = MarketCacheStoreService()
    callback = AsyncMock()
    connect = AsyncMock()

    with (
        patch("hushh_mcp.services.market_cache_store._is_offline_mode", return_value=True),
        patch("hushh_mcp.services.market_cache_store.open_dedicated_connection", connect),
    ):
        acquired = await service.try_with_advisory_lock(lock_key=42, callback=callback)

    assert acquired is True
    callback.assert_awaited_once()
    connect.assert_not_awaited()
