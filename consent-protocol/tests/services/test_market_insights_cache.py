"""Behavioral tests for MarketInsightsCache.

Covers:
- Fresh-hit: entry within fresh_ttl is returned immediately without calling fetcher
- Miss: fetcher is called when no entry exists; result is stored
- Stale-while-revalidate: stale entry within stale_ttl is served immediately
  while a background refresh fires
- Stale-on-error fallback: fetcher failure within stale_ttl returns stale value
- Hard failure: fetcher failure with no usable fallback re-raises
- Deduplication: concurrent callers share one fetcher call (lock behaviour)
- Series points: append_series_point stores and trims correctly
- Series age filtering: get_series_points drops old points by max_age_seconds
- Provider cooldowns: mark/check/expire cycle
- provider_cooldown_snapshot: returns remaining seconds, evicts expired keys
"""

from __future__ import annotations

import asyncio
import time

import pytest

from hushh_mcp.services.market_insights_cache import MarketInsightsCache

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _cache() -> MarketInsightsCache:
    return MarketInsightsCache()


async def _ok_fetcher(value: object = "fresh"):
    return value


async def _fail_fetcher():
    raise RuntimeError("upstream down")


def _run(coro):
    """Run an async coroutine synchronously (no pytest-asyncio needed)."""
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# Fresh-hit: within TTL, fetcher must NOT be called
# ---------------------------------------------------------------------------


def test_fresh_hit_returns_cached_value_without_calling_fetcher():
    cache = _cache()
    cache.seed_entry("k", "initial", time.time())

    called = []

    async def _unexpected_fetcher():
        called.append(True)
        return "should not be called"

    result = _run(
        cache.get_or_refresh(
            "k", fresh_ttl_seconds=60, stale_ttl_seconds=300, fetcher=_unexpected_fetcher
        )
    )

    assert result.value == "initial"
    assert result.stale is False
    assert called == []


# ---------------------------------------------------------------------------
# Miss: no entry → fetcher is called, result stored
# ---------------------------------------------------------------------------


def test_miss_calls_fetcher_and_stores_result():
    cache = _cache()

    result = _run(
        cache.get_or_refresh(
            "k", fresh_ttl_seconds=60, stale_ttl_seconds=300, fetcher=lambda: _ok_fetcher("fetched")
        )
    )

    assert result.value == "fetched"
    assert result.stale is False
    assert result.age_seconds == 0

    entry = cache.peek("k")
    assert entry is not None
    assert entry.value == "fetched"


# ---------------------------------------------------------------------------
# Stale-while-revalidate: stale entry served immediately, background refresh fires
# ---------------------------------------------------------------------------


def test_stale_while_revalidate_returns_stale_immediately():
    async def _inner():
        cache = _cache()
        old_ts = time.time() - 120  # 120s ago: beyond fresh_ttl(60) but within stale_ttl(300)
        cache.seed_entry("k", "old_value", old_ts)

        refresh_calls = []

        async def _refresh():
            refresh_calls.append(True)
            return "new_value"

        result = await cache.get_or_refresh(
            "k",
            fresh_ttl_seconds=60,
            stale_ttl_seconds=300,
            fetcher=_refresh,
            serve_stale_while_revalidate=True,
        )

        assert result.value == "old_value"
        assert result.stale is True
        assert result.stale_reason == "revalidate"

        # Allow background task to complete
        await asyncio.sleep(0.05)

        entry = cache.peek("k")
        assert entry is not None
        assert entry.value == "new_value"

    _run(_inner())


# ---------------------------------------------------------------------------
# Stale-on-error fallback: fetcher error within stale_ttl → stale returned
# ---------------------------------------------------------------------------


def test_stale_on_error_fallback_returns_stale_value():
    cache = _cache()
    old_ts = time.time() - 90  # 90s ago: beyond fresh_ttl but within stale_ttl(300)
    cache.seed_entry("k", "last_good", old_ts)

    result = _run(
        cache.get_or_refresh(
            "k", fresh_ttl_seconds=60, stale_ttl_seconds=300, fetcher=_fail_fetcher
        )
    )

    assert result.value == "last_good"
    assert result.stale is True
    assert result.stale_reason == "refresh_failure"


# ---------------------------------------------------------------------------
# Hard failure: fetcher error + no usable fallback → raises
# ---------------------------------------------------------------------------


def test_hard_failure_raises_when_no_fallback():
    cache = _cache()

    with pytest.raises(RuntimeError, match="upstream down"):
        _run(
            cache.get_or_refresh(
                "k", fresh_ttl_seconds=60, stale_ttl_seconds=300, fetcher=_fail_fetcher
            )
        )


def test_hard_failure_raises_when_fallback_is_beyond_stale_ttl():
    cache = _cache()
    very_old_ts = time.time() - 400  # 400s ago: beyond stale_ttl(300)
    cache.seed_entry("k", "too_old", very_old_ts)

    with pytest.raises(RuntimeError, match="upstream down"):
        _run(
            cache.get_or_refresh(
                "k", fresh_ttl_seconds=60, stale_ttl_seconds=300, fetcher=_fail_fetcher
            )
        )


# ---------------------------------------------------------------------------
# Double-checked locking: second caller within lock sees fresh entry
# ---------------------------------------------------------------------------


def test_second_caller_under_lock_skips_fetcher():
    async def _inner():
        cache = _cache()
        call_count = []

        async def _slow_fetcher():
            call_count.append(1)
            await asyncio.sleep(0.01)
            return "result"

        await asyncio.gather(
            cache.get_or_refresh(
                "k", fresh_ttl_seconds=60, stale_ttl_seconds=300, fetcher=_slow_fetcher
            ),
            cache.get_or_refresh(
                "k", fresh_ttl_seconds=60, stale_ttl_seconds=300, fetcher=_slow_fetcher
            ),
        )

        assert len(call_count) == 1

    _run(_inner())


# ---------------------------------------------------------------------------
# Series points
# ---------------------------------------------------------------------------


def test_append_series_point_stores_value():
    cache = _cache()
    cache.append_series_point("price", 100.0)
    points = cache.get_series_points("price", max_age_seconds=3600)

    assert len(points) == 1
    _ts, value = points[0]
    assert value == 100.0


def test_append_series_respects_max_points_cap():
    cache = _cache()
    for i in range(150):
        cache.append_series_point("price", float(i), max_points=100)

    points = cache.get_series_points("price", max_age_seconds=3600)
    assert len(points) == 100
    assert points[-1][1] == 149.0


def test_get_series_points_filters_by_max_age():
    cache = _cache()
    old_ts = time.time() - 7200  # 2 hours ago
    recent_ts = time.time() - 10

    cache.append_series_point("price", 50.0, timestamp=old_ts)
    cache.append_series_point("price", 75.0, timestamp=recent_ts)

    points = cache.get_series_points("price", max_age_seconds=3600)
    assert len(points) == 1
    assert points[0][1] == 75.0


def test_get_series_points_empty_key_returns_empty_list():
    cache = _cache()
    points = cache.get_series_points("nonexistent", max_age_seconds=3600)
    assert points == []


def test_append_series_point_with_zero_max_points_is_noop():
    cache = _cache()
    cache.append_series_point("price", 99.0, max_points=0)
    points = cache.get_series_points("price", max_age_seconds=3600)
    assert points == []


# ---------------------------------------------------------------------------
# Provider cooldowns
# ---------------------------------------------------------------------------


def test_mark_provider_cooldown_sets_cooldown():
    cache = _cache()
    cache.mark_provider_cooldown("provider_x", 30)
    assert cache.is_provider_in_cooldown("provider_x") is True


def test_is_provider_in_cooldown_false_for_unknown_key():
    cache = _cache()
    assert cache.is_provider_in_cooldown("nobody") is False


def test_mark_provider_cooldown_zero_seconds_is_noop():
    cache = _cache()
    cache.mark_provider_cooldown("provider_y", 0)
    assert cache.is_provider_in_cooldown("provider_y") is False


def test_cooldown_expires_after_time_passes():
    cache = _cache()
    cache._provider_cooldowns["provider_z"] = time.time() - 1  # already expired

    assert cache.is_provider_in_cooldown("provider_z") is False
    assert "provider_z" not in cache._provider_cooldowns


def test_provider_cooldown_snapshot_returns_remaining_seconds():
    cache = _cache()
    cache.mark_provider_cooldown("p1", 60)
    cache.mark_provider_cooldown("p2", 120)

    snapshot = cache.provider_cooldown_snapshot()
    assert "p1" in snapshot
    assert "p2" in snapshot
    assert 1 <= snapshot["p1"] <= 60
    assert 1 <= snapshot["p2"] <= 120


def test_provider_cooldown_snapshot_evicts_expired_entries():
    cache = _cache()
    cache._provider_cooldowns["expired"] = time.time() - 1

    snapshot = cache.provider_cooldown_snapshot()
    assert "expired" not in snapshot
    assert "expired" not in cache._provider_cooldowns
