"""Tests for session logout endpoint authentication and token revocation.

Verifies that POST /api/consent/logout:
1. Requires a valid VAULT_OWNER token (was previously unauthenticated)
2. Enforces userId/token ownership match
3. Calls revoke_token() for the presented session token
4. Returns 403 when userId does not match token claim

Also verifies SessionTokenRequest and LogoutRequest field bounds added in
api/models/schemas.py.

Canonical attach point:
- POST /api/consent/logout (api/routes/session.py)
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from api.middleware import require_vault_owner_token
from api.models.schemas import HistoryRequest, LogoutRequest, SessionTokenRequest
from api.routes.session import router as session_router

_FAKE_USER = "user_abc123"
_FAKE_TOKEN_DATA = {
    "user_id": _FAKE_USER,
    "token_type": "VAULT_OWNER",
    "scope": "vault.owner",
    "token": "HCT:test-session-token-string",
}


def _build_app(token_data: dict | None = None) -> FastAPI:
    app = FastAPI()
    app.include_router(session_router)
    if token_data is not None:
        app.dependency_overrides[require_vault_owner_token] = lambda: token_data
    return app


class TestLogoutRequiresAuth:
    """POST /api/consent/logout must reject unauthenticated requests."""

    def test_logout_without_token_returns_401(self):
        """Verify logout requires authentication (was previously unauthenticated stub)."""
        client = TestClient(_build_app())
        response = client.post("/api/consent/logout", json={"userId": _FAKE_USER})
        assert response.status_code == 401, (
            f"Unauthenticated logout should return 401, got {response.status_code}"
        )

    def test_logout_with_valid_token_succeeds(self):
        """Verify logout accepts request when userId matches token."""
        client = TestClient(_build_app(token_data=_FAKE_TOKEN_DATA))
        with patch("api.routes.session.revoke_token"):
            response = client.post("/api/consent/logout", json={"userId": _FAKE_USER})
        assert response.status_code == 200, f"Valid logout should succeed, got {response.status_code}"
        assert response.json()["status"] == "success"

    def test_logout_calls_revoke_token(self):
        """Verify logout calls revoke_token() with the presented session token."""
        client = TestClient(_build_app(token_data=_FAKE_TOKEN_DATA))
        with patch("api.routes.session.revoke_token") as mock_revoke:
            client.post("/api/consent/logout", json={"userId": _FAKE_USER})
        mock_revoke.assert_called_once_with(_FAKE_TOKEN_DATA["token"])

    def test_logout_rejects_mismatched_user_id(self):
        """Verify logout returns 403 when userId body does not match token claim."""
        client = TestClient(_build_app(token_data=_FAKE_TOKEN_DATA))
        response = client.post("/api/consent/logout", json={"userId": "other_user_xyz"})
        assert response.status_code == 403, (
            f"Mismatched userId should return 403, got {response.status_code}"
        )
        assert response.json()["detail"] == "userId does not match token"

    def test_logout_skips_revoke_when_no_token_str(self):
        """Verify logout handles token_data without 'token' key gracefully."""
        token_without_str = {k: v for k, v in _FAKE_TOKEN_DATA.items() if k != "token"}
        client = TestClient(_build_app(token_data=token_without_str))
        with patch("api.routes.session.revoke_token") as mock_revoke:
            response = client.post("/api/consent/logout", json={"userId": _FAKE_USER})
        assert response.status_code == 200
        mock_revoke.assert_not_called()


class TestSessionTokenRequestBounds:
    """Validate field bounds on SessionTokenRequest."""

    def test_user_id_at_max_length_accepted(self):
        req = SessionTokenRequest(userId="u" * 128)
        assert len(req.userId) == 128

    def test_user_id_over_max_length_rejected(self):
        with pytest.raises(ValidationError):
            SessionTokenRequest(userId="u" * 129)

    def test_empty_user_id_rejected(self):
        with pytest.raises(ValidationError):
            SessionTokenRequest(userId="")

    def test_scope_max_length_accepted(self):
        req = SessionTokenRequest(userId="uid", scope="s" * 64)
        assert len(req.scope) == 64

    def test_scope_over_max_length_rejected(self):
        with pytest.raises(ValidationError):
            SessionTokenRequest(userId="uid", scope="s" * 65)


class TestLogoutRequestBounds:
    """Validate field bounds on LogoutRequest."""

    def test_user_id_at_max_length_accepted(self):
        req = LogoutRequest(userId="u" * 128)
        assert len(req.userId) == 128

    def test_user_id_over_max_length_rejected(self):
        with pytest.raises(ValidationError):
            LogoutRequest(userId="u" * 129)

    def test_empty_user_id_rejected(self):
        with pytest.raises(ValidationError):
            LogoutRequest(userId="")


class TestHistoryRequestBounds:
    """Validate field bounds on HistoryRequest."""

    def test_user_id_at_max_length_accepted(self):
        req = HistoryRequest(userId="u" * 128)
        assert len(req.userId) == 128

    def test_user_id_over_max_length_rejected(self):
        with pytest.raises(ValidationError):
            HistoryRequest(userId="u" * 129)

    def test_page_below_minimum_rejected(self):
        with pytest.raises(ValidationError):
            HistoryRequest(userId="uid", page=0)

    def test_page_above_maximum_rejected(self):
        with pytest.raises(ValidationError):
            HistoryRequest(userId="uid", page=10_001)

    def test_limit_above_maximum_rejected(self):
        with pytest.raises(ValidationError):
            HistoryRequest(userId="uid", limit=201)
