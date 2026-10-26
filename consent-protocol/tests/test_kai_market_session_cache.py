from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from api.routes.kai import market_insights
from api.routes.kai._shared_last_close import (
    INDEX_LAST_CLOSE_KEY,
    INDEX_SYMBOLS,
    QuotesUnavailable,
    SharedLastClose,
    picks_key,
)
from hushh_mcp.services import market_insights_cache as cache_module
from hushh_mcp.services.market_insights_cache import MarketInsightsCache
from tests.helpers.market_public_cache import (  # noqa: F401
    _FakeEntry,
    _FakeStore,
    _payload_fetcher,
    regular_session_clock,
)


@pytest.mark.asyncio
@pytest.mark.parametrize("tier", ["memory", "postgres"])
@pytest.mark.parametrize(
    ("instant", "age"),
    [("2026-07-14T13:30:00+00:00", 1), ("2026-07-14T13:40:00+00:00", 121)],
)
async def test_open_session_revalidates_old_snapshots_across_cache_tiers(
    monkeypatch, tier, instant, age
):
    now = datetime.fromisoformat(instant).timestamp()
    monkeypatch.setattr(market_insights, "time", lambda: now)
    monkeypatch.setattr(cache_module.time, "time", lambda: now)
    monkeypatch.setattr(market_insights, "_us_market_is_open", lambda: True)
    store = _FakeStore()
    cache = MarketInsightsCache()
    key = "quotes:AAPL"
    old = {"rows": [{"price": 100}]}
    if tier == "memory":
        cache.seed_entry(key, old, now - age)
    else:
        store.entries[key] = _FakeEntry(old, now - age, now + 1800, now + 3600)
    monkeypatch.setattr(market_insights, "get_market_cache_store_service", lambda: store)
    monkeypatch.setattr(market_insights, "market_insights_cache", cache)
    calls = []

    async def fetch():
        calls.append(True)
        return {"rows": [{"price": 101}]}

    result = await market_insights._get_or_refresh_public_module(
        key=key,
        fresh_ttl_seconds=600,
        stale_ttl_seconds=1800,
        fetcher=fetch,
    )
    assert result[0]["rows"][0]["price"] == 101
    assert result[1] is False
    assert calls == [True]
    # The current session is then reusable rather than refetched by every caller.
    await market_insights._get_or_refresh_public_module(
        key=key,
        fresh_ttl_seconds=600,
        stale_ttl_seconds=1800,
        fetcher=fetch,
    )
    assert calls == [True]


@pytest.mark.asyncio
async def test_warmer_recalculates_cadence_and_does_not_sleep_past_open(monkeypatch):
    intervals = iter([1800, 120])
    openings = iter([30, 10000])
    sleeps = []
    calls = 0

    async def refresh():
        nonlocal calls
        calls += 1
        if calls == 3:
            raise asyncio.CancelledError

    async def sleep(delay):
        sleeps.append(delay)

    monkeypatch.setattr(market_insights, "_run_refresh_with_advisory_lock", refresh)
    monkeypatch.setattr(
        market_insights, "_market_refresh_interval_seconds", lambda: next(intervals)
    )
    monkeypatch.setattr(market_insights, "seconds_until_us_market_open", lambda: next(openings))
    monkeypatch.setattr(market_insights.secrets, "randbelow", lambda _: 0)
    monkeypatch.setattr(market_insights.asyncio, "sleep", sleep)
    with pytest.raises(asyncio.CancelledError):
        await market_insights._market_refresh_loop()
    assert sleeps == [30, 120]


@pytest.mark.asyncio
async def test_snapshot_build_spanning_open_rebuilds_preopen_nested_content(monkeypatch):
    opening = datetime.fromisoformat("2026-07-14T13:30:00+00:00").timestamp()
    now = [opening - 1]
    monkeypatch.setattr(market_insights, "time", lambda: now[0])
    monkeypatch.setattr(cache_module.time, "time", lambda: now[0])
    monkeypatch.setattr(market_insights, "_us_market_is_open", lambda: now[0] >= opening)
    monkeypatch.setattr(market_insights, "get_market_cache_store_service", _FakeStore)
    monkeypatch.setattr(market_insights, "market_insights_cache", MarketInsightsCache())
    calls = []

    async def fetch():
        calls.append(True)
        price = 100 if now[0] < opening else 101
        now[0] = opening + 1
        return {"rows": [{"price": price}]}

    result = await market_insights._get_or_refresh_public_module(
        key="home:baseline:opening",
        fresh_ttl_seconds=600,
        stale_ttl_seconds=1800,
        fetcher=fetch,
    )
    assert result[0]["rows"][0]["price"] == 101
    assert calls == [True, True]


@pytest.mark.parametrize("tier", ["memory", "postgres"])
@pytest.mark.parametrize("key", ["quotes:AAPL", "movers:v2:us", "sectors:v2:us", "macro:v2:us"])
async def test_closed_price_modules_keep_last_session_without_refresh(monkeypatch, tier, key):
    now = datetime.fromisoformat("2026-07-19T16:00:00+00:00").timestamp()
    saved_at = datetime.fromisoformat("2026-07-17T19:59:00+00:00").timestamp()
    monkeypatch.setattr(cache_module.time, "time", lambda: now)
    store, cache = _FakeStore(), MarketInsightsCache()
    saved = {"rows": [{"price": 100, "as_of": "2026-07-17T19:45:00Z"}]}
    if tier == "memory":
        cache.seed_entry(key, saved, saved_at)
    else:
        store.entries[key] = _FakeEntry(saved, saved_at, saved_at + 600, saved_at + 1800)
    monkeypatch.setattr(market_insights, "get_market_cache_store_service", lambda: store)
    monkeypatch.setattr(market_insights, "market_insights_cache", cache)
    calls = []

    async def forbidden():
        calls.append(True)
        return {"rows": []}

    for _ in range(2):
        result = await market_insights._get_or_refresh_public_module(
            key=key, fresh_ttl_seconds=600, stale_ttl_seconds=1800, fetcher=forbidden
        )
        assert result == (saved, True, int(now - saved_at), tier, True)
    await asyncio.sleep(0)
    assert calls == []
    assert cache.peek(key).fetched_at == saved_at


async def test_closed_cold_prices_are_unavailable_but_news_still_refreshes(monkeypatch):
    from hushh_mcp.services.market_refresh_policy import MarketPriceRefreshPaused

    now = datetime.fromisoformat("2026-07-19T16:00:00+00:00").timestamp()
    monkeypatch.setattr(cache_module.time, "time", lambda: now)
    monkeypatch.setattr(market_insights, "get_market_cache_store_service", _FakeStore)
    monkeypatch.setattr(market_insights, "market_insights_cache", MarketInsightsCache())
    calls = []

    async def fetch():
        calls.append(True)
        return {"items": [{"title": "After-hours filing"}]}

    with pytest.raises(MarketPriceRefreshPaused, match="market_closed_no_cached_price"):
        await market_insights._get_or_refresh_public_module(
            key="quotes:AAPL", fresh_ttl_seconds=600, stale_ttl_seconds=1800, fetcher=fetch
        )
    assert calls == []
    result = await market_insights._get_or_refresh_public_module(
        key="news:AAPL", fresh_ttl_seconds=600, stale_ttl_seconds=1800, fetcher=fetch
    )
    assert result[0]["items"][0]["title"] == "After-hours filing"
    assert calls == [True]


@pytest.mark.parametrize(
    ("key", "age_days", "replayed"),
    [
        (INDEX_LAST_CLOSE_KEY, 5, True),
        (INDEX_LAST_CLOSE_KEY, 8, False),
        (picks_key(["AAPL", "ADBE"]), 5, True),
        # Same saved row under a per-viewer key is older than the last session: refused.
        ("quotes:AAPL", 5, False),
    ],
)
async def test_index_last_close_replays_for_a_week_past_the_last_session(
    monkeypatch, key, age_days, replayed
):
    from hushh_mcp.services.market_refresh_policy import MarketPriceRefreshPaused

    now = datetime.fromisoformat("2026-07-20T01:00:00+00:00").timestamp()  # Monday, closed
    saved_at = now - age_days * 24 * 60 * 60
    monkeypatch.setattr(cache_module.time, "time", lambda: now)
    store = _FakeStore()
    saved = {"quotes": {"^GSPC": {"price": 100, "quoted_at": "2026-07-15T19:59:00Z"}}}
    store.entries[key] = _FakeEntry(saved, saved_at, saved_at + 600, saved_at + 7 * 24 * 60 * 60)
    monkeypatch.setattr(market_insights, "get_market_cache_store_service", lambda: store)
    monkeypatch.setattr(market_insights, "market_insights_cache", MarketInsightsCache())
    calls = []

    async def forbidden():
        calls.append(True)
        return {}

    read = market_insights._get_or_refresh_public_module(
        key=key, fresh_ttl_seconds=600, stale_ttl_seconds=1800, fetcher=forbidden
    )
    if replayed:
        assert await read == (saved, True, int(now - saved_at), "postgres", True)
    else:
        with pytest.raises(MarketPriceRefreshPaused):
            await read
    assert calls == []


@pytest.mark.parametrize("entry", ["indices", "picks"])
async def test_empty_refresh_cannot_replace_a_saved_last_close(monkeypatch, entry):
    now = datetime.fromisoformat("2026-07-20T14:00:00+00:00").timestamp()  # Monday, open
    saved_at = datetime.fromisoformat("2026-07-17T19:50:00+00:00").timestamp()
    monkeypatch.setattr(cache_module.time, "time", lambda: now)
    store = _FakeStore()
    saved = {
        "quotes": {"AAPL": {"price": 100, "quoted_at": "2026-07-17T19:49:00Z"}},
        "provider_status": {"quote:AAPL": "ok"},
    }
    key = INDEX_LAST_CLOSE_KEY if entry == "indices" else picks_key(["AAPL"])
    store.entries[key] = _FakeEntry(saved, saved_at, saved_at + 600, saved_at + 7 * 24 * 60 * 60)
    monkeypatch.setattr(market_insights, "get_market_cache_store_service", lambda: store)
    monkeypatch.setattr(market_insights, "market_insights_cache", MarketInsightsCache())
    monkeypatch.setattr(market_insights, "fetch_market_data_batch", AsyncMock(return_value={}))
    monkeypatch.setattr(market_insights, "fetch_market_data", AsyncMock(side_effect=RuntimeError))

    shared = market_insights._shared_quotes()
    read = (
        shared.load_indices("request") if entry == "indices" else shared.load_picks(["AAPL"], "x")
    )
    value, stale, *_ = await read
    assert value == saved and stale is True
    assert store.entries[key].payload == saved


@pytest.mark.parametrize("budget_critical", [False, True])
async def test_open_warmer_refreshes_shared_quotes_first_and_regardless_of_the_fmp_budget(
    monkeypatch, budget_critical
):
    keys = []

    async def module(**kwargs):
        keys.append(kwargs["key"])
        return {}, False, 0, "live", False

    monkeypatch.setattr(market_insights, "_us_market_is_open", lambda: True)
    monkeypatch.setattr(market_insights, "is_budget_critical", lambda: budget_critical)
    monkeypatch.setattr(market_insights, "_get_or_refresh_public_module", module)
    monkeypatch.setattr(
        market_insights, "_default_pick_symbols", AsyncMock(return_value=["AAPL", "ADBE"])
    )
    monkeypatch.setattr(
        market_insights,
        "get_market_cache_store_service",
        lambda: SimpleNamespace(delete_expired=AsyncMock(return_value=0)),
    )
    await market_insights._refresh_public_market_modules_once()
    assert keys[:2] == [INDEX_LAST_CLOSE_KEY, picks_key(["AAPL", "ADBE"])]
    assert len(keys) == (2 if budget_critical else 5)


async def test_price_store_retention_reaches_next_opening(monkeypatch):
    now = datetime.fromisoformat("2026-07-17T19:59:00+00:00").timestamp()
    opens_at = datetime.fromisoformat("2026-07-20T13:30:00+00:00").timestamp()
    monkeypatch.setattr(cache_module.time, "time", lambda: now)
    store = _FakeStore()
    monkeypatch.setattr(market_insights, "get_market_cache_store_service", lambda: store)
    monkeypatch.setattr(market_insights, "market_insights_cache", MarketInsightsCache())
    await market_insights._get_or_refresh_public_module(
        key="quotes:AAPL", fresh_ttl_seconds=600, stale_ttl_seconds=1800, fetcher=_payload_fetcher
    )
    assert store.entries["quotes:AAPL"].stale_until_ts >= opens_at + 120


async def test_closed_warmer_sleeps_until_open_without_provider_refresh(monkeypatch):
    now = [datetime.fromisoformat("2026-07-19T16:00:00+00:00").timestamp()]
    opening = datetime.fromisoformat("2026-07-20T13:30:00+00:00").timestamp()
    monkeypatch.setattr(cache_module.time, "time", lambda: now[0])
    sleeps, refreshes = [], []

    async def sleep(delay):
        sleeps.append(delay)
        now[0] += delay

    async def refresh():
        refreshes.append(now[0])
        raise asyncio.CancelledError

    monkeypatch.setattr(market_insights.asyncio, "sleep", sleep)
    monkeypatch.setattr(market_insights, "_run_refresh_with_advisory_lock", refresh)
    with pytest.raises(asyncio.CancelledError):
        await market_insights._market_refresh_loop()
    assert sleeps == [opening - datetime.fromisoformat("2026-07-19T16:00:00+00:00").timestamp()]
    assert refreshes == [opening]


@pytest.mark.parametrize("mode", ["module", "provider"])
async def test_refresh_crossing_close_cannot_replace_complete_saved_prices(monkeypatch, mode):
    from hushh_mcp.services import market_provider_cache

    now = [datetime.fromisoformat("2026-07-17T19:59:59+00:00").timestamp()]
    monkeypatch.setattr(cache_module.time, "time", lambda: now[0])
    store, cache = _FakeStore(), MarketInsightsCache()
    saved = {"AAPL": {"price": 100}, "MSFT": {"price": 200}}
    saved_at = now[0] - 121
    key = "quotes:crossing-close"
    cache.seed_entry(key, saved, saved_at)
    monkeypatch.setattr(market_insights, "get_market_cache_store_service", lambda: store)
    monkeypatch.setattr(market_insights, "market_insights_cache", cache)
    monkeypatch.setattr(market_provider_cache, "get_market_cache_store_service", lambda: store)
    monkeypatch.setattr(market_provider_cache, "market_insights_cache", cache)

    async def partial():
        now[0] += 1
        return {"AAPL": {"price": 101}}

    if mode == "module":
        result = await market_insights._get_or_refresh_public_module(
            key=key,
            fresh_ttl_seconds=120,
            stale_ttl_seconds=1800,
            fetcher=partial,
            serve_stale_while_revalidate=False,
        )
        value = result[0]
        assert result[1] is True
    else:
        value = await market_provider_cache.cached_public_information(
            key, fresh=120, stale=1800, fetcher=partial, session_sensitive=True
        )
    assert value == saved
    assert cache.peek(key).value == saved and cache.peek(key).fetched_at == saved_at
    assert store.entries == {}


def _closed_home_environment(monkeypatch, picks):
    """A closed-session Market home build in which every provider path is a tripwire."""
    now = datetime.fromisoformat("2026-07-14T22:00:00+00:00").timestamp()
    cache = MarketInsightsCache()
    monkeypatch.setattr(cache_module.time, "time", lambda: now)
    monkeypatch.setattr(market_insights, "market_insights_cache", cache)
    monkeypatch.setattr(market_insights, "get_market_cache_store_service", _FakeStore)
    monkeypatch.setattr(
        market_insights,
        "_resolve_pick_source_rows",
        AsyncMock(return_value=(picks, [market_insights._default_pick_source()], "default")),
    )
    tripwires = []
    for name in (
        "fetch_market_data_batch",
        "fetch_market_data",
        "_fetch_macro_bundle",
        "_fetch_movers_from_fmp",
        "_fetch_sector_rotation_snapshot",
        "_fetch_symbol_series_batch",
    ):
        tripwire = AsyncMock(side_effect=AssertionError("closed price provider must not run"))
        monkeypatch.setattr(market_insights, name, tripwire)
        tripwires.append(tripwire)
    monkeypatch.setattr(
        market_insights,
        "_fetch_recommendation",
        AsyncMock(return_value={"signal": "NEUTRAL", "degraded": True}),
    )
    news = AsyncMock(
        return_value=[
            {
                "title": "After-hours company update",
                "url": "https://example.com/after-hours",
                "publishedAt": "2026-07-14T21:00:00+00:00",
            }
        ]
    )
    monkeypatch.setattr(market_insights, "fetch_market_news", news)

    async def images(_symbol, articles):
        return articles

    monkeypatch.setattr(market_insights, "enrich_market_news_images", images)
    return now - 2 * 60 * 60, cache, tripwires, news


async def _closed_home_payload(watchlist):
    return await market_insights._get_market_insights_payload(
        user_id="test-user",
        requested_watchlist_symbols=watchlist,
        filtered_symbols=[],
        watchlist_symbols=watchlist,
        days_back=7,
        active_pick_source="default",
        consent_token=None,
        personalized=False,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("saved_movers", [False, True])
async def test_closed_home_keeps_news_and_indices_without_sparklines(monkeypatch, saved_movers):
    quoted_at = "2026-07-14T20:00:00+00:00"
    saved_at, cache, tripwires, news = _closed_home_environment(monkeypatch, [])
    # The viewer's own quotes entry is cold; the shared index entry must still serve them.
    quote = {"price": 100, "quoted_at": quoted_at, "market_state": "open"}
    quotes = {"quotes": dict.fromkeys(INDEX_SYMBOLS, quote)}
    cache.seed_entry(INDEX_LAST_CLOSE_KEY, quotes, saved_at)
    if saved_movers:
        movers = ({"gainers": [{"symbol": "AAPL", "price": 200, "change_pct": 1}]}, {})
        cache.seed_entry("movers:v2:us", movers, saved_at)
    payload = await _closed_home_payload(["AAPL"])

    assert payload["news_tape"][0]["title"] == "After-hours company update"
    overview = {row.get("symbol"): row for row in payload["market_overview"]}
    assert overview["^GSPC"]["value"] == 100
    assert overview["^GSPC"]["as_of"] == quoted_at
    assert overview["^GSPC"]["market_state"] == "closed"
    assert payload["stale_reason"] == "market_closed"
    assert payload["provider_status"].get("home") != "failed"
    if saved_movers:
        assert payload["movers"]["gainers"][0]["symbol"] == "AAPL"
        assert payload["provider_status"]["sparklines"] == "unavailable"
    news.assert_awaited_once()
    for tripwire in tripwires:
        tripwire.assert_not_awaited()


async def test_closed_pick_rows_keep_prices_for_a_viewer_whose_own_entry_is_cold(monkeypatch):
    picks = [
        {"ticker": "ADBE", "company_name": "Adobe Inc", "tier": "KING"},
        {"ticker": "AAPL", "company_name": "Apple Inc", "tier": "ACE"},
    ]
    saved_at, cache, tripwires, _news = _closed_home_environment(monkeypatch, picks)
    quote = {"price": 100, "change_percent": 1.5, "fetched_at": "2026-07-14T19:58:00Z"}
    quote["quoted_at"] = "2026-07-14T19:57:00Z"
    shared = {"quotes": dict.fromkeys(("AAPL", "ADBE"), quote)}
    cache.seed_entry(picks_key(["AAPL", "ADBE"]), shared, saved_at)
    # The viewer also holds TSLA, outside the pick list, and its own quotes entry is cold.
    payload = await _closed_home_payload(["AAPL", "TSLA"])

    rows = {row["symbol"]: row for row in payload["renaissance_list"]}
    assert [rows[symbol]["price"] for symbol in ("ADBE", "AAPL")] == [100, 100]
    assert rows["ADBE"]["as_of"] == quote["quoted_at"] and not rows["ADBE"]["degraded"]
    assert payload["provider_status"]["quote:TSLA"] == "failed"
    for tripwire in tripwires:
        tripwire.assert_not_awaited()


async def test_shared_bundle_fetch_takes_fallbacks_only_where_asked():
    calls = []

    async def fetch_one(symbol, _user, _token, *, allow_slow_fallbacks):
        calls.append((symbol, allow_slow_fallbacks))
        if symbol == "NVDA":
            raise RuntimeError("provider down")
        return {"price": 5} if allow_slow_fallbacks else {}

    shared = SharedLastClose(
        read_module=AsyncMock(),
        fetch_batch=AsyncMock(return_value={"AAPL": {"price": 1}}),
        fetch_one=fetch_one,
        safe_float=lambda value: float(value) if isinstance(value, (int, float)) else None,
        now_iso=lambda: "now",
        status_from_exception=lambda _exc: "failed",
        is_open=lambda: True,
        pick_symbols=AsyncMock(return_value=[]),
        fresh_ttl_seconds=600,
        stale_ttl_seconds=1800,
        fanout=2,
        logger=logging.getLogger("test"),
    )
    bundle = await shared.fetch_bundle(["AAPL", "MSFT", "NVDA", "^GSPC"])
    assert bundle["provider_status"] == {
        "quote:AAPL": "ok",
        "quote:MSFT": "ok",
        "quote:NVDA": "failed",
        "quote:^GSPC": "unavailable",
    }
    assert sorted(calls) == [("MSFT", False), ("MSFT", True), ("NVDA", False), ("NVDA", True)]
    calls.clear()
    bundle = await shared.fetch_bundle(["AAPL", "MSFT"], fallbacks=False)
    assert calls == [] and bundle["provider_status"]["quote:MSFT"] == "unavailable"
    shared.fetch_batch.return_value = {}
    with pytest.raises(QuotesUnavailable):
        await shared.fetch_bundle(["AAPL"], fallbacks=False, require_any=True)
