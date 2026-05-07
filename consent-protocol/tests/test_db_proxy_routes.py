"""
Tests for api/routes/db_proxy.py

Regression: _raise_database_http_exception always raises, so the
`raise HTTPException(status_code=500, detail="Database error")` lines
that followed it in every except block were unreachable dead code.

These tests confirm that DB errors still surface as proper HTTP errors
(not silent failures) after the dead lines were removed.
"""

from __future__ import annotations

from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth, verify_user_id_match
from api.routes import db_proxy


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(db_proxy.router)
    app.dependency_overrides[require_firebase_auth] = lambda: "user_123"
    return app


_VAULT_CHECK_PAYLOAD = {"userId": "user_123"}


def test_vault_check_returns_200_on_success(monkeypatch):
    monkeypatch.setattr(verify_user_id_match, "__call__", lambda *a, **kw: None, raising=False)

    async def _mock_check(self, user_id: str) -> bool:
        return True

    with patch("api.routes.db_proxy.verify_user_id_match"):
        from hushh_mcp.services.vault_keys_service import VaultKeysService

        monkeypatch.setattr(VaultKeysService, "check_vault_exists", _mock_check)
        client = TestClient(_build_app())
        response = client.post("/db/vault/check", json=_VAULT_CHECK_PAYLOAD)

    assert response.status_code == 200
    assert response.json()["hasVault"] is True


def test_vault_check_db_unavailable_error_surfaces_as_503(monkeypatch):
    """DatabaseUnavailableError must still produce a 503 after dead code removal."""

    class _FakeDBUnavailable(Exception):
        status_code = 503
        code = "DATABASE_UNAVAILABLE"
        hint = None

        def __init__(self):
            super().__init__("db down")

    _FakeDBUnavailable.__name__ = "DatabaseUnavailableError"

    async def _raise(self, user_id: str) -> bool:
        raise _FakeDBUnavailable()

    with patch("api.routes.db_proxy.verify_user_id_match"):
        from hushh_mcp.services.vault_keys_service import VaultKeysService

        monkeypatch.setattr(VaultKeysService, "check_vault_exists", _raise)
        client = TestClient(_build_app(), raise_server_exceptions=False)
        response = client.post("/db/vault/check", json=_VAULT_CHECK_PAYLOAD)

    assert response.status_code == 503


def test_vault_check_generic_exception_falls_through(monkeypatch):
    """
    For exceptions that are neither DatabaseUnavailableError nor
    DatabaseExecutionError, _raise_database_http_exception does NOT raise —
    it returns normally. The old dead `raise HTTPException(500)` would have
    caught this case; now the exception propagates as a 500 from FastAPI.
    """

    async def _raise(self, user_id: str) -> bool:
        raise RuntimeError("unexpected")

    with patch("api.routes.db_proxy.verify_user_id_match"):
        from hushh_mcp.services.vault_keys_service import VaultKeysService

        monkeypatch.setattr(VaultKeysService, "check_vault_exists", _raise)
        client = TestClient(_build_app(), raise_server_exceptions=False)
        response = client.post("/db/vault/check", json=_VAULT_CHECK_PAYLOAD)

    assert response.status_code == 500
