"""India market view: shape, independence from the US session gate, and failure behaviour."""

from __future__ import annotations

import pytest

from api.routes.kai import _shared_last_close as shared_last_close
from api.routes.kai import market_insights
from hushh_mcp.market_data import india_market
from hushh_mcp.services.market_insights_cache import MarketInsightsCache
from tests.helpers.market_public_cache import _FakeStore  # noqa: F401


def _points(*prices: float) -> list[dict[str, float]]:
    return [{"t": 1_762_000_000 + index * 86_400, "p": price} for index, price in enumerate(prices)]


def _quote(symbol: str, price: float, change: float, points: list[dict[str, float]]) -> dict:
    return {
        "ticker": symbol,
        "price": price,
        "change_percent": change,
        "quoted_at": "2026-11-12T10:00:00+00:00",
        "fetched_at": "2026-11-12T10:01:00+00:00",
        "market_state": "closed",
        "source": "Yahoo Chart (Batch)",
        "sparkline": [point["p"] for point in points],
        "sparkline_points": points,
    }


def _quotes() -> dict[str, dict]:
    series = _points(100, 101, 102, 103, 104, 106)
    quotes = {symbol: _quote(symbol, 106, 1.92, series) for symbol in india_market.india_symbols()}
    quotes["^NSEI"] = _quote("^NSEI", 25299.35, 0.42, series)
    quotes["^CNXMETAL"] = _quote("^CNXMETAL", 100, 0, _points(100))  # one point: no return
    return quotes


STATUS = {
    "label": "Market Status",
    "value": "Closed (after-hours)",
    "delta_pct": None,
    "as_of": "2026-11-12T10:00:00Z",
    "source": "Exchange calendar",
    "degraded": False,
}


def test_overview_and_sectors_use_the_us_row_and_sector_shapes():
    overview = india_market.build_india_overview(_quotes(), STATUS)
    assert [row["label"] for row in overview] == [
        "NIFTY 50",
        "SENSEX",
        "NIFTY Bank",
        "NIFTY IT",
        "Market Status",
    ]
    nifty = overview[0]
    assert (nifty["symbol"], nifty["value"], nifty["delta_pct"]) == ("^NSEI", 25299.35, 0.42)
    assert nifty["sparkline"] and not nifty["degraded"]

    sectors, state = india_market.build_india_sectors(_quotes())
    by_name = {row["sector"]: row for row in sectors}
    assert "Metal" not in by_name and state == "partial"  # a one-point series is not a return
    assert by_name["IT"]["change_pct"] == pytest.approx((106 / 104 - 1) * 100)
    assert by_name["IT"]["change_1w_pct"] == pytest.approx((106 / 100 - 1) * 100)


@pytest.mark.asyncio
async def test_india_view_refreshes_while_the_us_session_is_closed(monkeypatch):
    async def quotes() -> dict[str, dict]:
        return _quotes()

    async def news(_days: int) -> list[dict]:
        return [
            {"title": "Nifty ends higher", "url": "https://example.com/n", "source_name": "Mint"}
        ]

    async def status(_exchange: str) -> dict:
        return STATUS

    monkeypatch.setattr(market_insights, "get_market_cache_store_service", lambda: _FakeStore())
    monkeypatch.setattr(market_insights, "market_insights_cache", MarketInsightsCache())
    monkeypatch.setattr(market_insights, "_us_market_is_open", lambda *_: False)
    monkeypatch.setattr(market_insights, "_fetch_market_status_for_exchange", status)
    monkeypatch.setattr(india_market, "fetch_india_quotes", quotes)
    monkeypatch.setattr(india_market, "fetch_india_news", news)

    payload = await market_insights._get_india_market_payload("user_a", 7)

    assert payload["market"] == "IN" and payload["meta"]["market"] == "IN"
    assert payload["market_overview"][0]["value"] == 25299.35
    assert payload["news_tape"][0]["title"] == "Nifty ends higher"
    assert payload["sector_rotation"] and payload["movers"]["degraded"] is True
    # Metal had a single point, so the payload says one module is partial instead of healthy.
    assert payload["provider_status"]["india_sectors"] == "partial"
    assert payload["stale"] is False  # a partial sector set must not grey out healthy index levels


@pytest.mark.asyncio
async def test_total_india_outage_returns_a_degraded_payload_instead_of_failing(monkeypatch):
    async def down(*_args) -> None:
        raise RuntimeError("provider down")

    async def status(_exchange: str) -> dict:
        return STATUS

    monkeypatch.setattr(market_insights, "get_market_cache_store_service", lambda: _FakeStore())
    monkeypatch.setattr(market_insights, "market_insights_cache", MarketInsightsCache())
    monkeypatch.setattr(market_insights, "_fetch_market_status_for_exchange", status)
    monkeypatch.setattr(india_market, "fetch_india_quotes", down)
    monkeypatch.setattr(india_market, "fetch_india_news", down)

    payload = await market_insights._get_india_market_payload("user_a", 7)

    assert payload["market"] == "IN" and payload["stale"] is True
    assert payload["stale_reason"] == "india_home_failed"
    assert payload["market_overview"][0]["label"] == "Market Status"


def test_india_cache_key_is_outside_every_us_session_gated_prefix():
    gated = (
        *market_insights.MARKET_PRICE_REFRESH_PREFIXES,
        *shared_last_close.LAST_CLOSE_PREFIXES,
        "movers:",
    )
    assert not "india_home:v1:7".startswith(tuple(gated))


def test_india_news_is_newest_first_deduplicated_and_carries_a_publisher_logo():
    rss = """<rss><channel>
    <item><title>Stock Market Holiday Today - NDTV</title><link>https://n.example/1</link>
      <pubDate>Mon, 10 Nov 2026 01:14:00 GMT</pubDate><source url="https://www.ndtv.com">NDTV</source></item>
    <item><title>Sensex ends above 81,900 - DD News</title><link>https://n.example/2</link>
      <pubDate>Thu, 12 Nov 2026 11:17:00 GMT</pubDate><source url="https://ddnews.gov.in">DD News</source></item>
    <item><title>Sensex ends above 81,900 - DD News</title><link>https://n.example/3</link>
      <pubDate>Thu, 12 Nov 2026 11:18:00 GMT</pubDate><source url="https://ddnews.gov.in">DD News</source></item>
    <item><title>No publisher link</title><link>https://n.example/4</link>
      <pubDate>Wed, 11 Nov 2026 09:00:00 GMT</pubDate><source url="javascript:alert(1)">Odd</source></item>
    </channel></rss>"""
    rows = india_market.parse_india_news(rss)
    assert [row["title"] for row in rows] == [
        "Sensex ends above 81,900",
        "No publisher link",
        "Stock Market Holiday Today",
    ]
    assert (
        rows[0]["source_logo_url"]
        == "https://www.google.com/s2/favicons?domain=ddnews.gov.in&sz=128"
    )
    assert rows[1]["source_logo_url"] is None  # an unusable publisher URL never becomes a logo link
    assert all(row["symbol"] == "MARKET" for row in rows)
