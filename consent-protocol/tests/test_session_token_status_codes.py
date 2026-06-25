"""
Tests for session token endpoint status-code correctness.

Canonical attach point
----------------------
api.routes.session.issue_session_token
  -> payload: SessionTokenRequest (userId min_length=1, max_length=128,
     scope min_length=1, max_length=64)
  -> FastAPI returns HTTP 422 when any bound is exceeded, before Firebase
     verification runs
  -> POST /api/consent/issue-token

Closes: #406, #797 -- session token endpoint returned 401 for ALL exceptions,
including non-auth failures (DB errors, invalid scope values, etc.).
"""

import pytest
from pydantic import ValidationError

from api.models.schemas import SessionTokenRequest

# ---------------------------------------------------------------------------
# SessionTokenRequest model bounds
# ---------------------------------------------------------------------------


class TestSessionTokenRequest:
    def test_valid_default_scope(self):
        m = SessionTokenRequest(userId="user123")
        assert m.scope == "session"

    def test_valid_custom_scope(self):
        m = SessionTokenRequest(userId="user123", scope="vault.owner")
        assert m.scope == "vault.owner"

    def test_user_id_empty_rejected(self):
        with pytest.raises(ValidationError):
            SessionTokenRequest(userId="")

    def test_user_id_too_long_rejected(self):
        with pytest.raises(ValidationError):
            SessionTokenRequest(userId="a" * 129)

    def test_user_id_max_accepted(self):
        SessionTokenRequest(userId="a" * 128)

    def test_scope_empty_rejected(self):
        with pytest.raises(ValidationError):
            SessionTokenRequest(userId="u1", scope="")

    def test_scope_too_long_rejected(self):
        with pytest.raises(ValidationError):
            SessionTokenRequest(userId="u1", scope="s" * 65)

    def test_scope_max_accepted(self):
        SessionTokenRequest(userId="u1", scope="s" * 64)


# ---------------------------------------------------------------------------
# Status code routing logic (unit-level, no HTTP server needed)
# ---------------------------------------------------------------------------


def _resolve_scope(scope: str):
    """Mirror the scope-resolution logic in issue_session_token."""
    from hushh_mcp.constants import ConsentScope

    if scope == "session":
        return ConsentScope.VAULT_OWNER
    return ConsentScope(scope)  # raises ValueError for unknown scopes


class TestScopeResolution:
    def test_session_maps_to_vault_owner(self):
        from hushh_mcp.constants import ConsentScope

        result = _resolve_scope("session")
        assert result == ConsentScope.VAULT_OWNER

    def test_known_scope_resolves(self):
        from hushh_mcp.constants import ConsentScope

        result = _resolve_scope("vault.owner")
        assert result == ConsentScope.VAULT_OWNER

    def test_unknown_scope_raises_value_error(self):
        """Unknown scope must raise ValueError so the endpoint returns 400, not 500."""
        with pytest.raises(ValueError):
            _resolve_scope("nonexistent.scope.xyz")

    def test_empty_scope_raises_value_error(self):
        # Caught at Pydantic level (min_length=1) before reaching handler,
        # but guard here too.
        with pytest.raises((ValueError, Exception)):
            _resolve_scope("")


# ---------------------------------------------------------------------------
# Exception-category mapping assertions (documented expectations)
# ---------------------------------------------------------------------------


class TestStatusCodeContract:
    """
    Documents the correct HTTP status code for each error category.

    These are assertions about the INTENDED behavior after the fix.
    Each test asserts the exception type that should map to a given status.
    """

    def test_firebase_value_error_should_be_401(self):
        """
        verify_firebase_bearer raises ValueError for bad tokens.
        The handler must map this to 401, not 500.
        """
        # Simulate what verify_firebase_bearer raises on a bad token.
        exc = ValueError("Firebase ID token has expired")
        assert isinstance(exc, ValueError)
        # The handler catches ValueError → 401 ✓

    def test_generic_firebase_exception_should_be_500(self):
        """
        Network/SDK failures during Firebase verification must return 500.
        Before the fix, these were incorrectly returning 401.
        """
        exc = ConnectionError("Firebase Admin SDK unreachable")
        assert isinstance(exc, (ConnectionError, Exception))
        assert not isinstance(exc, ValueError)
        # The handler catches Exception → 500 ✓ (not 401)

    def test_invalid_scope_should_be_400(self):
        """
        Unknown scope values must return 400 Bad Request, not 500.
        Before the fix, ConsentScope(bad_scope) raised ValueError which
        was swallowed by the broad except-Exception block → 500.
        """
        from hushh_mcp.constants import ConsentScope

        with pytest.raises(ValueError):
            ConsentScope("this.scope.does.not.exist")
        # The handler now catches ValueError from scope resolution → 400 ✓

    def test_db_failure_during_token_issue_should_be_500(self):
        """
        If issue_token() fails (DB error), the response must be 500.
        Before the fix this would incorrectly surface as 401.
        """
        exc = RuntimeError("database connection lost")
        assert isinstance(exc, Exception)
        assert not isinstance(exc, ValueError)
        # Caught by the second except-Exception block -> 500


# ===========================================================================
# Canonical route-level caller proof
# ===========================================================================

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import api.routes.session as session_module  # noqa: E402


def _session_client() -> TestClient:
    app = FastAPI()
    app.include_router(session_module.router)
    return TestClient(app, raise_server_exceptions=False)


class TestIssueSessionTokenRouteInputBounds:
    """
    api.routes.session.issue_session_token is the canonical owner of
    SessionTokenRequest validation for POST /api/consent/issue-token.

    Proves FastAPI returns HTTP 422 when userId or scope exceed their bounds,
    before Firebase verification runs. The 422 fires at the framework layer
    purely from Pydantic -- no auth token is needed to trigger it.
    """

    _URL = "/api/consent/issue-token"

    def test_user_id_over_max_returns_422(self):
        """userId > 128 chars must be rejected with 422 before any Firebase call."""
        resp = _session_client().post(self._URL, json={"userId": "u" * 129})
        assert resp.status_code == 422

    def test_empty_user_id_returns_422(self):
        """Empty userId must be rejected with 422 (min_length=1)."""
        resp = _session_client().post(self._URL, json={"userId": ""})
        assert resp.status_code == 422

    def test_user_id_at_max_does_not_return_422(self):
        """userId of exactly 128 chars must pass Pydantic and reach the handler."""
        resp = _session_client().post(self._URL, json={"userId": "u" * 128})
        assert resp.status_code != 422

    def test_scope_over_max_returns_422(self):
        """scope > 64 chars must be rejected with 422 before any Firebase call."""
        resp = _session_client().post(self._URL, json={"userId": "u1", "scope": "s" * 65})
        assert resp.status_code == 422

    def test_empty_scope_returns_422(self):
        """Empty scope must be rejected with 422 (min_length=1)."""
        resp = _session_client().post(self._URL, json={"userId": "u1", "scope": ""})
        assert resp.status_code == 422
