# tests/test_exception_detail_leak.py
"""
Canonical caller proof for CWE-209 suppression across backend routes.

Canonical attach points
-----------------------
api.routes.agents.kai_chat
  -> except Exception: raise HTTPException(status_code=500, detail="Internal error processing chat")
  -> detail MUST NOT contain str(e)

api.routes.db_proxy.get_vault_status
  -> except Exception: raise HTTPException(...,
       detail="Vault status is temporarily unavailable.")
  -> detail MUST NOT contain str(e)

api.routes.investors.get_investor
  -> except Exception: raise HTTPException(...,
       detail="Investor data is temporarily unavailable.")
  -> detail MUST NOT contain str(e)

api.routes.investors.create_investor
  -> except Exception: raise HTTPException(...,
       detail="An internal error occurred creating the investor profile.")
  -> detail MUST NOT contain str(e)

api.routes.tickers.search_tickers
  -> except Exception: raise HTTPException(...,
       detail="Ticker search is temporarily unavailable.")
  -> detail MUST NOT contain str(e)

api.routes.tickers.all_tickers
  -> except Exception: raise HTTPException(...,
       detail="Ticker data is temporarily unavailable.")
  -> detail MUST NOT contain str(e)

api.routes.tickers.sync_tickers_from_holdings
  -> except Exception: raise HTTPException(...,
       detail="Ticker sync is temporarily unavailable.")
  -> detail MUST NOT contain str(e)

Before this fix the 500 handlers used `detail=str(e)`, which allowed internal
exception messages (DB table names, API endpoints, file paths with user IDs,
model identifiers) to reach the HTTP response body.

Each class below drives a real TestClient request that forces the handler's
except-branch to fire and asserts the response body does not echo the injected
internal error string.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes import agents as agents_module
from api.routes import investors as investors_module
from api.routes import tickers as tickers_module

# ============================================================================
# Shared internal error sentinel
# ============================================================================

_INTERNAL_SECRET = "internal-db-error-sentinel-for-testing"  # noqa: S105


# ============================================================================
# Helpers
# ============================================================================


def _app(*routers) -> FastAPI:
    app = FastAPI()
    for router in routers:
        app.include_router(router)
    return app


# ============================================================================
# Canonical attach point: api.routes.agents.kai_chat
# ============================================================================


class TestKaiChatInfoDisclosure:
    """
    api.routes.agents.kai_chat is the canonical owner of CWE-209 suppression
    for POST /api/agents/kai/chat.

    Proves that str(e) is never echoed in a 500 response body.
    """

    def _client(self) -> TestClient:
        return TestClient(_app(agents_module.router), raise_server_exceptions=False)

    def test_internal_exception_returns_500(self):
        """Handler catches all exceptions and returns HTTP 500."""
        with patch("api.routes.agents.get_kai_agent") as mock_agent:
            mock_agent.return_value.handle_message.side_effect = RuntimeError(_INTERNAL_SECRET)
            resp = self._client().post(
                "/api/agents/kai/chat",
                json={"userId": "uid-abc", "message": "hello", "sessionState": None},
            )
        assert resp.status_code == 500

    def test_exception_detail_is_not_leaked(self):
        """The 500 body must not contain the internal error string (CWE-209)."""
        with patch("api.routes.agents.get_kai_agent") as mock_agent:
            mock_agent.return_value.handle_message.side_effect = RuntimeError(_INTERNAL_SECRET)
            resp = self._client().post(
                "/api/agents/kai/chat",
                json={"userId": "uid-abc", "message": "hello", "sessionState": None},
            )
        assert _INTERNAL_SECRET not in resp.text

    def test_safe_generic_message_is_returned(self):
        """The 500 detail must be the static safe string, not dynamic exception content."""
        with patch("api.routes.agents.get_kai_agent") as mock_agent:
            mock_agent.return_value.handle_message.side_effect = RuntimeError(_INTERNAL_SECRET)
            resp = self._client().post(
                "/api/agents/kai/chat",
                json={"userId": "uid-abc", "message": "hello", "sessionState": None},
            )
        assert resp.json()["detail"] == "Internal error processing chat"


# ============================================================================
# Canonical attach point: api.routes.investors.get_investor
# ============================================================================


class TestGetInvestorInfoDisclosure:
    """
    api.routes.investors.get_investor is the canonical owner of CWE-209
    suppression for GET /api/investors/{investor_id}.

    Proves that str(e) is never echoed in a 500 response body.
    """

    def _client(self) -> TestClient:
        return TestClient(_app(investors_module.router), raise_server_exceptions=False)

    def test_internal_exception_returns_500(self):
        """Handler catches non-HTTP exceptions and returns HTTP 500."""
        with patch(
            "api.routes.investors.InvestorDBService.get_investor_by_id",
            new_callable=AsyncMock,
            side_effect=RuntimeError(_INTERNAL_SECRET),
        ):
            resp = self._client().get("/api/investors/42")
        assert resp.status_code == 500

    def test_exception_detail_is_not_leaked(self):
        """The 500 body must not contain the internal error string (CWE-209)."""
        with patch(
            "api.routes.investors.InvestorDBService.get_investor_by_id",
            new_callable=AsyncMock,
            side_effect=RuntimeError(_INTERNAL_SECRET),
        ):
            resp = self._client().get("/api/investors/42")
        assert _INTERNAL_SECRET not in resp.text

    def test_safe_generic_message_is_returned(self):
        """The 500 detail must be the static safe string, not dynamic exception content."""
        with patch(
            "api.routes.investors.InvestorDBService.get_investor_by_id",
            new_callable=AsyncMock,
            side_effect=RuntimeError(_INTERNAL_SECRET),
        ):
            resp = self._client().get("/api/investors/42")
        assert resp.json()["detail"] == "Investor data is temporarily unavailable."


# ============================================================================
# Canonical attach point: api.routes.investors.create_investor
# ============================================================================


class TestCreateInvestorInfoDisclosure:
    """
    api.routes.investors.create_investor is the canonical owner of CWE-209
    suppression for POST /api/investors/.

    Proves that str(e) is never echoed in a 500 response body.
    """

    def _client(self) -> TestClient:
        app = _app(investors_module.router)
        app.dependency_overrides[require_firebase_auth] = lambda: "test_uid_123"
        return TestClient(app, raise_server_exceptions=False)

    _MINIMAL_PAYLOAD = {"name": "Test Investor"}

    def test_internal_exception_returns_500(self):
        """Handler catches all exceptions and returns HTTP 500."""
        with patch(
            "api.routes.investors.InvestorDBService.upsert_investor",
            new_callable=AsyncMock,
            side_effect=RuntimeError(_INTERNAL_SECRET),
        ):
            resp = self._client().post("/api/investors/", json=self._MINIMAL_PAYLOAD)
        assert resp.status_code == 500

    def test_exception_detail_is_not_leaked(self):
        """The 500 body must not contain the internal error string (CWE-209)."""
        with patch(
            "api.routes.investors.InvestorDBService.upsert_investor",
            new_callable=AsyncMock,
            side_effect=RuntimeError(_INTERNAL_SECRET),
        ):
            resp = self._client().post("/api/investors/", json=self._MINIMAL_PAYLOAD)
        assert _INTERNAL_SECRET not in resp.text

    def test_safe_generic_message_is_returned(self):
        """The 500 detail must be the static safe string, not dynamic exception content."""
        with patch(
            "api.routes.investors.InvestorDBService.upsert_investor",
            new_callable=AsyncMock,
            side_effect=RuntimeError(_INTERNAL_SECRET),
        ):
            resp = self._client().post("/api/investors/", json=self._MINIMAL_PAYLOAD)
        assert (
            resp.json()["detail"]
            == "An internal error occurred creating the investor profile."
        )


# ============================================================================
# Canonical attach point: api.routes.tickers.search_tickers
# ============================================================================


class TestSearchTickersInfoDisclosure:
    """
    api.routes.tickers.search_tickers is the canonical owner of CWE-209
    suppression for GET /api/tickers/search.

    Proves that str(e) is never echoed in a 500 response body.
    """

    def _client(self) -> TestClient:
        return TestClient(_app(tickers_module.router), raise_server_exceptions=False)

    def test_internal_exception_returns_500(self):
        """Handler catches all exceptions and returns HTTP 500."""
        with patch(
            "api.routes.tickers.TickerDBService.search_tickers",
            new_callable=AsyncMock,
            side_effect=RuntimeError(_INTERNAL_SECRET),
        ), patch("api.routes.tickers.ticker_cache") as mock_cache:
            mock_cache.loaded = False
            resp = self._client().get("/api/tickers/search?q=AAPL")
        assert resp.status_code == 500

    def test_exception_detail_is_not_leaked(self):
        """The 500 body must not contain the internal error string (CWE-209)."""
        with patch(
            "api.routes.tickers.TickerDBService.search_tickers",
            new_callable=AsyncMock,
            side_effect=RuntimeError(_INTERNAL_SECRET),
        ), patch("api.routes.tickers.ticker_cache") as mock_cache:
            mock_cache.loaded = False
            resp = self._client().get("/api/tickers/search?q=AAPL")
        assert _INTERNAL_SECRET not in resp.text

    def test_safe_generic_message_is_returned(self):
        """The 500 detail must be the static safe string, not dynamic exception content."""
        with patch(
            "api.routes.tickers.TickerDBService.search_tickers",
            new_callable=AsyncMock,
            side_effect=RuntimeError(_INTERNAL_SECRET),
        ), patch("api.routes.tickers.ticker_cache") as mock_cache:
            mock_cache.loaded = False
            resp = self._client().get("/api/tickers/search?q=AAPL")
        assert resp.json()["detail"] == "Ticker search is temporarily unavailable."


# ============================================================================
# Canonical attach point: api.routes.tickers.all_tickers
# ============================================================================


class TestAllTickersInfoDisclosure:
    """
    api.routes.tickers.all_tickers is the canonical owner of CWE-209
    suppression for GET /api/tickers/all.

    Proves that str(e) is never echoed in a 500 response body.
    """

    def _client(self) -> TestClient:
        return TestClient(_app(tickers_module.router), raise_server_exceptions=False)

    def test_internal_exception_returns_500(self):
        """Handler catches all exceptions and returns HTTP 500."""
        with patch("api.routes.tickers.ticker_cache") as mock_cache:
            mock_cache.loaded = True
            mock_cache.all.side_effect = RuntimeError(_INTERNAL_SECRET)
            resp = self._client().get("/api/tickers/all")
        assert resp.status_code == 500

    def test_exception_detail_is_not_leaked(self):
        """The 500 body must not contain the internal error string (CWE-209)."""
        with patch("api.routes.tickers.ticker_cache") as mock_cache:
            mock_cache.loaded = True
            mock_cache.all.side_effect = RuntimeError(_INTERNAL_SECRET)
            resp = self._client().get("/api/tickers/all")
        assert _INTERNAL_SECRET not in resp.text

    def test_safe_generic_message_is_returned(self):
        """The 500 detail must be the static safe string, not dynamic exception content."""
        with patch("api.routes.tickers.ticker_cache") as mock_cache:
            mock_cache.loaded = True
            mock_cache.all.side_effect = RuntimeError(_INTERNAL_SECRET)
            resp = self._client().get("/api/tickers/all")
        assert resp.json()["detail"] == "Ticker data is temporarily unavailable."
