from __future__ import annotations

import asyncio
from datetime import datetime

import pytest

from api.routes.kai import market_insights
from hushh_mcp.services import market_insights_cache as cache_module
from hushh_mcp.services.market_insights_cache import MarketInsightsCache
from tests.helpers.market_public_cache import (  # noqa: F401
    _FakeEntry,
    _FakeStore,
    _payload_fetcher,
    regular_session_clock,
)


@pytest.mark.asyncio
async def test_public_module_reads_back_from_l2_when_l1_is_cold(monkeypatch):
    fake_store = _FakeStore()
    cold_l1 = MarketInsightsCache()
    fetch_count = {"count": 0}

    async def _counted_fetcher():
        fetch_count["count"] += 1
        return await _payload_fetcher()

    monkeypatch.setattr(market_insights, "get_market_cache_store_service", lambda: fake_store)
    monkeypatch.setattr(market_insights, "market_insights_cache", cold_l1)

    payload, stale, _age, tier, cache_hit = await market_insights._get_or_refresh_public_module(
        key="quotes:AAPL,MSFT",
        fresh_ttl_seconds=600,
        stale_ttl_seconds=1800,
        fetcher=_counted_fetcher,
        serve_stale_while_revalidate=False,
    )

    assert payload["rows"][0]["symbol"] == "AAPL"
    assert stale is False
    assert tier == "live"
    assert cache_hit is False
    assert fetch_count["count"] == 1

    monkeypatch.setattr(market_insights, "market_insights_cache", MarketInsightsCache())

    payload, stale, _age, tier, cache_hit = await market_insights._get_or_refresh_public_module(
        key="quotes:AAPL,MSFT",
        fresh_ttl_seconds=600,
        stale_ttl_seconds=1800,
        fetcher=_counted_fetcher,
        serve_stale_while_revalidate=False,
    )

    assert payload["rows"][0]["symbol"] == "AAPL"
    assert stale is False
    assert tier == "postgres"
    assert cache_hit is True
    assert fetch_count["count"] == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("tier", ["memory", "postgres"])
@pytest.mark.parametrize("failure", [False, True])
async def test_fresh_degraded_quotes_retry_without_losing_fallback(monkeypatch, tier, failure):
    now = datetime.fromisoformat("2026-07-14T14:00:00+00:00").timestamp()
    monkeypatch.setattr(market_insights, "time", lambda: now)
    monkeypatch.setattr(cache_module.time, "time", lambda: now)
    store, cache = _FakeStore(), MarketInsightsCache()
    key = "quotes:AAPL"
    degraded = {"rows": [], "provider_status": {"quote:AAPL": "failed"}}
    if tier == "memory":
        cache.seed_entry(key, degraded, now - 1)
    else:
        store.entries[key] = _FakeEntry(degraded, now - 1, now + 1800, now + 3600)
    monkeypatch.setattr(market_insights, "market_insights_cache", cache)
    monkeypatch.setattr(market_insights, "get_market_cache_store_service", lambda: store)
    calls = []

    async def fetch():
        calls.append(True)
        if failure:
            raise RuntimeError("provider unavailable")
        return {"rows": [{"symbol": "AAPL", "price": 100}], "provider_status": {"quote:AAPL": "ok"}}

    result = await market_insights._get_or_refresh_public_module(
        key=key,
        fresh_ttl_seconds=600,
        stale_ttl_seconds=1800,
        fetcher=fetch,
        serve_stale_while_revalidate=False,
    )
    assert calls == [True]
    assert result[1] is failure
    if failure:
        assert result[0] == degraded
    else:
        assert result[0]["rows"][0]["price"] == 100
        await market_insights._get_or_refresh_public_module(
            key=key,
            fresh_ttl_seconds=600,
            stale_ttl_seconds=1800,
            fetcher=fetch,
            serve_stale_while_revalidate=False,
        )
        assert calls == [True]


def test_market_home_cache_key_uses_shared_baseline_and_user_scoped_personalization():
    baseline_user_a = market_insights._market_home_cache_key(
        user_id="user_a",
        canonical_watchlist_key="AAPL,MSFT",
        days_back=7,
        active_pick_source="default",
        roster_signature="none",
        personalized=False,
    )
    baseline_user_b = market_insights._market_home_cache_key(
        user_id="user_b",
        canonical_watchlist_key="AAPL,MSFT",
        days_back=7,
        active_pick_source="default",
        roster_signature="none",
        personalized=False,
    )
    personalized_user_a = market_insights._market_home_cache_key(
        user_id="user_a",
        canonical_watchlist_key="AAPL,MSFT",
        days_back=7,
        active_pick_source="default",
        roster_signature="ria:alpha",
        personalized=True,
    )

    assert baseline_user_a == baseline_user_b
    assert baseline_user_a.startswith("home:v5:baseline:")
    assert personalized_user_a.startswith("home:v5:user_a:")


def test_repair_quote_symbol_normalizes_known_provider_aliases():
    assert market_insights._repair_quote_symbol("BRKB") == ("BRK-B", True)
    assert market_insights._repair_quote_symbol("CMCS1") == ("CMCSA", True)
    assert market_insights._repair_quote_symbol("MSFT") == ("MSFT", False)


def test_market_overview_uses_index_levels_and_provider_quote_evidence():
    quote = {
        "price": 7712.57,
        "change_percent": 1.25,
        "quoted_at": "2026-10-20T20:45:45Z",
        "fetched_at": "2026-10-21T01:00:00Z",
        "is_delayed": True,
        "sparkline": [7700, 7712.57],
    }
    overview = market_insights._build_market_overview(
        quote,
        quote,
        quote,
        quote,
        {
            "label": "Volatility",
            "value": 18.0,
            "delta_pct": 0.2,
            "as_of": None,
            "source": "test",
            "degraded": False,
        },
        {
            "label": "Market Status",
            "value": "Open",
            "delta_pct": None,
            "as_of": None,
            "source": "test",
            "degraded": False,
        },
    )

    by_label = {row["label"]: row for row in overview}
    assert [row["symbol"] for row in overview[:4]] == ["^GSPC", "^IXIC", "^DJI", "^RUT"]
    assert by_label["NASDAQ Composite"]["symbol"] == "^IXIC"
    assert by_label["Dow Jones"]["value"] == 7712.57
    assert by_label["Dow Jones"]["as_of"] == quote["quoted_at"]
    assert by_label["Dow Jones"]["is_delayed"] is True
    assert by_label["Dow Jones"]["sparkline"] == [7700, 7712.57]
    assert by_label["Russell 2000"]["delta_pct"] == 1.25


@pytest.mark.asyncio
async def test_concurrent_public_module_failure_degrades_without_collapsing_home(monkeypatch):
    async def _fake_resolve_pick_source_rows(*_args, **_kwargs):
        return [], [market_insights._default_pick_source()], market_insights.DEFAULT_PICK_SOURCE_ID

    async def _fake_public_module(**kwargs):
        key = str(kwargs["key"])
        if key.startswith("home:"):
            return await kwargs["fetcher"](), False, 0, "live", False
        if key.startswith("quotes:"):
            raise RuntimeError("quote provider unavailable")
        if key == "macro:v2:us":
            return (
                {
                    "vix": {
                        "label": "Volatility",
                        "value": None,
                        "delta_pct": None,
                        "as_of": None,
                        "source": "Unavailable",
                        "degraded": True,
                    },
                    "market_status": market_insights._scheduled_market_status_fallback(),
                    "provider_status": {"volatility": "partial", "market_status": "partial"},
                },
                False,
                0,
                "live",
                False,
            )
        if key == "movers:v2:us":
            return ({}, {"movers:gainers": "partial"}), False, 0, "live", False
        if key == "sectors:v2:us":
            return ([], "partial"), False, 0, "live", False
        if key.startswith("sparklines:"):
            return {}, False, 0, "live", False
        if key.startswith("recommendation:"):
            symbol = key.split(":", 1)[1]
            return (
                {
                    "recommendation": market_insights._fallback_recommendation_from_quote(
                        symbol, None
                    ),
                    "status": "partial",
                    "provider_status": {f"recommendation:{symbol}": "partial"},
                },
                False,
                0,
                "live",
                False,
            )
        if key.startswith("news:"):
            return {"rows": [], "provider_status": {}}, False, 0, "live", False
        raise AssertionError(f"unexpected cache key {key}")

    monkeypatch.setattr(
        market_insights,
        "_resolve_pick_source_rows",
        _fake_resolve_pick_source_rows,
    )
    monkeypatch.setattr(
        market_insights,
        "_get_or_refresh_public_module",
        _fake_public_module,
    )

    payload = await market_insights._get_market_insights_payload(
        user_id="test-user",
        requested_watchlist_symbols=["AAPL"],
        filtered_symbols=[],
        watchlist_symbols=["AAPL"],
        days_back=7,
        active_pick_source=market_insights.DEFAULT_PICK_SOURCE_ID,
        consent_token=None,
        personalized=False,
    )

    assert payload["stale"] is True
    assert payload["provider_status"]["quote:AAPL"] == "failed"
    assert payload["watchlist"][0]["symbol"] == "AAPL"
    assert payload["watchlist"][0]["degraded"] is True
    assert payload["movers"]["degraded"] is True
    assert payload["provider_status"]["sectors"] == "partial"


@pytest.mark.asyncio
async def test_startup_warm_seeds_shared_baseline_home_after_public_modules(monkeypatch):
    call_order: list[str] = []
    captured: dict[str, object] = {}

    async def _fake_public_refresh():
        call_order.append("public")

    async def _fake_market_payload(**kwargs):
        call_order.append("baseline")
        captured.update(kwargs)
        return {
            "meta": {
                "cache_tier": "memory",
                "stale": False,
                "cache_age_seconds": 0,
            }
        }

    monkeypatch.setattr(market_insights, "_run_refresh_with_advisory_lock", _fake_public_refresh)
    monkeypatch.setattr(market_insights, "_get_market_insights_payload", _fake_market_payload)
    monkeypatch.setenv("KAI_MARKET_BACKGROUND_REFRESH", "true")
    monkeypatch.setenv("KAI_MARKET_STARTUP_WARM_TIMEOUT_SECONDS", "2")

    await market_insights.warm_market_insights_startup_once()

    assert call_order == ["public", "baseline"]
    assert captured == {
        "user_id": "startup",
        "requested_watchlist_symbols": list(market_insights.DEFAULT_SYMBOLS),
        "filtered_symbols": [],
        "watchlist_symbols": list(market_insights.DEFAULT_SYMBOLS),
        "days_back": 7,
        "active_pick_source": market_insights.DEFAULT_PICK_SOURCE_ID,
        "consent_token": None,
        "personalized": False,
        "warm_source": "startup",
    }


@pytest.mark.asyncio
async def test_company_facts_require_matching_identity_before_provider_work(monkeypatch):
    from fastapi import HTTPException

    called = []

    async def public_module(**kwargs):
        called.append(kwargs["key"])
        return {"symbol": "AAPL", "market_cap": 100}, False, 0, "live", False

    monkeypatch.setattr(market_insights, "_get_or_refresh_public_module", public_module)
    with pytest.raises(HTTPException) as error:
        await market_insights.get_market_company_facts("owner", "AAPL", "someone-else")
    assert error.value.status_code == 403
    assert called == []
    result = await market_insights.get_market_company_facts("owner", "AAPL", "owner")
    assert result["facts"]["AAPL"]["market_cap"] == 100
    assert called == ["company_facts:v1:AAPL"]


@pytest.mark.asyncio
async def test_company_facts_bound_provider_work_during_background_stale_refresh(monkeypatch):
    pending = []
    gate = asyncio.Event()
    running = 0
    peak = 0

    async def fetch_facts(symbol):
        nonlocal running, peak
        running += 1
        peak = max(peak, running)
        await gate.wait()
        running -= 1
        return {"symbol": symbol}

    async def stale_module(**kwargs):
        pending.append(asyncio.create_task(kwargs["fetcher"]()))
        return {"symbol": kwargs["key"].split(":")[-1]}, True, 60, "memory", True

    monkeypatch.setattr(market_insights, "fetch_market_company_facts", fetch_facts)
    monkeypatch.setattr(market_insights, "_get_or_refresh_public_module", stale_module)
    result = await market_insights.get_market_company_facts(
        "owner", "AAPL,MSFT,NVDA,GOOG,AMZN,META,TSLA,AVGO", "owner"
    )
    gate.set()
    await asyncio.gather(*pending)
    assert len(result["facts"]) == 8
    assert peak == 4
    assert all(row["stale"] for row in result["facts"].values())


@pytest.mark.asyncio
async def test_sector_periods_use_distinct_observed_session_closes(monkeypatch):
    async def histories(symbols):
        return {
            symbols[0]: [{"t": 1791849600 + day * 86400, "p": 100 + day * 2} for day in range(6)]
        }

    monkeypatch.setattr(market_insights, "fetch_market_session_history", histories)
    rows, status = await market_insights._fetch_sector_rotation_snapshot("public", None)
    assert status == "partial"
    assert rows[0]["change_pct"] == pytest.approx((110 / 108 - 1) * 100)
    assert rows[0]["change_1w_pct"] == pytest.approx(10)
    assert rows[0]["period_start_1d"] != rows[0]["period_start_1w"]
    assert rows[0]["basis"] == "Sector ETF price return"


@pytest.mark.asyncio
async def test_stock_history_closed_backfill_cache_fences_and_stale_fallback(monkeypatch):
    from types import SimpleNamespace

    from fastapi import HTTPException

    from api.routes.kai import price_history
    from hushh_mcp.market_data.ports import bind_market_data_provider

    now = [datetime.fromisoformat("2026-07-19T16:00:00+00:00").timestamp()]
    monkeypatch.setattr(cache_module.time, "time", lambda: now[0])
    monkeypatch.setattr(market_insights, "time", lambda: now[0])
    cache, store = MarketInsightsCache(), _FakeStore()
    monkeypatch.setattr(market_insights, "market_insights_cache", cache)
    monkeypatch.setattr(market_insights, "get_market_cache_store_service", lambda: store)
    supported = {"exchange": "Nasdaq"}
    monkeypatch.setattr(
        price_history,
        "get_symbol_master_service",
        lambda: SimpleNamespace(get_ticker_metadata=lambda _: supported),
    )

    class Provider:
        name = "recorded"
        calls = []
        fail = False

        async def fetch(self, request):
            self.calls.append(request)
            await asyncio.sleep(0)
            if self.fail:
                raise RuntimeError("provider unavailable")
            return {
                "points": [{"t": 1792000000.0, "p": 230.0}, {"t": 1792086400.0, "p": 232.0}],
                "source": "Recorded daily source",
                "retrieved_at": datetime.fromtimestamp(now[0]).isoformat(),
            }

    provider = Provider()
    with bind_market_data_provider(provider):
        with pytest.raises(HTTPException) as error:
            await price_history.get_stock_price_history("owner", "AAPL", "another-owner")
        assert error.value.status_code == 403
        supported["exchange"] = "NSE"
        with pytest.raises(HTTPException) as error:
            await price_history.get_stock_price_history("owner", "AAPL", "owner")
        assert error.value.status_code == 422 and provider.calls == []
        supported["exchange"] = "Nasdaq"
        first, second = await asyncio.gather(
            *[price_history.get_stock_price_history("owner", "AAPL", "owner") for _ in range(2)]
        )
        assert len(provider.calls) == 1 and provider.calls[0].operation == "daily_history"
        assert first["points"] == second["points"] and not first["unavailable"]
        assert first["currency"] == "USD" and first["interval"] == "1d"
        assert list(store.entries) == ["stock_history:v1:AAPL:1mo"]
        # Monday before opening retains Sunday's backfill; cold L1 also reuses L2.
        now[0] = datetime.fromisoformat("2026-07-20T13:29:00+00:00").timestamp()
        monkeypatch.setattr(market_insights, "market_insights_cache", MarketInsightsCache())
        cached = await price_history.get_stock_price_history("owner", "AAPL", "owner")
        assert cached["cached"] and cached["retrieved_at"] == first["retrieved_at"]
        assert len(provider.calls) == 1
        for edge in ("2026-07-20T13:30:00+00:00", "2026-07-20T20:01:00+00:00"):
            now[0] = datetime.fromisoformat(edge).timestamp()
            refreshed = await price_history.get_stock_price_history("owner", "AAPL", "owner")
            assert not refreshed["stale"]
        assert len(provider.calls) == 3
        # Next opening fails: keep actual saved points and provenance, not a new stamp.
        now[0] = datetime.fromisoformat("2026-07-21T13:30:00+00:00").timestamp()
        provider.fail = True
        fallback = await price_history.get_stock_price_history("owner", "AAPL", "owner")
        assert (
            fallback["stale"] and fallback["cached"] and fallback["points"] == refreshed["points"]
        )
        assert (
            fallback["source"] == refreshed["source"]
            and fallback["retrieved_at"] == refreshed["retrieved_at"]
        )
        unavailable = await price_history.get_stock_price_history("owner", "MSFT", "owner")
        assert (
            unavailable["unavailable_reason"] == "provider_unavailable"
            and unavailable["points"] == []
        )


def test_daily_snapshot_keeps_only_real_observations():
    from hushh_mcp.market_data.history import daily_history_snapshot
    from hushh_mcp.market_data.ports import MarketDataUnavailable

    points = [
        {"t": 3, "p": 230},
        {"t": 2, "p": 231},
        {"t": 3, "p": 232},
        {"t": 4, "p": float("nan")},
        {"t": True, "p": 5},
        {"t": 5, "p": -1},
    ]
    assert daily_history_snapshot(points, source="recorded")["points"] == [
        {"t": 2.0, "p": 231.0},
        {"t": 3.0, "p": 232.0},
    ]
    with pytest.raises(MarketDataUnavailable, match="insufficient_observations"):
        daily_history_snapshot(points[:1], source="recorded")
