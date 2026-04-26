# tests/test_kai_stream_auth_guard.py
"""
Unit tests for the Kai SSE stream auth guard.

Mirrors test_kai_analyze.py coverage discipline for /api/kai/analyze/stream.

These tests exercise _require_vault_owner_token() which previously used:
  - authorization.replace("Bearer ", "") — unsafe, replaced all occurrences
  - validate_token()                      — offline-only, no DB revocation check
  - no WWW-Authenticate header on 401    — missing RFC-7235 requirement

The fixes align the stream guard with the canonical pattern in api/middleware.py.
"""

from __future__ import annotations

import pytest


class TestStreamAuthMissingToken:
    """Missing or malformed Authorization header must return 401."""

    @pytest.mark.asyncio
    async def test_missing_authorization_header_returns_401(self, client, vault_owner_token_for_user):
        """No Authorization header → 401 with WWW-Authenticate: Bearer."""
        response = client.get(
            "/analyze/stream",
            params={"user_id": "test_user", "ticker": "AAPL"},
        )

        assert response.status_code == 401
        assert "Bearer" in response.headers.get("WWW-Authenticate", ""), (
            "RFC-7235 requires WWW-Authenticate header on 401"
        )

    @pytest.mark.asyncio
    async def test_non_bearer_scheme_returns_401(self, client):
        """Non-Bearer Authorization scheme → 401."""
        response = client.get(
            "/analyze/stream",
            params={"user_id": "test_user", "ticker": "AAPL"},
            headers={"Authorization": "Basic dXNlcjpwYXNz"},
        )

        assert response.status_code == 401
        assert "Bearer" in response.headers.get("WWW-Authenticate", "")

    @pytest.mark.asyncio
    async def test_empty_bearer_token_returns_401(self, client):
        """'Bearer ' with no token value → 401."""
        response = client.get(
            "/analyze/stream",
            params={"user_id": "test_user", "ticker": "AAPL"},
            headers={"Authorization": "Bearer "},
        )

        # Either 401 (empty token rejected) or 401 from invalid token — both correct
        assert response.status_code == 401


class TestStreamAuthInvalidToken:
    """Invalid or tampered tokens must be rejected."""

    @pytest.mark.asyncio
    async def test_garbage_token_returns_401(self, client):
        """Non-JWT garbage string → 401."""
        response = client.get(
            "/analyze/stream",
            params={"user_id": "test_user", "ticker": "AAPL"},
            headers={"Authorization": "Bearer not_a_real_token"},
        )

        assert response.status_code == 401
        assert "Bearer" in response.headers.get("WWW-Authenticate", ""), (
            "RFC-7235 requires WWW-Authenticate header on 401"
        )

    @pytest.mark.asyncio
    async def test_token_containing_bearer_substring_is_extracted_safely(
        self, client, vault_owner_token_for_user
    ):
        """
        Regression: authorization.replace('Bearer ', '') would corrupt a token
        that contains the substring 'Bearer ' anywhere inside it.

        The fix (removeprefix) is immune to this because it only removes the
        leading prefix, not all occurrences.

        We verify the guard rejects the header cleanly (401) rather than
        extracting a mangled token and producing a 500 server error.
        """
        # Craft a value that would be silently mangled by str.replace().
        # "Bearer " prefix + a token body that happens to include the text "Bearer ".
        malicious_header = "Bearer realtoken_Bearer _suffix"

        response = client.get(
            "/analyze/stream",
            params={"user_id": "test_user", "ticker": "AAPL"},
            headers={"Authorization": malicious_header},
        )

        # Should be a clean 401 from token validation, NOT a 500 server error.
        assert response.status_code in (401, 403), (
            f"Expected 401/403 from token validation, got {response.status_code}. "
            "A 500 here would indicate the replace() bug is still present."
        )


class TestStreamAuthUserMismatch:
    """A valid token for user A must be rejected when requesting on behalf of user B."""

    @pytest.mark.asyncio
    async def test_user_id_mismatch_returns_403(self, client, vault_owner_token_for_user):
        """Token issued for user_a cannot act for user_b."""
        token = vault_owner_token_for_user("user_a")

        response = client.get(
            "/analyze/stream",
            params={"user_id": "user_b", "ticker": "AAPL"},
            headers={"Authorization": f"Bearer {token}"},
        )

        assert response.status_code == 403, (
            f"Cross-user token use must return 403, got {response.status_code}"
        )
        assert "mismatch" in response.json().get("detail", "").lower()

    @pytest.mark.asyncio
    async def test_valid_token_correct_user_is_not_rejected_by_auth(
        self, client, vault_owner_token_for_user
    ):
        """
        A valid VAULT_OWNER token for the correct user must not be blocked at the
        auth layer, even if the analysis itself fails for other reasons.

        This mirrors test_kai_analyze.py::test_analyze_valid_token_succeeds.
        """
        token = vault_owner_token_for_user("test_user")

        response = client.get(
            "/analyze/stream",
            params={"user_id": "test_user", "ticker": "AAPL"},
            headers={"Authorization": f"Bearer {token}"},
        )

        # 401 or 403 must NOT be returned when the token is valid and user matches.
        assert response.status_code not in (401, 403), (
            f"Valid matching token must not be rejected by the auth guard. "
            f"Got {response.status_code}: {response.text[:200]}"
        )


@pytest.fixture
def client(vault_owner_token_for_user):
    """Thin FastAPI test client wrapping only the Kai stream router.

    Import the stream module directly via importlib to avoid triggering
    api/routes/kai/__init__.py, which eagerly imports every sibling router
    (analyze.py → middleware.py → hushh_mcp services → asyncpg).  The
    stream module itself carries no asyncpg dependency.
    """
    import importlib.util
    from pathlib import Path

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    stream_path = Path(__file__).resolve().parents[1] / "api" / "routes" / "kai" / "stream.py"
    spec = importlib.util.spec_from_file_location("api.routes.kai.stream", stream_path)
    stream_mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(stream_mod)
    router = stream_mod.router

    app = FastAPI()
    app.include_router(router)
    return TestClient(app, raise_server_exceptions=False)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
