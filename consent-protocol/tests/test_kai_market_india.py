"""India market view: shape, independence from the US session gate, and failure behaviour."""

from __future__ import annotations

import pytest

from api.routes.kai import _shared_last_close as shared_last_close
from api.routes.kai import market_insights
from hushh_mcp.market_data import india_market
from hushh_mcp.services import market_insights_cache as cache_module
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


def _mover_rows() -> list[dict]:
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

    return [
        row("TATASTEEL", 3.1), row("SBIN", 1.8), row("HINDALCO", 2.6),
        row("WIPRO", -1.4), row("INFY", -0.9), row("TECHM", -0.8), row("ITC", 0.0),
    ]  # fmt: skip


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

    async def movers() -> dict:
        return india_market.build_india_movers(_mover_rows())

    monkeypatch.setattr(india_market, "fetch_india_quotes", quotes)
    monkeypatch.setattr(india_market, "fetch_india_news", news)
    monkeypatch.setattr(india_market, "fetch_india_movers", movers)

    payload = await market_insights._get_india_market_payload("user_a", 7)

    assert payload["market"] == "IN" and payload["meta"]["market"] == "IN"
    assert payload["market_overview"][0]["value"] == 25299.35
    assert payload["news_tape"][0]["title"] == "Nifty ends higher"
    assert payload["sector_rotation"]
    assert [row["symbol"] for row in payload["movers"]["gainers"]][:2] == ["TATASTEEL", "HINDALCO"]
    assert [row["symbol"] for row in payload["movers"]["losers"]][:1] == ["WIPRO"]
    assert payload["movers"]["universe"] == "nse_large_caps"
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
    monkeypatch.setattr(india_market, "fetch_india_movers", down)

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


def test_nse_stock_change_is_measured_from_the_previous_session_not_a_stale_close():
    day = 86_400
    base = 1_762_900_000  # an arbitrary IST early morning; every bar below falls on its own session date
    chart = {
        "meta": {
            "regularMarketPrice": 1339.7,
            "regularMarketTime": base + 2 * day,
            "regularMarketVolume": 13_782_182,
            "longName": "Reliance Industries Limited",
            "exchangeTimezoneName": "Asia/Kolkata",
            # Yahoo's own previous close here is the start of the range, not yesterday.
            "chartPreviousClose": 1313.4,
        },
        "timestamp": [base, base + day, base + 2 * day, base + 2 * day + 3600],
        "indicators": {"quote": [{"close": [1300.0, 1335.4, 1339.0, 1339.7]}]},
    }
    row = india_market.parse_nse_chart(chart, "RELIANCE")
    # The duplicate live bar for the last session collapses, so the change is 1339.7 vs 1335.4.
    assert row["change_pct"] == pytest.approx((1339.7 / 1335.4 - 1) * 100)
    assert row["symbol"] == "RELIANCE" and row["company_name"] == "Reliance Industries Limited"
    assert (
        india_market.parse_nse_chart(
            {**chart, "timestamp": [base], "indicators": {"quote": [{"close": [1300.0]}]}}, "X"
        )
        is None
    )


def test_india_movers_rank_gainers_and_losers_and_share_one_timestamp():
    movers = india_market.build_india_movers(_mover_rows())
    assert [row["symbol"] for row in movers["gainers"]][:3] == ["TATASTEEL", "HINDALCO", "SBIN"]
    assert [row["symbol"] for row in movers["losers"]][:3] == ["WIPRO", "INFY", "TECHM"]
    assert "ITC" not in [
        row["symbol"] for row in (*movers["gainers"], *movers["losers"])
    ]  # flat is neither
    assert movers["universe_size"] == 7 and movers["degraded"] is False
    assert {row["as_of"] for row in movers["gainers"]} == {"2026-11-12T10:01:00+00:00"}


@pytest.mark.asyncio
async def test_index_cards_draw_the_last_session_and_never_a_month_line_beside_a_day_change(
    monkeypatch,
):
    from hushh_mcp.operons.kai import fetchers

    month = _points(*range(100, 122))
    session = [25301.0, 25310.0, 25299.0]
    session_points = _points(*session)

    async def fake(symbols, *, range_period="1d"):
        if range_period == "1d":
            return [
                {"ticker": symbol, "sparkline": session, "sparkline_points": session_points}
                for symbol in symbols
                if symbol != "^BSESN"
            ]
        return [_quote(symbol, 106, 0.18, month) for symbol in symbols]

    monkeypatch.setattr(fetchers, "_fetch_yahoo_quotes", fake)
    quotes = await india_market.fetch_india_quotes()
    assert quotes["^NSEI"]["sparkline"] == session
    assert (
        india_market.build_india_overview(quotes, STATUS)[0]["sparkline_points"] == session_points
    )
    assert quotes["^NSEI"]["sparkline_points"] == month
    assert quotes["^NSEI"]["change_percent"] == 0.18  # the day change still comes from daily closes
    assert (
        quotes["^BSESN"]["sparkline"] is None
    )  # no intraday data: neutral guide, not a month line
    assert len(quotes["^CNXAUTO"]["sparkline_points"]) == 22  # sector returns still use the month


@pytest.mark.asyncio
async def test_news_recovers_without_waiting_for_the_cached_india_home(monkeypatch):
    async def quotes():
        return _quotes()

    calls = 0

    async def news(_days):
        nonlocal calls
        calls += 1
        if calls <= 2:
            raise RuntimeError("news unavailable")
        return [{"title": "India markets", "url": "https://example.com/news"}]

    async def status(_exchange):
        return STATUS

    async def movers():
        return india_market.build_india_movers(_mover_rows())

    monkeypatch.setattr(market_insights, "get_market_cache_store_service", lambda: _FakeStore())
    monkeypatch.setattr(market_insights, "market_insights_cache", MarketInsightsCache())
    monkeypatch.setattr(market_insights, "_fetch_market_status_for_exchange", status)
    monkeypatch.setattr(india_market, "fetch_india_quotes", quotes)
    monkeypatch.setattr(india_market, "fetch_india_news", news)
    monkeypatch.setattr(india_market, "fetch_india_movers", movers)
    assert (await market_insights._get_india_market_payload("user_a", 7))["news_tape"] == []
    recovered = await market_insights._get_india_market_payload("user_a", 7)
    assert recovered["news_tape"][0]["title"] == "India markets"


@pytest.mark.asyncio
async def test_company_news_requires_owner_and_a_supported_india_symbol(monkeypatch):
    from fastapi import HTTPException

    calls = []

    async def news(days_back, *, symbol=None):
        calls.append((days_back, symbol))
        return [{"symbol": symbol, "title": "Company story", "url": "https://example.com/story"}]

    monkeypatch.setattr(market_insights, "get_market_cache_store_service", lambda: _FakeStore())
    monkeypatch.setattr(market_insights, "market_insights_cache", MarketInsightsCache())
    monkeypatch.setattr(india_market, "fetch_india_news", news)
    params = dict(
        symbols="TCS",
        days_back=7,
        cursor=None,
        limit=15,
        token_data={"user_id": "owner", "token": "synthetic"},
        market="IN",
    )
    with pytest.raises(HTTPException) as wrong_owner:
        await market_insights.get_market_news("other", **params)
    assert wrong_owner.value.status_code == 403
    with pytest.raises(HTTPException) as unsupported:
        await market_insights.get_market_news("owner", **{**params, "symbols": "UNKNOWN"})
    assert unsupported.value.status_code == 422 and not calls
    result = await market_insights.get_market_news("owner", **params)
    assert result["items"][0]["symbol"] == "TCS" and calls == [(7, "TCS")]


@pytest.mark.asyncio
async def test_a_failed_movers_refresh_keeps_serving_the_last_good_list(monkeypatch):
    good = {"gainers": [{"symbol": "TCS", "change_pct": 5.0}], "losers": [], "active": []}
    calls = {"count": 0}

    async def flaky() -> dict:
        calls["count"] += 1
        if calls["count"] == 1:
            return good
        raise RuntimeError("india_movers_rate_limited")

    monkeypatch.setattr(market_insights, "get_market_cache_store_service", lambda: _FakeStore())
    monkeypatch.setattr(market_insights, "market_insights_cache", MarketInsightsCache())
    monkeypatch.setattr(market_insights, "INDIA_MOVERS_FRESH_TTL_SECONDS", 0)
    monkeypatch.setattr(india_market, "fetch_india_movers", flaky)

    async def read() -> dict:
        value, *_ = await market_insights._get_or_refresh_public_module(
            key="india_movers:v1",
            fresh_ttl_seconds=market_insights.INDIA_MOVERS_FRESH_TTL_SECONDS,
            stale_ttl_seconds=market_insights.INDIA_MOVERS_STALE_TTL_SECONDS,
            fetcher=lambda: india_market.fetch_india_movers(),
        )
        return value

    assert (await read())["gainers"] == good["gainers"]
    # The refresh now fails, and the stale list is still what a reader gets.
    assert (await read())["gainers"] == good["gainers"]
    # Negative control: with nothing cached, a failing fetch surfaces instead of faking data.
    monkeypatch.setattr(market_insights, "market_insights_cache", MarketInsightsCache())
    monkeypatch.setattr(market_insights, "get_market_cache_store_service", lambda: _FakeStore())
    with pytest.raises(RuntimeError, match="rate_limited"):
        await read()


def _fx_chart(price: float = 88.4, stamp: int = 1_762_905_600) -> dict:
    return {"meta": {"regularMarketPrice": price, "regularMarketTime": stamp}}


def test_usd_inr_chart_parses_the_rate_and_its_day_and_rejects_bad_quotes():
    from hushh_mcp.market_data import fx_rate

    parsed = fx_rate.parse_usd_inr_chart(_fx_chart())
    assert parsed is not None
    assert parsed["rate"] == 88.4 and parsed["as_of"] == "2025-11-12"
    assert parsed["base"] == "USD" and parsed["quote"] == "INR"
    assert fx_rate.parse_usd_inr_chart(_fx_chart(price=0.88)) is None  # inverted pair
    assert fx_rate.parse_usd_inr_chart(_fx_chart(price=float("nan"))) is None
    assert fx_rate.parse_usd_inr_chart({"meta": {"regularMarketPrice": 88.4}}) is None


@pytest.mark.asyncio
async def test_usd_inr_rate_serves_the_last_good_rate_when_the_provider_fails(monkeypatch):
    from hushh_mcp.market_data import fx_rate

    store = _FakeStore()
    monkeypatch.setattr(market_insights, "get_market_cache_store_service", lambda: store)
    monkeypatch.setattr(market_insights, "market_insights_cache", MarketInsightsCache())
    good = fx_rate.parse_usd_inr_chart(_fx_chart())

    async def ok() -> dict:
        return good

    monkeypatch.setattr(market_insights, "fetch_usd_inr_rate", ok)
    first = await market_insights._get_usd_inr_rate()
    assert first["rate"] == 88.4 and first["stale"] is False

    # Move past the fresh window (not the stale one), then take the provider down.
    later = cache_module.time.time() + market_insights.USD_INR_FRESH_TTL_SECONDS + 3600
    monkeypatch.setattr(cache_module.time, "time", lambda: later)
    monkeypatch.setattr(market_insights, "time", lambda: later)

    async def down() -> dict:
        raise fx_rate.FxRateUnavailable("fx_provider_status_429")

    monkeypatch.setattr(market_insights, "fetch_usd_inr_rate", down)
    monkeypatch.setattr(market_insights, "market_insights_cache", MarketInsightsCache())
    served = await market_insights._get_usd_inr_rate()
    assert served["rate"] == 88.4 and served["as_of"] == good["as_of"]
    assert served["stale"] is True


@pytest.mark.asyncio
async def test_usd_inr_route_answers_503_with_no_cached_rate_and_no_provider(monkeypatch):
    from fastapi import HTTPException

    from hushh_mcp.market_data import fx_rate

    async def down() -> dict:
        raise fx_rate.FxRateUnavailable("fx_provider_status_429")

    monkeypatch.setattr(market_insights, "get_market_cache_store_service", lambda: _FakeStore())
    monkeypatch.setattr(market_insights, "market_insights_cache", MarketInsightsCache())
    monkeypatch.setattr(market_insights, "fetch_usd_inr_rate", down)
    monkeypatch.setattr(market_insights, "verify_user_id_match", lambda *_: None)

    with pytest.raises(HTTPException) as caught:
        await market_insights.get_market_usd_inr_rate("user_a", firebase_uid="user_a")
    assert caught.value.status_code == 503


def test_usd_inr_cache_key_is_outside_every_us_session_gated_prefix():
    gated = (
        *market_insights.MARKET_PRICE_REFRESH_PREFIXES,
        *shared_last_close.LAST_CLOSE_PREFIXES,
        "movers:",
    )
    assert not "fx:usd_inr:v1".startswith(tuple(gated))
