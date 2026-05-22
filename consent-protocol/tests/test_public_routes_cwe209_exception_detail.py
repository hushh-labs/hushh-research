"""
CWE-209 regression tests: public routes must not return exception detail in error responses.

Each test triggers an internal exception via a mocked service call and asserts that the
raw exception message does not appear in the response body. The sentinel string
"SENTINEL_INTERNAL_DETAIL" is embedded in the raised exception so it is unmistakable if
it leaks.

Routes covered:
  GET  /api/tickers/search
  GET  /api/tickers/all
  POST /api/tickers/sync-holdings/{user_id}
  GET  /api/investors/{investor_id}
  POST /api/investors/
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.investors as investors_module
import api.routes.tickers as tickers_module
from api.routes.investors import router as investors_router
from api.routes.tickers import router as tickers_router

_SENTINEL = "SENTINEL_INTERNAL_DETAIL"


# ---------------------------------------------------------------------------
# Client helpers
# ---------------------------------------------------------------------------


def _tickers_client() -> TestClient:
    app = FastAPI()
    app.include_router(tickers_router)
    return TestClient(app, raise_server_exceptions=False)


def _investors_client() -> TestClient:
    app = FastAPI()
    app.include_router(investors_router)
    return TestClient(app, raise_server_exceptions=False)


def _tickers_auth_client() -> TestClient:
    app = FastAPI()
    app.include_router(tickers_router)

    async def _fake_token():
        return {"user_id": "user-abc"}

    from api.middleware import require_vault_owner_token

    app.dependency_overrides[require_vault_owner_token] = _fake_token
    return TestClient(app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# Tickers routes
# ---------------------------------------------------------------------------


class TestTickerSearchDoesNotLeakDetail:
    def test_cache_exception_returns_500_without_detail(self):
        client = _tickers_client()
        mock_cache = MagicMock()
        mock_cache.loaded = True
        mock_cache.search.side_effect = RuntimeError(_SENTINEL)
        with patch.object(tickers_module, "ticker_cache", mock_cache):
            r = client.get("/api/tickers/search", params={"q": "AAPL"})
        assert r.status_code == 500
        assert _SENTINEL not in r.text

    def test_db_fallback_exception_returns_500_without_detail(self):
        client = _tickers_client()
        mock_cache = MagicMock()
        mock_cache.loaded = False
        with patch.object(tickers_module, "ticker_cache", mock_cache):
            with patch.object(
                tickers_module.TickerDBService,
                "search_tickers",
                new=AsyncMock(side_effect=RuntimeError(_SENTINEL)),
            ):
                r = client.get("/api/tickers/search", params={"q": "XYZ"})
        assert r.status_code == 500
        assert _SENTINEL not in r.text


class TestTickerAllDoesNotLeakDetail:
    def test_cache_reload_exception_returns_500_without_detail(self):
        client = _tickers_client()
        mock_cache = MagicMock()
        mock_cache.loaded = False
        mock_cache.load_from_db.side_effect = RuntimeError(_SENTINEL)
        with patch.object(tickers_module, "ticker_cache", mock_cache):
            r = client.get("/api/tickers/all")
        assert r.status_code == 500
        assert _SENTINEL not in r.text


class TestTickerSyncHoldingsDoesNotLeakDetail:
    def test_service_exception_returns_500_without_detail(self):
        client = _tickers_auth_client()
        with patch.object(
            tickers_module.TickerDBService,
            "sync_holdings_symbols",
            new=AsyncMock(side_effect=RuntimeError(_SENTINEL)),
        ):
            r = client.post(
                "/api/tickers/sync-holdings/user-abc",
                json={"holdings": [], "max_symbols": 10},
            )
        assert r.status_code == 500
        assert _SENTINEL not in r.text


# ---------------------------------------------------------------------------
# Investors routes
# ---------------------------------------------------------------------------


class TestInvestorFetchDoesNotLeakDetail:
    def test_db_exception_returns_500_without_detail(self):
        client = _investors_client()
        with patch.object(
            investors_module.InvestorDBService,
            "get_investor_by_id",
            new=AsyncMock(side_effect=RuntimeError(_SENTINEL)),
        ):
            r = client.get("/api/investors/42")
        assert r.status_code == 500
        assert _SENTINEL not in r.text


class TestInvestorCreateDoesNotLeakDetail:
    def test_db_exception_returns_500_without_detail(self):
        client = _investors_client()
        with patch.object(
            investors_module.InvestorDBService,
            "upsert_investor",
            new=AsyncMock(side_effect=RuntimeError(_SENTINEL)),
        ):
            r = client.post(
                "/api/investors/",
                json={"name": "Test Fund", "cik": "0001234567"},
            )
        assert r.status_code == 500
        assert _SENTINEL not in r.text
