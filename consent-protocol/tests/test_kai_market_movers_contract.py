from unittest.mock import AsyncMock

import httpx
import pytest

from api.routes.kai import market_insights
from api.routes.kai.market_insights import _normalize_mover_row
from hushh_mcp.market_data.movers import assemble_movers, complete_movers, select_movers
from hushh_mcp.services import market_movers
from hushh_mcp.services.market_insights_cache import MarketInsightsCache
from tests.helpers.market_public_cache import (  # noqa: F401
    _FakeEntry,
    _FakeStore,
    regular_session_clock,
)


def test_mover_change_pct_is_percentage_only() -> None:
    normalized = _normalize_mover_row(
        {
            "symbol": "AAPL",
            "price": 210.0,
            "changes": 4.25,
        },
        "test",
    )

    assert normalized is not None
    assert normalized["change_pct"] is None


def test_mover_preserves_a_finite_provider_percentage() -> None:
    normalized = _normalize_mover_row(
        {
            "symbol": "AAPL",
            "changesPercentage": 0.14,
            "changes": 4.25,
        },
        "test",
    )

    assert normalized is not None
    assert normalized["change_pct"] == 0.14


def test_mover_accepts_percent_suffixed_provider_values_and_rejects_non_finite() -> None:
    suffixed = _normalize_mover_row(
        {"symbol": "AAPL", "changesPercentage": "1.25%"},
        "test",
    )
    non_finite = _normalize_mover_row(
        {"symbol": "AAPL", "changesPercentage": "Infinity"},
        "test",
    )

    assert suffixed is not None
    assert suffixed["change_pct"] == 1.25
    assert non_finite is not None
    assert non_finite["change_pct"] is None


@pytest.mark.asyncio
async def test_sparse_fmp_losers_recover_three_real_stocks_from_marketwide_feed(monkeypatch):
    async def primary(paths, _params):
        if "losers" in paths[0]:
            return [{"symbol": "MSFT", "price": 500, "changesPercentage": -0.03}]
        return [
            {"symbol": symbol, "price": 100, "changesPercentage": change}
            for symbol, change in (("TSLA", 3.84), ("INTC", 3.69), ("AMZN", 1.86))
        ]

    calls = []

    def serve(request):
        calls.append(request.url.params["scrIds"])
        assert request.url.params["count"] == str(market_movers.SCREENER_LIMIT)
        rows = [
            {
                "symbol": symbol,
                "quoteType": "EQUITY",
                "regularMarketPrice": 100,
                "regularMarketChangePercent": change,
                "regularMarketTime": 1784037600,
            }
            for symbol, change in (("XYL", -11), ("BA", -9), ("UNF", -8))
        ]
        rows += [
            rows[0],
            {**rows[0], "symbol": "SPY", "quoteType": "ETF"},
            {**rows[0], "symbol": "UP", "regularMarketChangePercent": 2},
        ]
        return httpx.Response(200, json={"finance": {"result": [{"quotes": rows}]}})

    client = httpx.AsyncClient
    monkeypatch.setattr(market_insights, "_fetch_pmp_json", primary)
    monkeypatch.setattr(market_movers, "market_insights_cache", MarketInsightsCache())
    monkeypatch.setattr(
        market_movers.httpx,
        "AsyncClient",
        lambda **kwargs: client(transport=httpx.MockTransport(serve), **kwargs),
    )
    payload, statuses = await market_insights._fetch_movers_from_fmp()
    assert complete_movers(payload)
    assert [row["symbol"] for row in payload["losers"][:3]] == ["XYL", "BA", "UNF"]
    assert len({row["symbol"] for row in payload["gainers"][:3]}) == 3
    assert payload["losers"][0]["as_of"] == "2026-07-14T14:00:00+00:00"
    assert statuses["movers:losers"] == "ok"
    assert calls == ["day_losers"]


@pytest.mark.asyncio
async def test_complete_primary_feed_does_not_add_fallback_requests(monkeypatch):
    rows = [{"symbol": f"STOCK{i}", "price": 100, "changesPercentage": i + 1} for i in range(3)]

    async def primary(paths, _params):
        return [
            {**row, "changesPercentage": -row["changesPercentage"]} if "losers" in paths[0] else row
            for row in rows
        ]

    fallback = AsyncMock(side_effect=AssertionError("unexpected extra provider request"))
    monkeypatch.setattr(market_insights, "_fetch_pmp_json", primary)
    monkeypatch.setattr(market_movers, "fetch_mover_recovery", fallback)
    result = await market_insights._fetch_movers_from_fmp()
    assert complete_movers(result)
    fallback.assert_not_awaited()


@pytest.mark.asyncio
async def test_closed_market_refuses_mover_recovery_before_any_request(monkeypatch):
    from hushh_mcp.services import market_refresh_policy

    monkeypatch.setattr(market_refresh_policy, "us_market_is_open", lambda *_: False)
    forbidden = AsyncMock(side_effect=AssertionError("closed-market provider call"))
    monkeypatch.setattr(market_insights, "_fetch_pmp_json", forbidden)
    with pytest.raises(market_refresh_policy.MarketPriceRefreshPaused):
        await market_insights._fetch_movers_from_fmp()
    forbidden.assert_not_awaited()


def test_mover_selection_filters_before_limiting_without_relabelling_positive_losers():
    rows = [{"symbol": "UP", "price": 100, "change_pct": 4}]
    rows += [{"symbol": "DOWN", "price": 100, "change_pct": -1}] * 8
    rows += [
        {"symbol": "NAN", "price": 100, "change_pct": float("nan")},
        {"symbol": "NOQUOTE", "price": None, "change_pct": -3},
        {"symbol": "B", "price": 100, "change_pct": -2},
        {"symbol": "C", "price": 100, "change_pct": -3},
    ]
    assert [row["symbol"] for row in select_movers(rows, "losers", 3)] == ["C", "B", "DOWN"]


def _complete_feed():
    return assemble_movers(
        {
            bucket: [
                {
                    "symbol": f"{bucket}{i}",
                    "price": 100,
                    "change_pct": sign * (i + 1),
                    "as_of": "2026-07-14T14:00:00Z",
                    "source_tags": ["observed"],
                }
                for i in range(3)
            ]
            for bucket, sign in (("gainers", 1), ("losers", -1))
        },
        {},
        "2026-07-14T14:00:00Z",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("tier", ["memory", "postgres"])
@pytest.mark.parametrize("old_sample", [True, False])
async def test_mover_cache_recovers_old_sample_and_never_overwrites_a_complete_feed(
    monkeypatch, tier, old_sample
):
    from datetime import datetime

    from hushh_mcp.services import market_insights_cache as cache_module

    now = [datetime.fromisoformat("2026-07-14T14:00:00+00:00").timestamp()]
    monkeypatch.setattr(cache_module.time, "time", lambda: now[0])
    cache, store, key = MarketInsightsCache(), _FakeStore(), "movers:v2:us"
    complete = _complete_feed()
    partial = ({**complete[0], "losers": complete[0]["losers"][:1]}, complete[1])
    previous = ({**partial[0], "coverage_version": 0}, {}) if old_sample else complete
    saved_at = now[0] - (1 if old_sample else 121)
    if tier == "memory":
        cache.seed_entry(key, previous, saved_at)
    else:
        store.entries[key] = _FakeEntry(previous, saved_at, now[0] + 600, now[0] + 3600)
    monkeypatch.setattr(market_insights, "market_insights_cache", cache)
    monkeypatch.setattr(market_insights, "get_market_cache_store_service", lambda: store)
    fetch = AsyncMock(side_effect=[complete if old_sample else partial, complete])

    async def read():
        return await market_insights._get_or_refresh_public_module(
            key=key,
            fresh_ttl_seconds=600,
            stale_ttl_seconds=1800,
            fetcher=fetch,
            serve_stale_while_revalidate=False,
        )

    first = await read()
    assert complete_movers(first[0])
    assert first[1] is (not old_sample)
    if not old_sample:
        assert cache.peek(key).fetched_at == saved_at
        assert cache.peek(key).value == previous
        assert store.entries.get(key) is None or store.entries[key].payload == previous
    second = await read()
    assert complete_movers(second[0])
    assert fetch.await_count == 1  # partial refreshes cannot hammer providers per viewer
    now[0] += 121
    assert complete_movers((await read())[0])
    assert fetch.await_count == 2


@pytest.mark.asyncio
async def test_complete_movers_survive_a_closed_weekend_without_provider_calls(monkeypatch):
    from datetime import datetime

    from hushh_mcp.services import market_insights_cache as cache_module

    now = datetime.fromisoformat("2026-07-19T16:00:00+00:00").timestamp()
    saved_at = datetime.fromisoformat("2026-07-17T19:59:00+00:00").timestamp()
    monkeypatch.setattr(cache_module.time, "time", lambda: now)
    cache = MarketInsightsCache()
    saved = _complete_feed()
    cache.seed_entry("movers:v2:us", saved, saved_at)
    monkeypatch.setattr(market_insights, "market_insights_cache", cache)
    monkeypatch.setattr(market_insights, "get_market_cache_store_service", _FakeStore)
    forbidden = AsyncMock(side_effect=AssertionError("closed-market refresh"))
    result = await market_insights._get_or_refresh_public_module(
        key="movers:v2:us",
        fresh_ttl_seconds=600,
        stale_ttl_seconds=1800,
        fetcher=forbidden,
    )
    assert result[0] == saved
    assert complete_movers(result[0])
    assert result[1] is True
    forbidden.assert_not_awaited()


@pytest.mark.asyncio
async def test_home_marks_retained_movers_stale_without_changing_the_observations(monkeypatch):
    saved = _complete_feed()

    async def read(**kwargs):
        if kwargs["key"].startswith("home:"):
            return await kwargs["fetcher"](), False, 0, "live", False
        if kwargs["key"].startswith("movers:"):
            return saved, True, 7200, "postgres", True
        return {}, True, 0, "memory", True

    monkeypatch.setattr(market_insights, "_get_or_refresh_public_module", read)
    monkeypatch.setattr(
        market_insights,
        "_resolve_pick_source_rows",
        AsyncMock(
            return_value=(
                [],
                [market_insights._default_pick_source()],
                market_insights.DEFAULT_PICK_SOURCE_ID,
            )
        ),
    )
    payload = await market_insights._get_market_insights_payload(
        user_id="synthetic-owner",
        requested_watchlist_symbols=["AAPL"],
        filtered_symbols=[],
        watchlist_symbols=["AAPL"],
        days_back=7,
        active_pick_source=market_insights.DEFAULT_PICK_SOURCE_ID,
        consent_token=None,
        personalized=False,
    )
    assert complete_movers(payload["movers"])
    for bucket in ("gainers", "losers"):
        for current, original in zip(payload["movers"][bucket], saved[0][bucket], strict=True):
            assert current["degraded"] is True
            assert current["is_stale"] is True
            assert current["as_of"] == original["as_of"]
            assert current["change_pct"] == original["change_pct"]
            assert "is_stale" not in original
    assert payload["movers"]["stale"] is True


def test_watchlist_sample_is_not_an_admissible_complete_market_snapshot():
    payload = {**_complete_feed()[0], "source_tags": ["Watchlist Fallback"]}
    assert not complete_movers(payload)
    assert _normalize_mover_row({"symbol": "SPY", "isEtf": True}, "test") is None
