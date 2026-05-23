from __future__ import annotations

import pytest

from hushh_mcp.operons.kai import fetchers


def test_provider_cooldown_store_is_bounded(monkeypatch):
    monkeypatch.setattr(fetchers, "_PROVIDER_COOLDOWNS_MAX", 2)
    with fetchers._PROVIDER_COOLDOWNS_LOCK:
        fetchers._PROVIDER_COOLDOWNS.clear()

    fetchers._mark_provider_cooldown_for_duration("provider:one", 60)
    fetchers._mark_provider_cooldown_for_duration("provider:two", 60)
    fetchers._mark_provider_cooldown_for_duration("provider:three", 60)

    with fetchers._PROVIDER_COOLDOWNS_LOCK:
        assert len(fetchers._PROVIDER_COOLDOWNS) == 2
        assert "provider:one" not in fetchers._PROVIDER_COOLDOWNS
        assert {"provider:two", "provider:three"} == set(fetchers._PROVIDER_COOLDOWNS)


def test_market_data_cache_is_bounded(monkeypatch):
    monkeypatch.setattr(fetchers, "_MARKET_DATA_CACHE_MAX", 2)
    with fetchers._MARKET_DATA_CACHE_LOCK:
        fetchers._MARKET_DATA_CACHE.clear()

    fetchers._set_cached_market_data("quote:one", {"symbol": "ONE"}, 60)
    fetchers._set_cached_market_data("quote:two", {"symbol": "TWO"}, 60)
    fetchers._set_cached_market_data("quote:three", {"symbol": "THREE"}, 60)

    with fetchers._MARKET_DATA_CACHE_LOCK:
        assert len(fetchers._MARKET_DATA_CACHE) == 2
        assert "quote:one" not in fetchers._MARKET_DATA_CACHE
        assert {"quote:two", "quote:three"} == set(fetchers._MARKET_DATA_CACHE)


@pytest.mark.asyncio
async def test_market_data_lock_cap_preserves_locked_entries(monkeypatch):
    monkeypatch.setattr(fetchers, "_MARKET_DATA_LOCKS_MAX", 1)
    with fetchers._MARKET_DATA_CACHE_LOCK:
        fetchers._MARKET_DATA_LOCKS.clear()
        fetchers._MARKET_DATA_CACHE.clear()

    first_lock = fetchers._get_market_data_lock("quote:one")
    await first_lock.acquire()
    try:
        second_lock = fetchers._get_market_data_lock("quote:two")
        assert first_lock is not second_lock
        assert "quote:one" in fetchers._MARKET_DATA_LOCKS
        assert "quote:two" in fetchers._MARKET_DATA_LOCKS
    finally:
        first_lock.release()
