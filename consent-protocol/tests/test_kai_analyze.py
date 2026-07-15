# tests/test_kai_analyze.py
"""
Unit tests for Kai analyze endpoint (/api/kai/analyze)

Tests VAULT_OWNER token enforcement and error handling.
"""

import pytest
from fastapi.testclient import TestClient

from api.routes.kai.analyze import router


@pytest.fixture
def client():
    """Create test client with router."""
    from fastapi import FastAPI

    app = FastAPI()
    app.include_router(router)

    return TestClient(app)


class TestAnalyzeRequiresVaultOwnerToken:
    """
    Test that /api/kai/analyze requires VAULT_OWNER token.
    No Firebase Auth fallback allowed per Consent-First Architecture.
    """

    @pytest.mark.asyncio
    async def test_analyze_missing_token_returns_401(self, client):
        """Test that missing Authorization header returns 401."""
        response = client.post("/analyze", json={"user_id": "test_user", "ticker": "AAPL"})

        assert response.status_code == 401
        assert "Bearer" in response.headers.get("WWW-Authenticate", "")
        assert "Missing Authorization header" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_analyze_invalid_token_returns_401(self, client):
        """Test that invalid token returns 401."""
        response = client.post(
            "/analyze",
            json={"user_id": "test_user", "ticker": "AAPL"},
            headers={"Authorization": "Bearer invalid_token_here"},
        )

        assert response.status_code == 401
        assert "Bearer" in response.headers.get("WWW-Authenticate", "")
        assert response.json()["detail"] == "Token validation failed."

    @pytest.mark.asyncio
    async def test_analyze_mismatched_user_id_returns_403(self, client, vault_owner_token_for_user):
        """Test that user_id mismatch returns 403."""
        token = vault_owner_token_for_user("user_a")

        # Try to use it for user B
        response = client.post(
            "/analyze",
            json={"user_id": "user_b", "ticker": "AAPL"},
            headers={"Authorization": f"Bearer {token}"},
        )

        assert response.status_code == 403
        assert "User ID does not match" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_analyze_valid_token_succeeds(self, client, vault_owner_token_for_user):
        """Test that valid VAULT_OWNER token allows analysis."""
        token = vault_owner_token_for_user("test_user")

        response = client.post(
            "/analyze",
            json={"user_id": "test_user", "ticker": "AAPL", "risk_profile": "balanced"},
            headers={"Authorization": f"Bearer {token}"},
        )

        # Should either succeed or fail with a server error (agent not configured)
        # but NOT with 401/403 (token should be accepted)
        assert response.status_code not in [401, 403], (
            f"Valid token should not be rejected, got {response.status_code}: {response.json()}"
        )


class TestAnalyzeRequestValidation:
    """Test request validation and error handling."""

    @pytest.mark.asyncio
    async def test_analyze_missing_ticker_returns_422(self, client, vault_owner_token_for_user):
        """Test that missing ticker returns 422 validation error."""
        token = vault_owner_token_for_user("test_user")

        response = client.post(
            "/analyze",
            json={"user_id": "test_user"},
            headers={"Authorization": f"Bearer {token}"},
        )

        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_analyze_invalid_risk_profile_returns_422(
        self, client, vault_owner_token_for_user
    ):
        """Test that invalid risk_profile returns 422."""
        token = vault_owner_token_for_user("test_user")

        response = client.post(
            "/analyze",
            json={"user_id": "test_user", "ticker": "AAPL", "risk_profile": "invalid"},
            headers={"Authorization": f"Bearer {token}"},
        )

        assert response.status_code == 422


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
