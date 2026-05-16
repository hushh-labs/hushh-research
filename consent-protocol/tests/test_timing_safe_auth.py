"""
Trust-boundary proof for CWE-208 fix in api.routes.session.lookup_user.

Canonical attach point
----------------------
api.routes.session.lookup_user
  -> hmac.compare_digest(x_mcp_developer_token, required_token)

The /api/user/lookup endpoint compares the incoming X-MCP-Developer-Token
header against the server-side HUSHH_DEVELOPER_TOKEN secret.

Before this fix the comparison used plain Python string inequality (!=),
which short-circuits on the first mismatched byte. An attacker making many
requests and measuring response latency can infer the correct prefix
character by character (timing oracle, CWE-208).

The fix uses hmac.compare_digest — consistent with five other
security-critical comparisons already in this codebase.

Tests prove:
1. The trust boundary is intact: 401/403/503 are returned for bad/missing
   credentials; the handler is reachable only when credentials are correct.
2. hmac.compare_digest is the actual comparison method (regression guard:
   reverting to != would break test_compare_digest_is_invoked).
3. Partial-prefix matches are rejected (the whole point of constant-time
   comparison).
"""

import hmac
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_lookup_client():
    """Minimal FastAPI app containing only api.routes.session router."""
    from fastapi import FastAPI

    from api.routes.session import router

    app = FastAPI()
    app.include_router(router)
    return TestClient(app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# Layer 1 — Trust boundary: api.routes.session.lookup_user
# ---------------------------------------------------------------------------


class TestLookupUserTrustBoundary:
    """
    api.routes.session.lookup_user is the canonical owner of the
    X-MCP-Developer-Token gate.

    These tests use the real route with no dependency overrides to prove
    that the boundary is enforced before any Firebase or DB I/O is reached.
    """

    def test_missing_token_returns_403(self):
        """No X-MCP-Developer-Token header must be rejected with 403."""
        client = _make_lookup_client()
        with patch.dict("os.environ", {"HUSHH_DEVELOPER_TOKEN": "valid-secret-token"}):
            response = client.get("/api/user/lookup", params={"email": "u@example.com"})
        assert response.status_code == 403

    def test_wrong_token_returns_403(self):
        """An incorrect X-MCP-Developer-Token must be rejected with 403."""
        client = _make_lookup_client()
        with patch.dict("os.environ", {"HUSHH_DEVELOPER_TOKEN": "valid-secret-token"}):
            response = client.get(
                "/api/user/lookup",
                params={"email": "u@example.com"},
                headers={"X-MCP-Developer-Token": "not-the-right-token"},
            )
        assert response.status_code == 403

    def test_unconfigured_env_returns_503(self):
        """When HUSHH_DEVELOPER_TOKEN is empty the endpoint must return 503."""
        client = _make_lookup_client()
        with patch.dict("os.environ", {"HUSHH_DEVELOPER_TOKEN": ""}):
            response = client.get(
                "/api/user/lookup",
                params={"email": "u@example.com"},
                headers={"X-MCP-Developer-Token": "anything"},
            )
        assert response.status_code == 503

    def test_correct_token_reaches_handler(self):
        """A valid token must pass the guard and reach the Firebase lookup."""
        client = _make_lookup_client()

        mock_user = MagicMock()
        mock_user.uid = "uid-abc"
        mock_user.email = "u@example.com"
        mock_user.phone_number = None
        mock_user.display_name = "Test"
        mock_user.photo_url = None
        mock_user.email_verified = True

        with (
            patch.dict("os.environ", {"HUSHH_DEVELOPER_TOKEN": "valid-secret-token"}),
            patch(
                "api.routes.session.resolve_lookup_identifier",
                return_value=("email", "u@example.com"),
            ),
            patch("api.routes.session.get_firebase_auth_app") as mock_fb_app,
            patch("api.routes.session.ActorIdentityService"),
        ):
            mock_fb_app.return_value = MagicMock()
            from firebase_admin import auth as fb_auth

            with patch.object(fb_auth, "get_user_by_email", return_value=mock_user):
                response = client.get(
                    "/api/user/lookup",
                    params={"email": "u@example.com"},
                    headers={"X-MCP-Developer-Token": "valid-secret-token"},
                )

        # Token was accepted; handler ran and returned user data.
        assert response.status_code == 200
        assert response.json()["exists"] is True


# ---------------------------------------------------------------------------
# Layer 2 — Timing-safe comparison proof: api.routes.session.lookup_user
# ---------------------------------------------------------------------------


class TestLookupUserTimingSafeComparison:
    """
    Prove that api.routes.session.lookup_user uses hmac.compare_digest for
    the X-MCP-Developer-Token comparison, not plain Python string equality.

    CWE-208: Observable Timing Discrepancy.
    """

    def test_compare_digest_is_invoked(self):
        """
        Patch hmac.compare_digest inside api.routes.session and assert it is
        called during a lookup request.

        If the implementation reverts to plain != this test fails because the
        mock would never be called.
        """
        client = _make_lookup_client()
        calls: list[tuple[str, str]] = []
        real = hmac.compare_digest

        def spy(a, b):
            calls.append((a, b))
            return real(a, b)

        with (
            patch.dict("os.environ", {"HUSHH_DEVELOPER_TOKEN": "secret-xyz"}),
            patch("api.routes.session.hmac.compare_digest", side_effect=spy),
        ):
            client.get(
                "/api/user/lookup",
                params={"email": "u@example.com"},
                headers={"X-MCP-Developer-Token": "wrong"},
            )

        assert len(calls) >= 1, (
            "hmac.compare_digest was never called -- comparison is not timing-safe"
        )
        _, secret_arg = calls[0]
        assert secret_arg == "secret-xyz"  # noqa: S105

    def test_partial_prefix_is_rejected(self):
        """
        A token whose bytes match the expected prefix but not the full secret
        must be rejected.

        Plain string != short-circuits after the mismatch, making prefix
        matches detectable by latency.  hmac.compare_digest always runs in
        constant time and rejects prefix matches.
        """
        client = _make_lookup_client()
        correct = "abcdefghijklmnopqrstuvwx"
        partial = correct[:12]

        with patch.dict("os.environ", {"HUSHH_DEVELOPER_TOKEN": correct}):
            response = client.get(
                "/api/user/lookup",
                params={"email": "u@example.com"},
                headers={"X-MCP-Developer-Token": partial},
            )

        assert response.status_code == 403
