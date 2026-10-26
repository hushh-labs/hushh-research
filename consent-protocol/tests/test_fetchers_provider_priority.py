from __future__ import annotations

import httpx
import pytest

import hushh_mcp.operons.kai.fetchers as fetchers
from tests.helpers.market_runtime import (  # noqa: F401
    _unexpected_validate,
    _valid_token,
    isolated_public_provider_cache,
)


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
async def test_yahoo_fast_uses_chart_quote_time_without_inventing_yield(monkeypatch):
    from hushh_mcp.services.legacy_market_data_adapter import _nullable_quote

    original_client = httpx.AsyncClient

    def reply(request):
        assert request.url.path == "/v8/finance/chart/TEST"
        return httpx.Response(
            200,
            request=request,
            json={
                "chart": {
                    "result": [
                        {
                            "meta": {
                                "symbol": "TEST",
                                "regularMarketPrice": 100,
                                "regularMarketTime": 1793000000,
                            }
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
    row = _nullable_quote(await fetchers._fetch_yahoo_quote_fast("TEST"))
    assert row["price"] == 100
    assert row["quoted_at"] == "2026-10-26T07:33:20+00:00"
    assert row["dividend_yield"] is None


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
