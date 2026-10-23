from __future__ import annotations

from datetime import datetime

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


def test_preopen_provider_cache_expires_at_open_without_rejecting_delayed_quotes(monkeypatch):
    now = [datetime.fromisoformat("2026-07-14T13:29:59+00:00").timestamp()]
    monkeypatch.setattr(fetchers.time, "time", lambda: now[0])
    monkeypatch.setattr(fetchers, "_MARKET_DATA_CACHE", {})
    payload = {"price": 100, "quoted_at": "2026-07-14T13:15:00Z", "is_delayed": True}
    fetchers._set_cached_market_data("quote:one", payload, 1800)
    assert fetchers._get_cached_market_data("quote:one") == payload

    now[0] += 1
    assert fetchers._get_cached_market_data("quote:one") is None
    fetchers._set_cached_market_data("quote:one", payload, 1800)
    # Fetch time controls cache validity, not the potentially delayed quote time.
    assert fetchers._get_cached_market_data("quote:one") == payload
    now[0] += 120
    assert fetchers._get_cached_market_data("quote:one") is None


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["single", "batch"])
async def test_provider_request_spanning_open_is_not_cached_as_current_session(monkeypatch, mode):
    now = [datetime.fromisoformat("2026-07-14T13:29:59+00:00").timestamp()]
    monkeypatch.setattr(fetchers.time, "time", lambda: now[0])
    monkeypatch.setattr(fetchers, "_MARKET_DATA_CACHE", {})
    monkeypatch.setattr(fetchers, "_MARKET_DATA_LOCKS", {})
    monkeypatch.setattr(fetchers, "_provider_in_cooldown", lambda _: False)
    monkeypatch.setenv("FINNHUB_API_KEY", "test")
    monkeypatch.delenv("PMP_API_KEY", raising=False)

    async def quote(_):
        now[0] += 1
        return {"ticker": "AAPL", "price": 100}

    async def quotes(symbols):
        return [await quote(symbols)]

    monkeypatch.setattr(fetchers, "_fetch_finnhub_quote", quote)
    monkeypatch.setattr(fetchers, "_fetch_yahoo_quotes", quotes)
    if mode == "single":
        # Exercise the existing inner cache fence independently of the new
        # public closed-session gate, which now refuses pre-open refreshes.
        await fetchers._legacy_fetch_market_data("AAPL", "public", allow_slow_fallbacks=False)
    else:
        await fetchers._legacy_fetch_market_data_batch(["AAPL"], "public")
    key = fetchers._market_data_cache_key("AAPL", finnhub_enabled=True, pmp_enabled=False)
    assert fetchers._get_cached_market_data(key) is None
