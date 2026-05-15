"""
Tests proving that security-sensitive token comparisons use timing-safe
hmac.compare_digest rather than plain Python string equality.

Guards against CWE-208 (Observable Timing Discrepancy) in the
/api/user/lookup endpoint, which compares an incoming X-MCP-Developer-Token
header against the server-side HUSHH_DEVELOPER_TOKEN secret.

Also tests that the agents.py Kai route does not leak internal errors.
"""

import hmac
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi.testclient import TestClient

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_session_client():
    from fastapi import FastAPI

    from api.routes.session import router

    app = FastAPI()
    app.include_router(router)
    return TestClient(app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# Timing-safe comparison tests for /api/user/lookup
# ---------------------------------------------------------------------------


class TestLookupUserTimingSafeComparison:
    """
    The /api/user/lookup endpoint must use hmac.compare_digest for the
    X-MCP-Developer-Token comparison so that timing measurements cannot
    be used to infer the length of a matching prefix.

    CWE-208: Observable Timing Discrepancy.
    """

    def test_correct_token_is_accepted(self):
        """A valid token must grant access (functional correctness)."""
        client = _make_session_client()

        with (
            patch.dict("os.environ", {"HUSHH_DEVELOPER_TOKEN": "valid-secret-token-abc"}),
            patch("api.routes.session.get_firebase_auth_app") as mock_firebase,
            patch("api.routes.session.resolve_lookup_identifier") as mock_resolve,
        ):
            mock_resolve.return_value = ("email", "user@example.com")
            mock_firebase_app = MagicMock()
            mock_firebase.return_value = mock_firebase_app

            # Patch firebase auth.get_user_by_email
            mock_user = MagicMock()
            mock_user.uid = "uid123"
            mock_user.email = "user@example.com"
            mock_user.phone_number = None
            mock_user.display_name = "Test User"
            mock_user.photo_url = None
            mock_user.email_verified = True

            with patch("api.routes.session.ActorIdentityService"):
                from firebase_admin import auth as fb_auth

                with patch.object(fb_auth, "get_user_by_email", return_value=mock_user):
                    response = client.get(
                        "/api/user/lookup",
                        params={"email": "user@example.com"},
                        headers={"X-MCP-Developer-Token": "valid-secret-token-abc"},
                    )

        # Should succeed, not 403
        assert response.status_code != 403

    def test_wrong_token_is_rejected_with_403(self):
        """An incorrect token must be rejected with 403 Forbidden."""
        client = _make_session_client()

        with patch.dict("os.environ", {"HUSHH_DEVELOPER_TOKEN": "valid-secret-token-abc"}):
            response = client.get(
                "/api/user/lookup",
                params={"email": "user@example.com"},
                headers={"X-MCP-Developer-Token": "wrong-token"},
            )

        assert response.status_code == 403

    def test_missing_token_is_rejected_with_403(self):
        """A missing token must be rejected with 403 Forbidden."""
        client = _make_session_client()

        with patch.dict("os.environ", {"HUSHH_DEVELOPER_TOKEN": "valid-secret-token-abc"}):
            response = client.get(
                "/api/user/lookup",
                params={"email": "user@example.com"},
            )

        assert response.status_code == 403

    def test_empty_env_var_returns_503(self):
        """When HUSHH_DEVELOPER_TOKEN is unset, endpoint must return 503."""
        client = _make_session_client()

        with patch.dict("os.environ", {"HUSHH_DEVELOPER_TOKEN": ""}):
            response = client.get(
                "/api/user/lookup",
                params={"email": "user@example.com"},
                headers={"X-MCP-Developer-Token": "anything"},
            )

        assert response.status_code == 503

    def test_compare_digest_is_used_not_equality(self):
        """
        Prove the comparison goes through hmac.compare_digest by patching it
        and confirming it is called.

        This is the strongest possible test: if the implementation ever reverts
        to plain == the mock would not be called and the test would fail.
        """
        client = _make_session_client()

        digest_calls: list[tuple[str, str]] = []

        original_compare_digest = hmac.compare_digest

        def recording_compare_digest(a, b):
            digest_calls.append((a, b))
            return original_compare_digest(a, b)

        with (
            patch.dict("os.environ", {"HUSHH_DEVELOPER_TOKEN": "secret-abc"}),
            patch("api.routes.session.hmac.compare_digest", side_effect=recording_compare_digest),
        ):
            client.get(
                "/api/user/lookup",
                params={"email": "u@example.com"},
                headers={"X-MCP-Developer-Token": "wrong-token"},
            )

        assert len(digest_calls) >= 1, (
            "hmac.compare_digest was not called — the comparison is not timing-safe"
        )
        # Verify it was called with the right operands
        token_arg, secret_arg = digest_calls[0]
        assert secret_arg == "secret-abc"  # noqa: S105

    def test_partial_match_still_rejected(self):
        """
        A token that matches the expected prefix but not the full string
        must be rejected. This would succeed with a naive timing attack
        if using plain == but is rejected by compare_digest.
        """
        client = _make_session_client()
        correct = "abcdefghijklmnop"
        partial = correct[:8]  # Partial match

        with patch.dict("os.environ", {"HUSHH_DEVELOPER_TOKEN": correct}):
            response = client.get(
                "/api/user/lookup",
                params={"email": "u@example.com"},
                headers={"X-MCP-Developer-Token": partial},
            )

        assert response.status_code == 403


# ---------------------------------------------------------------------------
# Agents.py Kai route info-disclosure
# ---------------------------------------------------------------------------


class TestAgentsKaiInfoDisclosure:
    """POST /agents/kai must not forward internal exception messages to clients."""

    _POISON = "postgresql://admin:h4x@internal-db:5432/prod"

    def _make_client(self):
        from fastapi import FastAPI

        from api.routes.agents import router

        app = FastAPI()
        app.include_router(router)
        return TestClient(app, raise_server_exceptions=False)

    def test_kai_agent_500_does_not_leak_exception(self):
        client = self._make_client()

        mock_agent = MagicMock()
        mock_agent.handle_message.side_effect = RuntimeError(self._POISON)

        with patch("api.routes.agents.get_kai_agent", return_value=mock_agent):
            response = client.post(
                "/agents/kai/chat",
                json={"userId": "u1", "message": "hello"},
            )

        assert self._POISON not in response.text, (
            "SECURITY LEAK: internal exception detail leaked in HTTP response body"
        )

    def test_kai_agent_500_returns_static_message(self):
        client = self._make_client()

        mock_agent = MagicMock()
        mock_agent.handle_message.side_effect = Exception("crash")

        with patch("api.routes.agents.get_kai_agent", return_value=mock_agent):
            response = client.post(
                "/agents/kai/chat",
                json={"userId": "u1", "message": "hello"},
            )

        assert "crash" not in response.text
        if response.status_code == 500:
            assert "temporarily unavailable" in response.text.lower()
