"""A thin NSE movers refresh must never replace the last complete list."""

from __future__ import annotations

import pytest

from api.routes.kai import market_insights
from hushh_mcp.market_data import india_market
from hushh_mcp.services.market_insights_cache import MarketInsightsCache
from tests.helpers.market_public_cache import _FakeStore  # noqa: F401


def _rows(up: int, down: int) -> list[dict]:
    def row(symbol: str, change: float) -> dict:
        return {
            "symbol": symbol,
            "company_name": symbol.title(),
            "price": 100.0,
            "change_pct": change,
            "volume": 1_000.0,
            "as_of": "2026-11-12T10:01:00+00:00",
            "source_tags": ["Yahoo Finance", "NSE"],
            "degraded": False,
        }

    return [row(f"UP{i}", 1 + i) for i in range(up)] + [row(f"DN{i}", -1 - i) for i in range(down)]


def _movers(up: int, down: int) -> dict:
    return india_market.build_india_movers(_rows(up, down))


async def _refresh(monkeypatch, outcomes: list[dict]) -> list:
    """Run the guarded refresh once per outcome against one shared cache."""
    queue = list(outcomes)

    async def fetch() -> dict:
        return queue.pop(0)

    cache = MarketInsightsCache()
    monkeypatch.setattr(market_insights, "get_market_cache_store_service", lambda: _FakeStore())
    monkeypatch.setattr(market_insights, "market_insights_cache", cache)
    monkeypatch.setattr(market_insights, "INDIA_MOVERS_FRESH_TTL_SECONDS", 0)
    monkeypatch.setattr(india_market, "fetch_india_movers", fetch)
    results = []
    for _ in outcomes:
        value, *_ = await market_insights._get_or_refresh_public_module(
            key=market_insights.INDIA_MOVERS_KEY,
            fresh_ttl_seconds=0,
            stale_ttl_seconds=market_insights.INDIA_MOVERS_STALE_TTL_SECONDS,
            fetcher=market_insights._refresh_india_movers,
            serve_stale_while_revalidate=False,
        )
        results.append(value)
    return results


@pytest.mark.asyncio
async def test_a_thin_refresh_keeps_the_last_complete_list(monkeypatch):
    complete, thin = _movers(6, 6), _movers(2, 1)
    first, second = await _refresh(monkeypatch, [complete, thin])
    assert len(first["gainers"]) >= 3 and len(first["losers"]) >= 3
    assert second["gainers"] == first["gainers"] and second["losers"] == first["losers"]


@pytest.mark.asyncio
async def test_a_complete_refresh_replaces_the_list(monkeypatch):
    older, newer = _movers(4, 4), _movers(7, 7)
    _first, second = await _refresh(monkeypatch, [older, newer])
    assert len(second["gainers"]) == len(newer["gainers"])


@pytest.mark.asyncio
async def test_with_nothing_cached_a_thin_list_is_still_served(monkeypatch):
    (only,) = await _refresh(monkeypatch, [_movers(2, 1)])
    assert [row["symbol"] for row in only["gainers"]] == ["UP1", "UP0"]
