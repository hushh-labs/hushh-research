# tests/test_session_logout.py
"""
Trust-boundary proof for POST /api/consent/logout.

Route: POST /api/consent/logout  (api/routes/session.py :: logout_session)
Auth:  require_vault_owner_token -- caller must present a valid VAULT_OWNER token.

Trust boundary contract
-----------------------
1. No token              -> 401 (middleware rejects before handler runs)
2. Token for wrong user  -> 403 (handler rejects userId mismatch)
3. Token for correct user -> 200 + DB REVOKED events written + in-memory tokens revoked

Cross-instance consistency: each active session token receives both
  - revoke_token(token_id)            -- in-memory fast-path (this instance)
  - insert_event(action="REVOKED")    -- DB write (all instances)
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.session import router

_USER = "user-abc-123"
_TOKEN_DATA = {"user_id": _USER, "scope": "vault.owner"}

# Canonical route under test
_LOGOUT_URL = "/api/consent/logout"
_LOGOUT_BODY = {"userId": _USER}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _app_with_token(token_data: dict) -> FastAPI:
    """FastAPI app that injects *token_data* as the authenticated vault owner."""
    app = FastAPI()
    app.dependency_overrides[require_vault_owner_token] = lambda: token_data
    app.include_router(router)
    return app


def _app_no_override() -> FastAPI:
    """FastAPI app with real require_vault_owner_token -- no token provided."""
    app = FastAPI()
    app.include_router(router)
    return app


# ---------------------------------------------------------------------------
# Trust boundary -- authentication layer
# ---------------------------------------------------------------------------


class TestLogoutTrustBoundary:
    def test_no_token_returns_401(self):
        """POST /api/consent/logout without Authorization header must return 401."""
        client = TestClient(_app_no_override(), raise_server_exceptions=False)
        resp = client.post(_LOGOUT_URL, json=_LOGOUT_BODY)
        assert resp.status_code == 401, (
            f"Expected 401 when no token supplied; got {resp.status_code}"
        )

    def test_wrong_user_returns_403(self):
        """VAULT_OWNER token for a different user must return 403."""
        other_token = {"user_id": "attacker-uid", "scope": "vault.owner"}
        client = TestClient(_app_with_token(other_token), raise_server_exceptions=False)
        resp = client.post(_LOGOUT_URL, json=_LOGOUT_BODY)
        assert resp.status_code == 403, (
            f"Expected 403 when token user != request userId; got {resp.status_code}"
        )

    def test_correct_user_reaches_handler(self):
        """VAULT_OWNER token matching request userId must reach the handler (not 401/403)."""
        with patch(
            "api.routes.session.ConsentDBService.get_active_tokens",
            new_callable=AsyncMock,
            return_value=[],
        ):
            client = TestClient(_app_with_token(_TOKEN_DATA), raise_server_exceptions=False)
            resp = client.post(_LOGOUT_URL, json=_LOGOUT_BODY)
        assert resp.status_code == 200, (
            f"Expected 200 for authenticated correct-user request; got {resp.status_code}"
        )


# ---------------------------------------------------------------------------
# Revocation correctness -- in-memory + DB
# ---------------------------------------------------------------------------


class TestLogoutRevocation:
    """
    Caller: POST /api/consent/logout
    Service: api.routes.session.logout_session
    DB writes: ConsentDBService.insert_event(action="REVOKED") per active token
    Memory:    revoke_token(token_id) per active token
    """

    def _fake_tokens(self, count: int = 2) -> list[dict]:
        return [
            {"token_id": f"jwt-tok-{i}", "agent_id": "self", "scope": "vault.owner"}
            for i in range(count)
        ]

    def test_revokes_each_active_token_in_memory(self):
        """revoke_token must be called once per active session token."""
        fake = self._fake_tokens(2)
        with (
            patch(
                "api.routes.session.ConsentDBService.get_active_tokens",
                new_callable=AsyncMock,
                return_value=fake,
            ),
            patch(
                "api.routes.session.ConsentDBService.insert_event",
                new_callable=AsyncMock,
                return_value=1,
            ),
            patch("api.routes.session.revoke_token") as mock_revoke,
        ):
            client = TestClient(_app_with_token(_TOKEN_DATA), raise_server_exceptions=False)
            resp = client.post(_LOGOUT_URL, json=_LOGOUT_BODY)

        assert resp.status_code == 200
        assert mock_revoke.call_count == 2
        mock_revoke.assert_any_call("jwt-tok-0")
        mock_revoke.assert_any_call("jwt-tok-1")

    def test_writes_revoked_event_to_db_per_token(self):
        """insert_event(action='REVOKED') must be called once per active session token."""
        fake = self._fake_tokens(2)
        with (
            patch(
                "api.routes.session.ConsentDBService.get_active_tokens",
                new_callable=AsyncMock,
                return_value=fake,
            ),
            patch(
                "api.routes.session.ConsentDBService.insert_event",
                new_callable=AsyncMock,
                return_value=1,
            ) as mock_insert,
            patch("api.routes.session.revoke_token"),
        ):
            client = TestClient(_app_with_token(_TOKEN_DATA), raise_server_exceptions=False)
            resp = client.post(_LOGOUT_URL, json=_LOGOUT_BODY)

        assert resp.status_code == 200
        assert mock_insert.call_count == 2
        for c in mock_insert.call_args_list:
            assert c.kwargs["action"] == "REVOKED"
            assert c.kwargs["user_id"] == _USER
            assert c.kwargs["agent_id"] == "self"

    def test_returns_revoked_count(self):
        """Response body must include the number of tokens revoked."""
        fake = self._fake_tokens(3)
        with (
            patch(
                "api.routes.session.ConsentDBService.get_active_tokens",
                new_callable=AsyncMock,
                return_value=fake,
            ),
            patch(
                "api.routes.session.ConsentDBService.insert_event",
                new_callable=AsyncMock,
                return_value=1,
            ),
            patch("api.routes.session.revoke_token"),
        ):
            client = TestClient(_app_with_token(_TOKEN_DATA), raise_server_exceptions=False)
            resp = client.post(_LOGOUT_URL, json=_LOGOUT_BODY)

        assert resp.status_code == 200
        assert resp.json()["revoked_count"] == 3
        assert resp.json()["status"] == "success"

    def test_zero_active_tokens_returns_200(self):
        """No active tokens is a valid state -- must return 200 with count=0."""
        with patch(
            "api.routes.session.ConsentDBService.get_active_tokens",
            new_callable=AsyncMock,
            return_value=[],
        ):
            client = TestClient(_app_with_token(_TOKEN_DATA), raise_server_exceptions=False)
            resp = client.post(_LOGOUT_URL, json=_LOGOUT_BODY)

        assert resp.status_code == 200
        assert resp.json()["revoked_count"] == 0

    def test_tokens_without_token_id_are_skipped(self):
        """Tokens missing token_id must be skipped -- not cause an error."""
        fake = [
            {"agent_id": "self", "scope": "vault.owner"},  # no token_id key
            {"token_id": None, "agent_id": "self", "scope": "vault.owner"},  # None
            {"token_id": "jwt-valid", "agent_id": "self", "scope": "vault.owner"},
        ]
        with (
            patch(
                "api.routes.session.ConsentDBService.get_active_tokens",
                new_callable=AsyncMock,
                return_value=fake,
            ),
            patch(
                "api.routes.session.ConsentDBService.insert_event",
                new_callable=AsyncMock,
                return_value=1,
            ) as mock_insert,
            patch("api.routes.session.revoke_token") as mock_revoke,
        ):
            client = TestClient(_app_with_token(_TOKEN_DATA), raise_server_exceptions=False)
            resp = client.post(_LOGOUT_URL, json=_LOGOUT_BODY)

        assert resp.status_code == 200
        assert resp.json()["revoked_count"] == 1
        mock_revoke.assert_called_once_with("jwt-valid")
        assert mock_insert.call_count == 1

    def test_db_error_returns_500(self):
        """DB failure during revocation must return 500, not a silent 200."""
        with patch(
            "api.routes.session.ConsentDBService.get_active_tokens",
            new_callable=AsyncMock,
            side_effect=RuntimeError("DB connection lost"),
        ):
            client = TestClient(_app_with_token(_TOKEN_DATA), raise_server_exceptions=False)
            resp = client.post(_LOGOUT_URL, json=_LOGOUT_BODY)

        assert resp.status_code == 500
