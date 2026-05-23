"""
CWE-209 regression tests: vault state routes and kai/chat analyze endpoint
must not return exception detail in error responses.

Routes covered:
  POST /db/vault/bootstrap-state  (ValueError 400 and Exception 500 paths)
  POST /db/vault/pre-vault-state  (ValueError 400 and Exception 500 paths)
  POST /api/kai/chat/analyze-loser/{ticker}
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.db_proxy as db_proxy_module
import api.routes.kai.chat as kai_chat_module
from api.routes.db_proxy import router as db_proxy_router
from api.routes.kai.chat import router as kai_chat_router

_SENTINEL = "SENTINEL_INTERNAL_DETAIL_XYZ"


# ---------------------------------------------------------------------------
# Client helpers
# ---------------------------------------------------------------------------


def _db_client() -> TestClient:
    app = FastAPI()
    app.include_router(db_proxy_router)

    async def _fake_firebase():
        return "firebase-user-abc"

    from api.middleware import require_firebase_auth

    app.dependency_overrides[require_firebase_auth] = _fake_firebase
    return TestClient(app, raise_server_exceptions=False)


def _kai_client() -> TestClient:
    app = FastAPI()
    app.include_router(kai_chat_router, prefix="/api/kai")

    async def _fake_token():
        return {"user_id": "user-abc"}

    from api.middleware import require_vault_owner_token

    app.dependency_overrides[require_vault_owner_token] = _fake_token
    return TestClient(app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# vault/bootstrap-state
# ---------------------------------------------------------------------------


class TestVaultBootstrapStateDoesNotLeakDetail:
    def test_value_error_returns_400_without_detail(self) -> None:
        client = _db_client()
        with patch.object(
            db_proxy_module.VaultKeysService,
            "get_pre_vault_state",
            new=AsyncMock(side_effect=ValueError(_SENTINEL)),
        ):
            r = client.post("/db/vault/bootstrap-state", json={"userId": "firebase-user-abc"})
        assert r.status_code == 400
        assert _SENTINEL not in r.text

    def test_value_error_returns_validation_error_code(self) -> None:
        client = _db_client()
        with patch.object(
            db_proxy_module.VaultKeysService,
            "get_pre_vault_state",
            new=AsyncMock(side_effect=ValueError(_SENTINEL)),
        ):
            r = client.post("/db/vault/bootstrap-state", json={"userId": "firebase-user-abc"})
        assert r.status_code == 400
        assert r.json().get("detail", {}).get("code") == "VAULT_VALIDATION_ERROR"

    def test_value_error_detail_error_field_is_generic(self) -> None:
        client = _db_client()
        with patch.object(
            db_proxy_module.VaultKeysService,
            "get_pre_vault_state",
            new=AsyncMock(side_effect=ValueError(_SENTINEL)),
        ):
            r = client.post("/db/vault/bootstrap-state", json={"userId": "firebase-user-abc"})
        assert r.json().get("detail", {}).get("error") == "Validation error"

    def test_internal_exception_does_not_leak_detail(self) -> None:
        """General Exception path via _raise_database_http_exception must not leak."""
        client = _db_client()
        with patch.object(
            db_proxy_module.VaultKeysService,
            "get_pre_vault_state",
            new=AsyncMock(side_effect=RuntimeError(_SENTINEL)),
        ):
            r = client.post("/db/vault/bootstrap-state", json={"userId": "firebase-user-abc"})
        assert r.status_code in {500, 503}
        assert _SENTINEL not in r.text

    def test_db_connection_error_does_not_expose_dsn(self) -> None:
        dsn_error = f"psycopg2.OperationalError: host=db.prod.example.com dbname=hushh {_SENTINEL}"
        client = _db_client()
        with patch.object(
            db_proxy_module.VaultKeysService,
            "get_pre_vault_state",
            new=AsyncMock(side_effect=RuntimeError(dsn_error)),
        ):
            r = client.post("/db/vault/bootstrap-state", json={"userId": "firebase-user-abc"})
        assert "db.prod.example.com" not in r.text
        assert _SENTINEL not in r.text


# ---------------------------------------------------------------------------
# vault/pre-vault-state
# ---------------------------------------------------------------------------


class TestVaultPreVaultStateDoesNotLeakDetail:
    def test_value_error_returns_400_without_detail(self) -> None:
        client = _db_client()
        with patch.object(
            db_proxy_module.VaultKeysService,
            "update_pre_vault_state",
            new=AsyncMock(side_effect=ValueError(_SENTINEL)),
        ):
            r = client.post("/db/vault/pre-vault-state", json={"userId": "firebase-user-abc"})
        assert r.status_code == 400
        assert _SENTINEL not in r.text

    def test_value_error_returns_validation_error_code(self) -> None:
        client = _db_client()
        with patch.object(
            db_proxy_module.VaultKeysService,
            "update_pre_vault_state",
            new=AsyncMock(side_effect=ValueError(_SENTINEL)),
        ):
            r = client.post("/db/vault/pre-vault-state", json={"userId": "firebase-user-abc"})
        assert r.status_code == 400
        assert r.json().get("detail", {}).get("code") == "VAULT_VALIDATION_ERROR"

    def test_value_error_detail_error_field_is_generic(self) -> None:
        client = _db_client()
        with patch.object(
            db_proxy_module.VaultKeysService,
            "update_pre_vault_state",
            new=AsyncMock(side_effect=ValueError(_SENTINEL)),
        ):
            r = client.post("/db/vault/pre-vault-state", json={"userId": "firebase-user-abc"})
        assert r.json().get("detail", {}).get("error") == "Validation error"

    def test_internal_exception_does_not_leak_detail(self) -> None:
        client = _db_client()
        with patch.object(
            db_proxy_module.VaultKeysService,
            "update_pre_vault_state",
            new=AsyncMock(side_effect=RuntimeError(_SENTINEL)),
        ):
            r = client.post("/db/vault/pre-vault-state", json={"userId": "firebase-user-abc"})
        assert r.status_code in {500, 503}
        assert _SENTINEL not in r.text

    def test_db_connection_error_does_not_expose_dsn(self) -> None:
        dsn_error = f"psycopg2.OperationalError: host=db.prod.example.com dbname=hushh {_SENTINEL}"
        client = _db_client()
        with patch.object(
            db_proxy_module.VaultKeysService,
            "update_pre_vault_state",
            new=AsyncMock(side_effect=RuntimeError(dsn_error)),
        ):
            r = client.post("/db/vault/pre-vault-state", json={"userId": "firebase-user-abc"})
        assert "db.prod.example.com" not in r.text
        assert _SENTINEL not in r.text


# ---------------------------------------------------------------------------
# kai/chat analyze-loser
# ---------------------------------------------------------------------------


class TestKaiAnalyzeLosersDoesNotLeakDetail:
    def test_service_exception_returns_500_without_detail(self) -> None:
        client = _kai_client()
        mock_service = AsyncMock()
        mock_service.analyze_portfolio_loser = AsyncMock(side_effect=RuntimeError(_SENTINEL))
        with patch.object(kai_chat_module, "get_kai_chat_service", return_value=mock_service):
            r = client.post(
                "/api/kai/chat/analyze-loser",
                json={"user_id": "user-abc", "symbol": "AAPL"},
            )
        assert r.status_code == 500
        assert _SENTINEL not in r.text

    def test_service_exception_detail_is_generic(self) -> None:
        client = _kai_client()
        mock_service = AsyncMock()
        mock_service.analyze_portfolio_loser = AsyncMock(side_effect=RuntimeError(_SENTINEL))
        with patch.object(kai_chat_module, "get_kai_chat_service", return_value=mock_service):
            r = client.post(
                "/api/kai/chat/analyze-loser",
                json={"user_id": "user-abc", "symbol": "AAPL"},
            )
        assert r.json().get("detail") == "Analysis failed"

    def test_db_error_string_does_not_appear_in_response(self) -> None:
        """DB/stack trace strings must not leak through the analyze-loser error path."""
        internal = (
            f"psycopg2.ProgrammingError: column 'ticker' does not exist "
            f"LINE 1: SELECT * FROM kai_decisions WHERE ticker = 'AAPL' {_SENTINEL}"
        )
        client = _kai_client()
        mock_service = AsyncMock()
        mock_service.analyze_portfolio_loser = AsyncMock(side_effect=RuntimeError(internal))
        with patch.object(kai_chat_module, "get_kai_chat_service", return_value=mock_service):
            r = client.post(
                "/api/kai/chat/analyze-loser",
                json={"user_id": "user-abc", "symbol": "AAPL"},
            )
        assert r.status_code == 500
        assert "psycopg2" not in r.text
        assert "kai_decisions" not in r.text
        assert _SENTINEL not in r.text

    def test_api_key_error_does_not_leak_key_material(self) -> None:
        """API key errors (e.g. from external financial APIs) must not appear in responses."""
        key_error = f"APIKeyError: Invalid Finnhub token: sk-fh-{_SENTINEL}-secret-key"
        client = _kai_client()
        mock_service = AsyncMock()
        mock_service.analyze_portfolio_loser = AsyncMock(side_effect=RuntimeError(key_error))
        with patch.object(kai_chat_module, "get_kai_chat_service", return_value=mock_service):
            r = client.post(
                "/api/kai/chat/analyze-loser",
                json={"user_id": "user-abc", "symbol": "TSLA"},
            )
        assert r.status_code == 500
        assert "sk-fh" not in r.text
        assert _SENTINEL not in r.text
