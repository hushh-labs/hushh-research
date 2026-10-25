from __future__ import annotations

import asyncio
from datetime import datetime

import httpx
import pytest

import hushh_mcp.operons.kai.fetchers as fetchers
from tests.helpers.market_runtime import (  # noqa: F401
    _unexpected_validate,
    _valid_token,
    isolated_public_provider_cache,
)


async def test_closed_price_port_retains_friday_quote_and_revalidates_monday(monkeypatch):
    from hushh_mcp.services.market_data_provider import bind_market_data_provider

    now = [datetime.fromisoformat("2026-07-17T19:59:00+00:00").timestamp()]
    monkeypatch.setattr(fetchers.time, "time", lambda: now[0])

    class RecordedProvider:
        name = "recorded"
        calls = 0

        async def fetch(self, _request):
            self.calls += 1
            return {
                "ticker": "AAPL",
                "price": 100 + self.calls,
                "quoted_at": "2026-07-17T19:45:00Z",
            }

    provider = RecordedProvider()
    with bind_market_data_provider(provider):
        assert (await fetchers.fetch_market_data("AAPL", "public"))["price"] == 101
        now[0] = datetime.fromisoformat("2026-07-19T16:00:00+00:00").timestamp()
        saved = await fetchers.fetch_market_data("AAPL", "public")
        assert saved["price"] == 101 and saved["is_stale"] is True
        assert saved["quoted_at"] == "2026-07-17T19:45:00Z"
        assert provider.calls == 1
        now[0] = datetime.fromisoformat("2026-07-20T13:30:00+00:00").timestamp()
        assert (await fetchers.fetch_market_data("AAPL", "public"))["price"] == 102
    assert provider.calls == 2


@pytest.mark.parametrize(
    "operation", ["quote", "quotes", "intraday", "movers", "sector_rotation", "session_history"]
)
async def test_closed_price_dispatchers_refuse_cold_reads_without_blocking_news(
    monkeypatch, operation
):
    from hushh_mcp.services.market_data_provider import (
        MarketDataRequest,
        bind_market_data_provider,
        fetch_with_market_provider,
    )
    from hushh_mcp.services.market_refresh_policy import MarketPriceRefreshPaused

    now = datetime.fromisoformat("2026-07-19T16:00:00+00:00").timestamp()
    monkeypatch.setattr(fetchers.time, "time", lambda: now)
    calls = []

    class RecordedProvider:
        name = "recorded"

        async def fetch(self, request):
            calls.append(request.operation)
            return []

    async def forbidden():
        calls.append("legacy")

    with bind_market_data_provider(RecordedProvider()):
        request = MarketDataRequest(operation, ("AAPL",))
        with pytest.raises(MarketPriceRefreshPaused):
            await fetchers._fetch_through_market_port(request)
        with pytest.raises(MarketPriceRefreshPaused):
            await fetch_with_market_provider(request, forbidden)
        assert calls == []
        await fetchers.fetch_market_news("AAPL", "public")
        await fetchers.fetch_market_company_facts("AAPL")
        from hushh_mcp.market_data.history import fetch_daily_history

        await fetch_daily_history("AAPL")
    assert calls == ["news", "ratios", "daily_history"]


@pytest.mark.parametrize("provider", ["finnhub", "pmp"])
async def test_quote_profile_chain_stops_before_second_send_at_close(monkeypatch, provider):
    from hushh_mcp.services.market_refresh_policy import (
        MarketPriceRefreshPaused,
        market_price_refresh_scope,
    )

    now = [datetime.fromisoformat("2026-07-17T19:59:59+00:00").timestamp()]
    closing = now[0] + 1
    monkeypatch.setattr(fetchers.time, "time", lambda: now[0])
    monkeypatch.setenv("FINNHUB_API_KEY", "fixture")
    monkeypatch.setenv("PMP_API_KEY", "fixture")
    monkeypatch.setattr(fetchers, "_provider_in_cooldown", lambda *_: False)
    real_client = httpx.AsyncClient
    sent = []

    def reply(request):
        sent.append(request.url.path)
        now[0] = closing
        payload = {"c": 100, "dp": 1} if provider == "finnhub" else [{"price": 100}]
        return httpx.Response(200, request=request, json=payload)

    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: real_client(transport=httpx.MockTransport(reply), **kwargs),
    )
    with pytest.raises(MarketPriceRefreshPaused), market_price_refresh_scope():
        await (
            fetchers._fetch_finnhub_quote("AAPL")
            if provider == "finnhub"
            else fetchers._fetch_pmp_quote("AAPL")
        )
    assert len(sent) == 1 and sent[0].endswith("/quote")


async def test_yfinance_thread_cannot_send_after_its_parent_scope_finishes(monkeypatch):
    import threading

    from curl_cffi.requests import Session

    from hushh_mcp.services.market_provider_telemetry import yahoo_counted_session
    from hushh_mcp.services.market_refresh_policy import (
        MarketPriceRefreshPaused,
        market_price_refresh_scope,
    )

    now = [datetime.fromisoformat("2026-07-17T19:59:59+00:00").timestamp()]
    monkeypatch.setattr(fetchers.time, "time", lambda: now[0])
    sent, first, resume = [], threading.Event(), threading.Event()
    monkeypatch.setattr(Session, "request", lambda *_args, **_kwargs: sent.append(True))
    yahoo_counted_session.cache_clear()
    session = yahoo_counted_session()

    def worker():
        session.request("GET", "https://query1.finance.yahoo.com/fixture")
        first.set()
        if not resume.wait(5):
            raise AssertionError("worker was not resumed")
        session.request("GET", "https://query1.finance.yahoo.com/fixture")

    try:
        with market_price_refresh_scope():
            task = asyncio.create_task(asyncio.to_thread(worker))
            assert await asyncio.to_thread(first.wait, 5)
        now[0] += 1
        resume.set()
        with pytest.raises(MarketPriceRefreshPaused):
            await task
        assert sent == [True]
    finally:
        resume.set()
        session.close()
        yahoo_counted_session.cache_clear()


@pytest.mark.asyncio
async def test_market_port_fixture_preserves_index_metadata_and_never_falls_back(monkeypatch):
    from hushh_mcp.services.market_data_provider import (
        FixtureMarketDataProvider,
        MarketDataRequest,
        MarketDataUnavailable,
        bind_market_data_provider,
    )

    async def forbidden(*_args, **_kwargs):
        raise AssertionError("fixture requests must never touch a legacy provider")

    monkeypatch.setattr(fetchers, "_legacy_fetch_market_data", forbidden)
    request = MarketDataRequest("quote", ("^GSPC",))
    fixture = FixtureMarketDataProvider(
        {
            request: {
                "ticker": "^GSPC",
                "price": 6000.0,
                "quoted_at": "2026-10-20T20:00:00Z",
                "quote_delay_minutes": 15,
                "pe_ratio": None,
            }
        }
    )
    with bind_market_data_provider(fixture):
        row = await fetchers.fetch_market_data("^GSPC", "market-public")
        assert row["quote_delay_minutes"] == 15
        assert row["quoted_at"] == "2026-10-20T20:00:00Z"
        assert row["pe_ratio"] is None
        with pytest.raises(MarketDataUnavailable, match="fixture_missing"):
            await fetchers.fetch_market_data("AAPL", "market-public")
    assert len(fixture.calls) == 2


@pytest.mark.asyncio
async def test_market_port_rejects_wrong_owner_before_fixture_read(monkeypatch):
    from hushh_mcp.services.market_data_provider import (
        FixtureMarketDataProvider,
        bind_market_data_provider,
    )

    monkeypatch.setattr(fetchers, "validate_token", _valid_token)
    fixture = FixtureMarketDataProvider({})
    with bind_market_data_provider(fixture):
        with pytest.raises(PermissionError, match="Token user mismatch"):
            await fetchers.fetch_market_data("AAPL", "another_owner", "token")
    assert fixture.calls == []


@pytest.mark.asyncio
async def test_market_data_batch_allows_public_fetch_without_token(monkeypatch):
    monkeypatch.setattr(fetchers, "validate_token", _unexpected_validate)
    monkeypatch.delenv("FINNHUB_API_KEY", raising=False)
    monkeypatch.delenv("PMP_API_KEY", raising=False)
    monkeypatch.delenv("FMP_API_KEY", raising=False)
    fetchers._MARKET_DATA_CACHE.clear()

    async def _yahoo_batch(_tickers):
        return [
            {
                "ticker": "AAPL",
                "price": 192.0,
                "change_percent": 0.5,
                "volume": 100,
                "market_cap": 1,
                "source": "Yahoo Quote (Batch)",
                "fetched_at": "2026-03-30T00:00:00Z",
                "ttl_seconds": 60,
            }
        ]

    monkeypatch.setattr(fetchers, "_fetch_yahoo_quotes", _yahoo_batch)

    payload = await fetchers.fetch_market_data_batch(["AAPL"], "user_1", None)
    assert payload["AAPL"]["source"] == "Yahoo Quote (Batch)"


@pytest.mark.asyncio
async def test_market_data_allows_public_fetch_without_token(monkeypatch):
    monkeypatch.setattr(fetchers, "validate_token", _unexpected_validate)
    monkeypatch.delenv("FINNHUB_API_KEY", raising=False)
    monkeypatch.delenv("PMP_API_KEY", raising=False)
    monkeypatch.delenv("FMP_API_KEY", raising=False)
    fetchers._MARKET_DATA_CACHE.clear()

    async def _yfinance_ok(ticker: str):
        return {
            "ticker": ticker,
            "price": 246.63,
            "change_percent": 0.9,
            "volume": 42,
            "market_cap": 10,
            "pe_ratio": 1,
            "pb_ratio": 1,
            "dividend_yield": 0,
            "company_name": ticker,
            "sector": "Technology",
            "industry": "Software",
            "source": "yfinance (Real-time)",
            "fetched_at": "2026-03-30T00:00:00Z",
            "ttl_seconds": 60,
            "is_stale": False,
        }

    monkeypatch.setattr(fetchers, "_fetch_yfinance_quote", _yfinance_ok)
    monkeypatch.setattr(fetchers, "_fetch_yahoo_quote_fast", _unexpected_validate)

    payload = await fetchers.fetch_market_data(
        "AAPL",
        "user_1",
        None,
        allow_slow_fallbacks=False,
    )
    assert payload["source"] == "yfinance (Real-time)"


@pytest.mark.asyncio
async def test_market_news_allows_public_fetch_without_token(monkeypatch):
    monkeypatch.setattr(fetchers, "validate_token", _unexpected_validate)
    monkeypatch.setenv("PMP_API_KEY", "pmp")

    async def _empty_finnhub(_ticker: str, _days_back: int):
        return []

    async def _pmp_ok(_ticker: str):
        return [
            {
                "title": "Apple ships new products",
                "description": "desc",
                "url": "https://example.com/apple-news",
                "publishedAt": "2026-02-20T00:00:00Z",
                "source": {"name": "PMP/FMP"},
                "provider": "pmp_fmp",
            }
        ]

    async def _empty_newsapi(_ticker: str, _days_back: int):
        return []

    async def _empty_google(_ticker: str, _days_back: int):
        return []

    monkeypatch.setattr(fetchers, "_fetch_finnhub_company_news", _empty_finnhub)
    monkeypatch.setattr(fetchers, "_fetch_pmp_news", _pmp_ok)
    monkeypatch.setattr(fetchers, "_fetch_newsapi_articles", _empty_newsapi)
    monkeypatch.setattr(fetchers, "_fetch_google_news_rss", _empty_google)

    rows = await fetchers.fetch_market_news("AAPL", "user_1", None)
    assert len(rows) == 1
    assert rows[0]["provider"] == "pmp_fmp"


async def test_bound_runtime_replaces_provider_and_public_cache_without_owner_context(monkeypatch):
    from hushh_mcp.market_data.runtime import bind_market_runtime
    from hushh_mcp.services.market_runtime_adapter import shared_market_runtime

    async def forbidden(*_args, **_kwargs):
        raise AssertionError("shared provider/cache must not be reached")

    monkeypatch.setattr(shared_market_runtime, "fetch", forbidden)
    monkeypatch.setattr(shared_market_runtime, "public_information", forbidden)
    monkeypatch.setattr(fetchers, "validate_token", _valid_token)

    class Runtime:
        def __init__(self):
            self.calls = []

        async def fetch(self, request, *, cached=False):
            self.calls.append((request.operation, request.symbols, cached))
            return {"ticker": "AAPL", "price": 101.0}

        async def public_information(self, key, *, fresh, stale, fetcher):
            self.calls.append((key, fresh, stale))
            if key == "sec:tickers:v1":
                return {"0": {"ticker": "AAPL", "cik_str": 320193}}
            if key.startswith("sec:submissions:"):
                return {
                    "filings": {
                        "form": ["10-K"],
                        "filingDate": ["2026-10-01"],
                        "accessionNumber": ["recorded-accession"],
                    }
                }
            return {"entity_name": "Apple", "latest_10k": {"revenue": 100.0}}

        def yahoo_session(self):
            raise AssertionError("no transport should be needed")

    runtime = Runtime()
    with bind_market_runtime(runtime):
        assert (await fetchers.fetch_market_data("AAPL", "user_1", "token"))["price"] == 101
        facts = await fetchers.fetch_sec_filings("AAPL", "user_1", "token")
        with pytest.raises(PermissionError, match="Token user mismatch"):
            await fetchers.fetch_market_data("AAPL", "another_owner", "token")
    assert facts["latest_10k"]["revenue"] == 100
    assert runtime.calls == [
        ("quote", ("AAPL",), True),
        ("sec:tickers:v1", 86400, 86400),
        ("sec:submissions:0000320193", 3600, 86400),
        ("sec:facts:v2:0000320193:recorded-accession", 86400, 604800),
    ]
    with pytest.raises(AssertionError, match="shared provider/cache"):
        await fetchers.fetch_market_data("AAPL", "user_1", "token")


async def test_closed_daily_history_uses_observed_bars_without_seeding_spot_quotes(monkeypatch):
    from hushh_mcp.market_data.history import fetch_daily_history

    now = datetime.fromisoformat("2026-07-19T16:00:00+00:00").timestamp()
    monkeypatch.setattr(fetchers.time, "time", lambda: now)
    calls = []

    async def recorded_get(self, url, *, params):
        calls.append((url, params))
        chart = {
            "meta": {
                "symbol": "MSFT",
                "currency": "USD",
                "regularMarketPrice": 103,
                "chartPreviousClose": 100,
                "exchangeTimezoneName": "America/New_York",
            },
            "timestamp": [1784208600, 1784295000],
            "indicators": {"quote": [{"close": [100, 103]}]},
        }
        return httpx.Response(
            200, json={"chart": {"result": [chart]}}, request=httpx.Request("GET", url)
        )

    monkeypatch.setattr(httpx.AsyncClient, "get", recorded_get)
    result = await fetch_daily_history("MSFT")
    assert len(calls) == 1 and calls[0][1] == {"range": "1mo", "interval": "1d"}
    assert result["points"] == [{"t": 1784208600.0, "p": 100.0}, {"t": 1784295000.0, "p": 103.0}]
    assert result["source"] == "Yahoo Chart (Batch)"
    assert fetchers._MARKET_DATA_CACHE == {}
