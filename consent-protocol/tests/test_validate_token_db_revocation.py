"""
Trust-boundary proof for the DB-backed revocation upgrade in
api.routes.agents.validate_token_endpoint.

Canonical attach point
----------------------
api.routes.agents.validate_token_endpoint        (POST /api/validate-token)
  -> validate_token_with_db(request.token)
  -> returns {"valid": False, "reason": "Token validation failed"} on any failure
  -> returns {"valid": True, user_id, agent_id, scope} on success

Before the fix the endpoint called validate_token (HMAC + in-memory cache only).
Hussh runs on multiple Cloud Run instances.  When a token is revoked:
  1. The revocation is written to the DB.
  2. The in-memory cache on the processing instance is updated.
  3. Other instances do NOT know about the revocation until they query the DB.

With the weaker validate_token, POST /api/validate-token would return
{"valid": true} for a revoked token on any instance that had not processed
the revocation, allowing the frontend to proceed with privileged actions.

The stream.py route already applied validate_token_with_db and carried a
comment noting that the weaker validate_token was the "previous" check.
This fix brings validate_token_endpoint into alignment.

Tests prove:
1. validate_token_with_db is the actual call path (regression guard).
2. DB-revoked tokens return {"valid": false} even with a valid HMAC.
3. Valid tokens return the correct user_id / agent_id / scope fields.
4. Internal reason strings do not leak to the HTTP response body.
5. DB unavailability is handled fail-closed for scoped tokens.
6. Unexpected exceptions do not propagate to the client.
"""

from unittest.mock import AsyncMock, MagicMock, patch

from fastapi.testclient import TestClient


def _make_client() -> TestClient:
    """Minimal FastAPI app containing only api.routes.agents router."""
    from fastapi import FastAPI

    from api.routes.agents import router

    app = FastAPI()
    app.include_router(router)
    return TestClient(app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# Canonical attach-point proof:
# api.routes.agents.validate_token_endpoint (POST /api/validate-token)
# ---------------------------------------------------------------------------


class TestValidateTokenEndpointDbRevocationProof:
    """
    api.routes.agents.validate_token_endpoint is the canonical owner of the
    POST /api/validate-token response.

    Proves that the endpoint uses validate_token_with_db (DB-backed revocation)
    rather than the weaker in-memory-only validate_token, and that internal
    reason strings never reach the HTTP response body.
    """

    def test_db_check_function_is_called(self):
        """
        Patch validate_token_with_db inside api.routes.agents and assert it
        is invoked for every /api/validate-token request.

        If the implementation reverts to validate_token the mock is never
        called and this assertion fails.
        """
        client = _make_client()

        mock_result = (
            True,
            None,
            MagicMock(user_id="u1", agent_id="a1", scope=MagicMock(value="vault.owner")),
        )

        with patch(
            "api.routes.agents.validate_token_with_db",
            new=AsyncMock(return_value=mock_result),
        ) as mock_db_check:
            client.post("/api/validate-token", json={"token": "hussh:fake.token"})

        mock_db_check.assert_called_once()

    def test_db_revoked_token_returns_invalid(self):
        """
        A token marked revoked in the DB must return {"valid": false} even if
        its HMAC signature is still valid.

        This is the exact cross-instance revocation scenario: token signed
        correctly but revoked on another instance and written only to the DB.
        """
        client = _make_client()

        with patch(
            "api.routes.agents.validate_token_with_db",
            new=AsyncMock(return_value=(False, "Token has been revoked (DB check)", None)),
        ):
            response = client.post("/api/validate-token", json={"token": "hussh:revoked.token"})

        assert response.status_code == 200
        body = response.json()
        assert body["valid"] is False
        assert body["reason"] == "Token validation failed"
        assert "DB check" not in body.get("reason", "")

    def test_valid_token_returns_expected_fields(self):
        """A valid, non-revoked token must return the correct user_id/agent_id/scope."""
        client = _make_client()

        mock_token_obj = MagicMock()
        mock_token_obj.user_id = "firebase-uid-abc"
        mock_token_obj.agent_id = "self"
        mock_token_obj.scope = MagicMock(value="vault.owner")

        with patch(
            "api.routes.agents.validate_token_with_db",
            new=AsyncMock(return_value=(True, None, mock_token_obj)),
        ):
            response = client.post("/api/validate-token", json={"token": "hussh:valid.token"})

        assert response.status_code == 200
        body = response.json()
        assert body["valid"] is True
        assert body["user_id"] == "firebase-uid-abc"
        assert body["agent_id"] == "self"
        assert body["scope"] == "vault.owner"

    def test_expired_token_reason_not_leaked(self):
        """
        An expired token must return {"valid": false} with the generic reason,
        not the internal "Token expired" string (CWE-203 oracle).
        """
        client = _make_client()

        with patch(
            "api.routes.agents.validate_token_with_db",
            new=AsyncMock(return_value=(False, "Token expired", None)),
        ):
            response = client.post("/api/validate-token", json={"token": "hussh:old.token"})

        assert response.status_code == 200
        body = response.json()
        assert body["valid"] is False
        assert "expired" not in body.get("reason", "").lower()
        assert body["reason"] == "Token validation failed"

    def test_db_unavailable_returns_invalid_for_scoped_token(self):
        """
        When the DB is unreachable, validate_token_with_db applies fail-closed
        for non-VAULT_OWNER scopes.  The endpoint must propagate this as invalid.
        """
        client = _make_client()

        with patch(
            "api.routes.agents.validate_token_with_db",
            new=AsyncMock(
                return_value=(
                    False,
                    "Token revocation status could not be confirmed (DB unavailable)",
                    None,
                )
            ),
        ):
            response = client.post("/api/validate-token", json={"token": "hussh:scoped.token"})

        assert response.json()["valid"] is False

    def test_exception_during_validation_does_not_propagate(self):
        """
        An unexpected exception inside validate_token_with_db must not reach
        the client.  The endpoint must return {"valid": false} with no internal
        detail.
        """
        client = _make_client()

        with patch(
            "api.routes.agents.validate_token_with_db",
            new=AsyncMock(side_effect=Exception("DB connection refused at 10.0.0.1:5432")),
        ):
            response = client.post("/api/validate-token", json={"token": "hussh:any.token"})

        assert response.status_code == 200
        body = response.json()
        assert body["valid"] is False
        assert "DB connection" not in response.text
        assert "10.0.0" not in response.text
