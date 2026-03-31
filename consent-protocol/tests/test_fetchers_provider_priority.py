from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest

import hushh_mcp.operons.kai.fetchers as fetchers


def _valid_token(*_args, **_kwargs):
    return True, "", SimpleNamespace(user_id="user_1")


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
    assert called[:2] == ["finnhub_news", "pmp_news"]


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
