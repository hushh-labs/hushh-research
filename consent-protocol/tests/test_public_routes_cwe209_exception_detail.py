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
  POST /db/vault/status
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.db_proxy as db_proxy_module
import api.routes.investors as investors_module
import api.routes.tickers as tickers_module
from api.routes.db_proxy import router as db_proxy_router
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


# ---------------------------------------------------------------------------
# db_proxy vault/status route
# ---------------------------------------------------------------------------


def _db_proxy_client() -> TestClient:
    """Client with Firebase auth bypassed (uid = 'user-vault-test')."""
    app = FastAPI()
    app.include_router(db_proxy_router)

    from api.middleware import require_firebase_auth

    async def _fake_firebase_auth():
        return "user-vault-test"

    app.dependency_overrides[require_firebase_auth] = _fake_firebase_auth
    return TestClient(app, raise_server_exceptions=False)


_VAULT_STATUS_BODY = {"userId": "user-vault-test", "consentToken": "tok_fake"}


class TestVaultStatusDoesNotLeakDetail:
    def test_internal_exception_returns_500_without_detail(self):
        """General Exception from get_vault_status must yield 500 with no raw message."""
        client = _db_proxy_client()
        with patch.object(
            db_proxy_module.VaultKeysService,
            "get_vault_status",
            new=AsyncMock(side_effect=RuntimeError(_SENTINEL)),
        ):
            with patch.object(
                db_proxy_module,
                "validate_vault_owner_token",
                new=AsyncMock(return_value=None),
            ):
                r = client.post("/db/vault/status", json=_VAULT_STATUS_BODY)
        assert r.status_code == 500
        assert _SENTINEL not in r.text
        assert r.json().get("detail") == "Internal server error"

    def test_value_error_returns_401_without_detail(self):
        """ValueError (e.g. user ID mismatch) must yield 401 Unauthorized with no raw message."""
        client = _db_proxy_client()
        with patch.object(
            db_proxy_module,
            "verify_user_id_match",
            side_effect=ValueError(_SENTINEL),
        ):
            r = client.post("/db/vault/status", json=_VAULT_STATUS_BODY)
        assert r.status_code == 401
        assert _SENTINEL not in r.text
        assert r.json().get("detail") == "Unauthorized"

    def test_db_exception_detail_does_not_expose_connection_string(self):
        """DB connection errors must not reveal DSN or internal stack details."""
        internal_db_err = (
            f"psycopg2.OperationalError: could not connect to server: Connection refused "
            f"host=db.prod.example.com port=5432 dbname=hushh_prod {_SENTINEL}"
        )
        client = _db_proxy_client()
        with patch.object(
            db_proxy_module.VaultKeysService,
            "get_vault_status",
            new=AsyncMock(side_effect=RuntimeError(internal_db_err)),
        ):
            with patch.object(
                db_proxy_module,
                "validate_vault_owner_token",
                new=AsyncMock(return_value=None),
            ):
                r = client.post("/db/vault/status", json=_VAULT_STATUS_BODY)
        assert r.status_code == 500
        assert "psycopg2" not in r.text
        assert "db.prod.example.com" not in r.text
        assert _SENTINEL not in r.text
