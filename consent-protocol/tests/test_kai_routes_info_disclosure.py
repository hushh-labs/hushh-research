# tests/test_kai_routes_info_disclosure.py
"""
Trust-boundary proof for CWE-209 fixes in api.routes.kai.analyze and
api.routes.kai.chat.

Canonical attach points
-----------------------
api.routes.kai.analyze.analyze_ticker          (POST /analyze)
  -> KaiOrchestrator.analyze(...)
  -> raises HTTPException(400, "Invalid analysis request.") on ValueError
  -> raises HTTPException(500, "Analysis is temporarily unavailable.") on Exception

api.routes.kai.chat.analyze_portfolio_loser    (POST /chat/analyze-loser)
  -> get_kai_chat_service().analyze_portfolio_loser(...)
  -> raises HTTPException(500, "Analysis is temporarily unavailable.") on Exception

Before the fix:
- analyze.py line 129: detail=str(e) on ValueError (400) -- exposes input details
- analyze.py line 143: detail=f"Analysis failed: {str(e)}" on Exception (500)
- chat.py line 381:    detail=f"Analysis failed: {str(e)}" on Exception (500)

Any of these paths could expose DB connection strings, internal hostnames,
or business logic details to HTTP callers.

Tests prove that the canonical caller (the route handler) suppresses the
exception string at the point where the HTTP response is constructed.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.kai import analyze as analyze_module
from api.routes.kai import chat as chat_module

_POISON = "postgresql://admin:hunter2@db.internal:5432/hushh"  # noqa: S105

_KAI_ORCHESTRATOR = "hushh_mcp.agents.kai.orchestrator.KaiOrchestrator"
_KAI_CHAT_SERVICE = "api.routes.kai.chat.get_kai_chat_service"


# ---------------------------------------------------------------------------
# App fixtures
# ---------------------------------------------------------------------------


def _vault_owner_override():
    return {
        "user_id": "user_test",
        "token": "fake-vault-token",
        "scope": "vault.owner",
    }


def _analyze_client() -> TestClient:
    app = FastAPI()
    app.include_router(analyze_module.router)
    app.dependency_overrides[require_vault_owner_token] = _vault_owner_override
    return TestClient(app, raise_server_exceptions=False)


def _chat_client() -> TestClient:
    app = FastAPI()
    app.include_router(chat_module.router)
    app.dependency_overrides[require_vault_owner_token] = _vault_owner_override
    return TestClient(app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# Canonical attach-point proof:
# api.routes.kai.analyze.analyze_ticker (POST /analyze)
# ---------------------------------------------------------------------------


class TestAnalyzeTickerInfoDisclosure:
    """
    api.routes.kai.analyze.analyze_ticker is the canonical owner of the
    400/500 error responses for the /analyze endpoint.

    Proves that ValueError and RuntimeError from the orchestrator are
    suppressed at the route level and do not reach the HTTP response body.
    """

    def test_value_error_returns_generic_400(self):
        """ValueError from orchestrator must not expose the exception message."""
        mock_orch = MagicMock()
        mock_orch.analyze = AsyncMock(side_effect=ValueError(f"internal validation: {_POISON}"))

        with patch(_KAI_ORCHESTRATOR, return_value=mock_orch):
            resp = _analyze_client().post(
                "/analyze",
                json={"user_id": "user_test", "ticker": "AAPL"},
                headers={"Authorization": "Bearer fake-vault-token"},
            )

        assert resp.status_code == 400
        assert _POISON not in resp.text, "Credentials must not appear in HTTP response"
        assert "internal validation" not in resp.text
        assert resp.json()["detail"] == "Invalid analysis request."

    def test_runtime_error_returns_generic_500(self):
        """RuntimeError must not expose internals in the 500 response."""
        mock_orch = MagicMock()
        mock_orch.analyze = AsyncMock(side_effect=RuntimeError(f"connection refused: {_POISON}"))

        with patch(_KAI_ORCHESTRATOR, return_value=mock_orch):
            resp = _analyze_client().post(
                "/analyze",
                json={"user_id": "user_test", "ticker": "AAPL"},
                headers={"Authorization": "Bearer fake-vault-token"},
            )

        assert resp.status_code == 500
        assert _POISON not in resp.text
        assert "connection refused" not in resp.text
        assert resp.json()["detail"] == "Analysis is temporarily unavailable."

    def test_value_error_detail_exact(self):
        """400 detail must match the exact static string."""
        mock_orch = MagicMock()
        mock_orch.analyze = AsyncMock(side_effect=ValueError("bad input"))

        with patch(_KAI_ORCHESTRATOR, return_value=mock_orch):
            resp = _analyze_client().post(
                "/analyze",
                json={"user_id": "user_test", "ticker": "AAPL"},
                headers={"Authorization": "Bearer fake-vault-token"},
            )

        assert resp.status_code == 400
        assert resp.json()["detail"] == "Invalid analysis request."

    def test_runtime_error_detail_exact(self):
        """500 detail must match the exact static string."""
        mock_orch = MagicMock()
        mock_orch.analyze = AsyncMock(side_effect=RuntimeError("boom"))

        with patch(_KAI_ORCHESTRATOR, return_value=mock_orch):
            resp = _analyze_client().post(
                "/analyze",
                json={"user_id": "user_test", "ticker": "AAPL"},
                headers={"Authorization": "Bearer fake-vault-token"},
            )

        assert resp.status_code == 500
        assert resp.json()["detail"] == "Analysis is temporarily unavailable."


# ---------------------------------------------------------------------------
# Canonical attach-point proof:
# api.routes.kai.chat.analyze_portfolio_loser (POST /chat/analyze-loser)
# ---------------------------------------------------------------------------


class TestAnalyzePortfolioLoserInfoDisclosure:
    """
    api.routes.kai.chat.analyze_portfolio_loser is the canonical owner of
    the 500 error response for the /chat/analyze-loser endpoint.

    Proves that RuntimeError from the chat service is suppressed at the
    route level and does not reach the HTTP response body.
    """

    def test_exception_returns_generic_500(self):
        """Exception inside analyze_portfolio_loser must not leak the error string."""
        service_mock = MagicMock()
        service_mock.analyze_portfolio_loser = AsyncMock(
            side_effect=RuntimeError(f"db error: {_POISON}")
        )

        with patch(_KAI_CHAT_SERVICE, return_value=service_mock):
            resp = _chat_client().post(
                "/chat/analyze-loser",
                json={"user_id": "user_test", "symbol": "AAPL"},
                headers={"Authorization": "Bearer fake-vault-token"},
            )

        assert resp.status_code == 500
        assert _POISON not in resp.text, "Credentials must not appear in HTTP response"
        assert "db error" not in resp.text
        assert resp.json()["detail"] == "Analysis is temporarily unavailable."

    def test_exception_detail_exact(self):
        """500 detail must match the exact static string."""
        service_mock = MagicMock()
        service_mock.analyze_portfolio_loser = AsyncMock(side_effect=RuntimeError("boom"))

        with patch(_KAI_CHAT_SERVICE, return_value=service_mock):
            resp = _chat_client().post(
                "/chat/analyze-loser",
                json={"user_id": "user_test", "symbol": "AAPL"},
                headers={"Authorization": "Bearer fake-vault-token"},
            )

        assert resp.status_code == 500
        assert resp.json()["detail"] == "Analysis is temporarily unavailable."
