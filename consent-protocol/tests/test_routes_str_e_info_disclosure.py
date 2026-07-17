# tests/test_routes_str_e_info_disclosure.py
"""
CWE-209: Verify that tickers, investors, and agents routes never surface
raw exception details (str(e)) in HTTP responses.

Each test injects a poison exception that contains a database DSN and asserts
the DSN is absent from the response body.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, PropertyMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.tickers as tickers_module
from api.middleware import require_firebase_auth
from api.routes.agents import router as agents_router
from api.routes.investors import router as investors_router
from api.routes.tickers import router as tickers_router

_POISON = "postgresql://admin:hunter2@db.internal:5432/hushh"


def _tickers_client() -> TestClient:
    app = FastAPI()
    app.include_router(tickers_router)
    return TestClient(app, raise_server_exceptions=False)


def _investors_client() -> TestClient:
    app = FastAPI()
    app.include_router(investors_router)
    app.dependency_overrides[require_firebase_auth] = lambda: "test_uid"
    return TestClient(app, raise_server_exceptions=False)


def _agents_client() -> TestClient:
    app = FastAPI()
    app.include_router(agents_router)
    return TestClient(app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# tickers.py
# ---------------------------------------------------------------------------


class TestTickerSearchInfoDisclosure:
    def test_search_hides_exception_detail(self):
        """DB error must not appear in GET /api/tickers/search response."""
        with (
            patch.object(
                type(tickers_module.ticker_cache),
                "loaded",
                new_callable=PropertyMock,
                return_value=False,
            ),
            patch(
                "api.routes.tickers.TickerDBService",
                side_effect=RuntimeError(_POISON),
            ),
        ):
            client = _tickers_client()
            r = client.get("/api/tickers/search", params={"q": "AAPL"})

        assert r.status_code == 500
        assert _POISON not in r.text
        assert "postgresql" not in r.text

    def test_all_tickers_hides_exception_detail(self):
        """DB error must not appear in GET /api/tickers/all response."""
        with (
            patch.object(
                type(tickers_module.ticker_cache),
                "loaded",
                new_callable=PropertyMock,
                return_value=False,
            ),
            patch.object(
                tickers_module.ticker_cache,
                "load_from_db",
                side_effect=RuntimeError(_POISON),
            ),
        ):
            client = _tickers_client()
            r = client.get("/api/tickers/all", params={"refresh": "true"})

        assert r.status_code == 500
        assert _POISON not in r.text
        assert "postgresql" not in r.text


# ---------------------------------------------------------------------------
# investors.py
# ---------------------------------------------------------------------------


class TestInvestorInfoDisclosure:
    def test_get_investor_hides_exception_detail(self):
        """DB error must not appear in GET /api/investors/{id} response."""
        mock_service = MagicMock()
        mock_service.get_investor_by_id = AsyncMock(side_effect=RuntimeError(_POISON))

        with patch("api.routes.investors.InvestorDBService", return_value=mock_service):
            client = _investors_client()
            r = client.get("/api/investors/42")  # investor_id is int

        assert r.status_code == 500
        assert _POISON not in r.text
        assert "postgresql" not in r.text

    def test_create_investor_hides_exception_detail(self):
        """DB error must not appear in POST /api/investors/ response."""
        mock_service = MagicMock()
        mock_service.upsert_investor = AsyncMock(side_effect=RuntimeError(_POISON))

        payload = {
            "name": "Test Investor",
            "cik": "0001234567",
        }

        with patch("api.routes.investors.InvestorDBService", return_value=mock_service):
            client = _investors_client()
            r = client.post("/api/investors/", json=payload)

        assert r.status_code == 500
        assert _POISON not in r.text
        assert "postgresql" not in r.text


# ---------------------------------------------------------------------------
# agents.py
# ---------------------------------------------------------------------------


class TestAgentInfoDisclosure:
    def test_kai_chat_hides_exception_detail(self):
        """Agent error must not appear in POST /api/agents/kai/chat response."""
        mock_agent = MagicMock()
        mock_agent.handle_message.side_effect = RuntimeError(_POISON)

        payload = {
            "userId": "user-123",
            "message": "What should I buy?",
            "sessionState": None,
        }

        with patch("api.routes.agents.get_kai_agent", return_value=mock_agent):
            client = _agents_client()
            r = client.post("/api/agents/kai/chat", json=payload)

        assert r.status_code == 500
        assert _POISON not in r.text
        assert "postgresql" not in r.text
