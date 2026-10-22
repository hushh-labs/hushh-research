from __future__ import annotations

import asyncio
from datetime import datetime
from types import SimpleNamespace

import httpx
import pytest

import hushh_mcp.operons.kai.fetchers as fetchers


@pytest.mark.parametrize(
    ("ticker", "field", "expected"),
    [
        ("AMZN", "free_cash_flow", 7_695_000_000),
        ("AAPL", "revenue", 416_161_000_000),
    ],
)
def test_recorded_sec_annual_headlines(ticker, field, expected):
    import json
    from datetime import date
    from pathlib import Path

    from hushh_mcp.services.sec_financial_facts import extract_annual_facts

    fixture = json.loads(
        (Path(__file__).parent / "fixtures" / "sec" / f"{ticker}.json").read_text()
    )
    extracted = extract_annual_facts(fixture, today=date(2026, 10, 21))
    assert extracted[field] == expected
    assert extracted["period_end"].startswith("2025")
    assert extracted["short_term_borrowings"] is None


def test_recorded_alphabet_trend_uses_periods_instead_of_filing_fiscal_year():
    import json
    from datetime import date
    from pathlib import Path

    from hushh_mcp.services.sec_financial_facts import extract_annual_facts

    fixture = json.loads((Path(__file__).parent / "fixtures" / "sec" / "GOOGL.json").read_text())
    trend = extract_annual_facts(fixture, today=date(2026, 10, 21))["revenue_trend"]
    assert [row["year"] for row in trend] == [2022, 2023, 2024, 2025]
    assert [row["value"] for row in trend] == [
        282836000000,
        307394000000,
        350018000000,
        402836000000,
    ]


def test_sec_latest_period_beats_tag_priority_and_rejects_quarterly_flow():
    from datetime import date

    from hushh_mcp.services.sec_financial_facts import extract_annual_facts

    annual = {
        "form": "10-K",
        "fp": "FY",
        "start": "2025-01-01",
        "end": "2025-12-31",
        "filed": "2026-02-01",
        "val": 200,
    }
    older = {**annual, "start": "2024-01-01", "end": "2024-12-31", "val": 100}
    quarter = {**annual, "start": "2025-10-01", "val": 900}
    payload = {
        "facts": {
            "us-gaap": {
                "RevenueFromContractWithCustomerExcludingAssessedTax": {
                    "units": {"USD": [older, quarter]}
                },
                "Revenues": {"units": {"USD": [annual]}},
            }
        }
    }
    result = extract_annual_facts(payload, today=date(2026, 10, 21))
    assert result["revenue"] == 200
    assert result["free_cash_flow"] is None
    assert extract_annual_facts(payload, today=date(2028, 1, 1))["revenue"] is None


@pytest.fixture(autouse=True)
def isolated_public_provider_cache(monkeypatch):
    from hushh_mcp.services import market_provider_cache
    from hushh_mcp.services.market_insights_cache import MarketInsightsCache

    class OfflineStore:
        async def get_entry(self, _key):
            return None

        async def set_entry(self, **_kwargs):
            return None

    monkeypatch.setattr(market_provider_cache, "market_insights_cache", MarketInsightsCache())
    monkeypatch.setattr(market_provider_cache, "get_market_cache_store_service", OfflineStore)
    opened_at = datetime.fromisoformat("2026-07-14T14:00:00+00:00").timestamp()
    monkeypatch.setattr(fetchers.time, "time", lambda: opened_at)
    monkeypatch.setattr(fetchers, "_MARKET_DATA_CACHE", {})
    monkeypatch.setattr(fetchers, "_MARKET_DATA_LOCKS", {})


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
    assert calls == ["news", "ratios"]


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


def _valid_token(*_args, **_kwargs):
    return True, "", SimpleNamespace(user_id="user_1")


def _unexpected_validate(*_args, **_kwargs):
    raise AssertionError("validate_token should not run for public-safe market baseline fetches")


@pytest.mark.asyncio
async def test_index_failure_never_calls_equity_plans_or_cools_down_stock_quotes(monkeypatch):
    monkeypatch.setenv("FINNHUB_API_KEY", "fh")
    monkeypatch.setenv("PMP_API_KEY", "pmp")
    monkeypatch.setattr(fetchers, "_get_cached_market_data", lambda *_args: None)
    monkeypatch.setattr(fetchers, "_set_cached_market_data", lambda *_args: None)
    monkeypatch.setattr(fetchers, "_provider_in_cooldown", lambda *_args: False)
    calls = []

    async def equity_quote(symbol):
        calls.append(symbol)
        return {"ticker": symbol, "price": 100.0}

    async def unavailable_index(symbol):
        raise RuntimeError("index quote unavailable")

    monkeypatch.setattr(fetchers, "_fetch_finnhub_quote", equity_quote)
    monkeypatch.setattr(fetchers, "_fetch_pmp_quote", equity_quote)
    monkeypatch.setattr(fetchers, "_fetch_yahoo_quote_fast", unavailable_index)
    with pytest.raises(fetchers.RealtimeDataUnavailable):
        await fetchers.fetch_market_data("^GSPC", "public", allow_slow_fallbacks=False)
    assert calls == []
    # Negative control: ordinary stock requests still use the equity ladder.
    quote = await fetchers.fetch_market_data("AAPL", "public", allow_slow_fallbacks=False)
    assert quote["price"] == 100.0
    assert calls == ["AAPL"]


@pytest.mark.asyncio
async def test_market_data_falls_back_from_finnhub_to_pmp(monkeypatch):
    monkeypatch.setattr(fetchers, "validate_token", _valid_token)
    monkeypatch.setenv("FINNHUB_API_KEY", "fh")
    monkeypatch.setenv("PMP_API_KEY", "pmp")

    called: list[str] = []

    async def _finnhub_fail(_ticker: str):
        called.append("finnhub")
        req = httpx.Request("GET", "https://finnhub.io/api/v1/quote")
        res = httpx.Response(400, request=req, text='{"detail":"Bad Request"}')
        raise httpx.HTTPStatusError("bad request", request=req, response=res)

    async def _pmp_ok(ticker: str):
        called.append("pmp")
        return {
            "ticker": ticker,
            "price": 201.5,
            "change_percent": 1.2,
            "volume": 1000,
            "market_cap": 100,
            "pe_ratio": 0,
            "pb_ratio": 0,
            "dividend_yield": 0,
            "company_name": "Apple Inc.",
            "sector": "stocks",
            "industry": "Tech",
            "source": "PMP/FMP",
            "fetched_at": "2026-02-20T00:00:00Z",
            "ttl_seconds": 60,
            "is_stale": False,
        }

    async def _should_not_run(_ticker: str):
        called.append("unexpected")
        return {"ticker": "AAPL", "price": 10}

    monkeypatch.setattr(fetchers, "_fetch_finnhub_quote", _finnhub_fail)
    monkeypatch.setattr(fetchers, "_fetch_pmp_quote", _pmp_ok)
    monkeypatch.setattr(fetchers, "_fetch_yfinance_quote", _should_not_run)
    monkeypatch.setattr(fetchers, "_fetch_yahoo_quote_fast", _should_not_run)

    payload = await fetchers.fetch_market_data("AAPL", "user_1", "vault_token")
    assert payload["source"] == "PMP/FMP"
    assert called == ["finnhub", "pmp"]


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [None, "quote", "profile", "transport"])
async def test_fmp_quote_budget_counts_every_attempt_once(monkeypatch, failure):
    monkeypatch.setenv("PMP_API_KEY", "fixture-key")
    monkeypatch.setattr(fetchers, "_provider_in_cooldown", lambda _key: False)
    monkeypatch.setattr(fetchers, "_mark_provider_cooldown", lambda *_args: None)
    recorded = []
    monkeypatch.setattr(fetchers, "record_fmp_call", lambda **kwargs: recorded.append(kwargs))

    def respond(request):
        endpoint = request.url.path.rsplit("/", 1)[-1]
        if failure == "transport":
            raise httpx.ConnectError("offline", request=request)
        if failure == endpoint:
            return httpx.Response(503, json={})
        return httpx.Response(
            200, json=[{"price": 100}] if endpoint == "quote" else [{"companyName": "Fixture"}]
        )

    original = httpx.AsyncClient
    monkeypatch.setattr(
        fetchers.httpx,
        "AsyncClient",
        lambda **kwargs: original(transport=httpx.MockTransport(respond), **kwargs),
    )
    if failure:
        with pytest.raises(httpx.HTTPError):
            await fetchers._fetch_pmp_quote("AAPL")
    else:
        await fetchers._fetch_pmp_quote("AAPL")
    paths = (
        ["/stable/quote"]
        if failure in {"quote", "transport"}
        else ["/stable/quote", "/stable/profile"]
    )
    assert [row["endpoint"] for row in recorded] == paths
    assert recorded[-1]["status_code"] == (
        None if failure == "transport" else 503 if failure else 200
    )


@pytest.mark.asyncio
async def test_market_data_uses_yahoo_when_yfinance_fails(monkeypatch):
    monkeypatch.setattr(fetchers, "validate_token", _valid_token)
    monkeypatch.delenv("FINNHUB_API_KEY", raising=False)
    monkeypatch.delenv("PMP_API_KEY", raising=False)
    monkeypatch.delenv("FMP_API_KEY", raising=False)

    called: list[str] = []

    async def _yfinance_fail(_ticker: str):
        called.append("yfinance")
        raise RuntimeError("rate-limited")

    async def _yahoo_ok(ticker: str):
        called.append("yahoo")
        return {
            "ticker": ticker,
            "price": 195.3,
            "change_percent": 0.4,
            "volume": 5,
            "market_cap": 1,
            "pe_ratio": 1,
            "pb_ratio": 1,
            "dividend_yield": 0,
            "company_name": ticker,
            "sector": "Unknown",
            "industry": "Unknown",
            "source": "Yahoo Quote (Fast)",
            "fetched_at": "2026-02-20T00:00:00Z",
            "ttl_seconds": 60,
            "is_stale": False,
        }

    monkeypatch.setattr(fetchers, "_fetch_yfinance_quote", _yfinance_fail)
    monkeypatch.setattr(fetchers, "_fetch_yahoo_quote_fast", _yahoo_ok)

    payload = await fetchers.fetch_market_data("MSFT", "user_1", "vault_token")
    assert payload["source"] == "Yahoo Quote (Fast)"
    assert called == ["yfinance", "yahoo"]


@pytest.mark.asyncio
async def test_market_data_uses_yfinance_rescue_when_premium_providers_are_absent(
    monkeypatch,
):
    monkeypatch.setattr(fetchers, "validate_token", _valid_token)
    monkeypatch.delenv("FINNHUB_API_KEY", raising=False)
    monkeypatch.delenv("PMP_API_KEY", raising=False)
    monkeypatch.delenv("FMP_API_KEY", raising=False)

    called: list[str] = []

    async def _yfinance_ok(ticker: str):
        called.append("yfinance")
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

    async def _unexpected_yahoo(_ticker: str):
        called.append("yahoo")
        raise AssertionError("Yahoo fast should not run when yfinance rescue succeeds")

    monkeypatch.setattr(fetchers, "_fetch_yfinance_quote", _yfinance_ok)
    monkeypatch.setattr(fetchers, "_fetch_yahoo_quote_fast", _unexpected_yahoo)

    payload = await fetchers.fetch_market_data(
        "AAPL",
        "user_1",
        "vault_token",
        allow_slow_fallbacks=False,
    )
    assert payload["source"] == "yfinance (Real-time)"
    assert called == ["yfinance"]


@pytest.mark.asyncio
async def test_newsapi_preserves_the_article_photo(monkeypatch):
    monkeypatch.setenv("NEWSAPI_KEY", "test")
    original_client = httpx.AsyncClient

    def response(request):
        return httpx.Response(
            200,
            json={
                "articles": [
                    {
                        "title": "Company news",
                        "url": "https://publisher.test/story",
                        "urlToImage": "https://publisher.test/story.jpg",
                        "source": {"name": "Publisher"},
                    }
                ]
            },
        )

    monkeypatch.setattr(
        fetchers.httpx,
        "AsyncClient",
        lambda **kwargs: original_client(transport=httpx.MockTransport(response), **kwargs),
    )
    rows = await fetchers._fetch_newsapi_articles("AAPL", 7)
    assert rows[0]["image_url"] == "https://publisher.test/story.jpg"


@pytest.mark.asyncio
async def test_market_news_falls_back_from_finnhub_to_pmp(monkeypatch):
    monkeypatch.setattr(fetchers, "validate_token", _valid_token)
    monkeypatch.setenv("FINNHUB_API_KEY", "fh")
    monkeypatch.setenv("PMP_API_KEY", "pmp")

    called: list[str] = []

    async def _finnhub_fail(_ticker: str, _days_back: int):
        called.append("finnhub_news")
        req = httpx.Request("GET", "https://finnhub.io/api/v1/company-news")
        res = httpx.Response(400, request=req, text='{"detail":"Bad Request"}')
        raise httpx.HTTPStatusError("bad request", request=req, response=res)

    async def _pmp_ok(_ticker: str):
        called.append("pmp_news")
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
        called.append("newsapi")
        return []

    async def _empty_google(_ticker: str, _days_back: int):
        called.append("google")
        return []

    monkeypatch.setattr(fetchers, "_fetch_finnhub_company_news", _finnhub_fail)
    monkeypatch.setattr(fetchers, "_fetch_pmp_news", _pmp_ok)
    monkeypatch.setattr(fetchers, "_fetch_newsapi_articles", _empty_newsapi)
    monkeypatch.setattr(fetchers, "_fetch_google_news_rss", _empty_google)

    rows = await fetchers.fetch_market_news("AAPL", "user_1", "vault_token")
    assert len(rows) == 1
    assert rows[0]["provider"] == "pmp_fmp"
    assert called == ["finnhub_news", "pmp_news"]


@pytest.mark.asyncio
async def test_market_news_stops_after_the_first_useful_provider(monkeypatch):
    monkeypatch.setattr(fetchers, "validate_token", _valid_token)
    monkeypatch.setenv("FINNHUB_API_KEY", "fh")

    called: list[str] = []

    async def _finnhub_ok(_ticker: str, _days_back: int):
        called.append("finnhub_news")
        return [
            {
                "title": "Apple reports results",
                "url": "https://example.com/apple-results",
                "publishedAt": "2026-07-19T00:00:00Z",
                "source": {"name": "Finnhub"},
                "provider": "finnhub",
            }
        ]

    async def _unexpected(*_args, **_kwargs):
        called.append("unexpected")
        raise AssertionError("fallback provider must not run after a usable result")

    monkeypatch.setattr(fetchers, "_fetch_finnhub_company_news", _finnhub_ok)
    monkeypatch.setattr(fetchers, "_fetch_pmp_news", _unexpected)
    monkeypatch.setattr(fetchers, "_fetch_newsapi_articles", _unexpected)
    monkeypatch.setattr(fetchers, "_fetch_google_news_rss", _unexpected)

    rows = await fetchers.fetch_market_news("AAPL", "user_1", "vault_token")
    assert len(rows) == 1
    assert called == ["finnhub_news"]


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


@pytest.mark.asyncio
async def test_market_data_falls_back_when_finnhub_is_rate_limited(monkeypatch):
    monkeypatch.setattr(fetchers, "validate_token", _valid_token)
    monkeypatch.setenv("FINNHUB_API_KEY", "fh")
    monkeypatch.setenv("PMP_API_KEY", "pmp")

    called: list[str] = []

    async def _finnhub_429(_ticker: str):
        called.append("finnhub")
        req = httpx.Request("GET", "https://finnhub.io/api/v1/quote")
        res = httpx.Response(
            429,
            request=req,
            text='{"error":"Resource exhausted"}',
        )
        raise httpx.HTTPStatusError("rate limited", request=req, response=res)

    async def _pmp_ok(ticker: str):
        called.append("pmp")
        return {
            "ticker": ticker,
            "price": 210.0,
            "change_percent": -0.5,
            "volume": 5000,
            "market_cap": 200,
            "pe_ratio": 0,
            "pb_ratio": 0,
            "dividend_yield": 0,
            "company_name": "MSFT Inc.",
            "sector": "Technology",
            "industry": "Software",
            "source": "PMP/FMP",
            "fetched_at": "2026-02-20T00:00:00Z",
            "ttl_seconds": 60,
            "is_stale": False,
        }

    monkeypatch.setattr(fetchers, "_fetch_finnhub_quote", _finnhub_429)
    monkeypatch.setattr(fetchers, "_fetch_pmp_quote", _pmp_ok)

    payload = await fetchers.fetch_market_data("MSFT", "user_1", "vault_token")
    assert payload["source"] == "PMP/FMP"
    assert called == ["finnhub", "pmp"]


@pytest.mark.asyncio
@pytest.mark.parametrize("yield_value", [None, 0, 0.02])
async def test_yahoo_fast_missing_dividend_yield_is_not_measured_zero(monkeypatch, yield_value):
    original_client = httpx.AsyncClient

    def reply(request):
        return httpx.Response(
            200,
            request=request,
            json={
                "quoteResponse": {
                    "result": [
                        {
                            "regularMarketPrice": 100,
                            "trailingAnnualDividendYield": yield_value,
                        }
                    ]
                }
            },
        )

    monkeypatch.setattr(fetchers, "_provider_in_cooldown", lambda *_: False)
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: original_client(transport=httpx.MockTransport(reply), **kwargs),
    )
    row = await fetchers._fetch_yahoo_quote_fast("TEST")
    assert row["dividend_yield"] == yield_value


def test_market_only_fundamentals_keep_unknown_distinct_from_measured_zero():
    from hushh_mcp.agents.kai.fundamental_agent import FundamentalAgent

    agent = FundamentalAgent(processing_mode="offline")
    missing = agent._build_market_only_analysis("TEST", {})["key_metrics"]
    assert (
        missing["price"] is None and missing["market_cap"] is None and missing["pe_ratio"] is None
    )
    measured = agent._build_market_only_analysis("TEST", {"change_percent": 0, "change_pct": 5})[
        "key_metrics"
    ]
    assert measured["change_percent"] == 0
