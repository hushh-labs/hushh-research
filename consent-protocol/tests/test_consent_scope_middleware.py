"""Behavioral contract tests for require_consent_scope middleware.

Verifies that the scope-gated dependency:
  - Accepts tokens whose granted scope satisfies the required scope
  - Accepts vault.owner tokens on any scoped endpoint (super-scope privilege)
  - Rejects missing Authorization headers with RFC-7235 WWW-Authenticate challenge
  - Rejects raw (non-Bearer) tokens (strict mode)
  - Rejects tokens with wrong scope
  - Rejects expired tokens
  - Rejects DB-revoked tokens

Also covers verify_user_id_match and _extract_token edge cases.
"""

from __future__ import annotations

import sys
import types
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import api.middleware as middleware
from hushh_mcp.consent.token import issue_token, revoke_token
from hushh_mcp.constants import ConsentScope

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

SCOPE = ConsentScope.BROKERAGE_TRANSFER_WRITE
USER_ID = "user_scope_test"
AGENT_ID = "agent_plaid"


@pytest.fixture(autouse=True)
def _clear_revocation_registry():
    from hushh_mcp.consent import token as token_module

    token_module._revoked_tokens.clear()
    yield
    token_module._revoked_tokens.clear()


def _fake_db_active(active: bool):
    """Return a patched sys.modules entry so DB always reports the given active state."""
    fake_module = types.ModuleType("hushh_mcp.services.consent_db")
    mock_svc = AsyncMock()
    mock_svc.is_token_active = AsyncMock(return_value=active)
    fake_module.ConsentDBService = lambda: mock_svc
    return fake_module


def _fake_db_error():
    """Return a patched sys.modules entry so DB always raises."""
    fake_module = types.ModuleType("hushh_mcp.services.consent_db")
    mock_svc = AsyncMock()
    mock_svc.is_token_active = AsyncMock(side_effect=Exception("DB down"))
    fake_module.ConsentDBService = lambda: mock_svc
    return fake_module


def _build_app_for_scope(required_scope: str | ConsentScope) -> FastAPI:
    """Build a minimal FastAPI app with a single protected route."""
    from fastapi import Depends

    app = FastAPI()
    dep = middleware.require_consent_scope(required_scope)

    @app.get("/protected")
    async def _protected(token_data: dict = Depends(dep)):
        return {"user_id": token_data["user_id"], "scope": token_data["scope"]}

    return app


# ---------------------------------------------------------------------------
# Valid token — matching scope
# ---------------------------------------------------------------------------


def test_valid_scoped_token_is_accepted():
    """A token whose scope exactly matches the required scope must pass."""
    tok = issue_token(USER_ID, AGENT_ID, SCOPE)

    with pytest.MonkeyPatch.context() as mp:
        mp.setitem(sys.modules, "hushh_mcp.services.consent_db", _fake_db_active(True))
        mp.setenv("TESTING", "false")

        app = _build_app_for_scope(SCOPE)
        client = TestClient(app, raise_server_exceptions=True)
        resp = client.get("/protected", headers={"Authorization": f"Bearer {tok.token}"})

    assert resp.status_code == 200
    assert resp.json()["user_id"] == USER_ID


# ---------------------------------------------------------------------------
# vault.owner super-scope — must unlock any scoped endpoint
# ---------------------------------------------------------------------------


def test_vault_owner_token_accepted_on_scoped_endpoint():
    """vault.owner is a super-scope: it must satisfy any required scope."""
    vault_tok = issue_token(USER_ID, AGENT_ID, ConsentScope.VAULT_OWNER)

    with pytest.MonkeyPatch.context() as mp:
        mp.setitem(sys.modules, "hushh_mcp.services.consent_db", _fake_db_active(True))
        mp.setenv("TESTING", "false")

        app = _build_app_for_scope(SCOPE)
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get("/protected", headers={"Authorization": f"Bearer {vault_tok.token}"})

    assert resp.status_code == 200
    assert resp.json()["user_id"] == USER_ID


# ---------------------------------------------------------------------------
# Missing Authorization header → 401 with WWW-Authenticate
# ---------------------------------------------------------------------------


def test_missing_auth_header_returns_401_with_challenge():
    """No Authorization header must yield 401 with WWW-Authenticate: Bearer."""
    app = _build_app_for_scope(SCOPE)
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/protected")

    assert resp.status_code == 401
    assert resp.headers.get("www-authenticate") == "Bearer"


def test_empty_auth_header_returns_401():
    """Whitespace-only Authorization must be treated as missing."""
    app = _build_app_for_scope(SCOPE)
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/protected", headers={"Authorization": "   "})

    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Raw token (no Bearer prefix) → 401 in strict mode
# ---------------------------------------------------------------------------


def test_raw_token_without_bearer_prefix_rejected():
    """require_consent_scope uses strict mode: raw tokens must be rejected."""
    tok = issue_token(USER_ID, AGENT_ID, SCOPE)

    app = _build_app_for_scope(SCOPE)
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/protected", headers={"Authorization": tok.token})

    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Wrong scope token → 401
# ---------------------------------------------------------------------------


def test_wrong_scope_token_rejected():
    """A token with a different scope must not satisfy the required scope."""
    wrong_tok = issue_token(USER_ID, AGENT_ID, ConsentScope.PKM_READ)

    with pytest.MonkeyPatch.context() as mp:
        mp.setitem(sys.modules, "hushh_mcp.services.consent_db", _fake_db_active(True))
        mp.setenv("TESTING", "false")

        app = _build_app_for_scope(SCOPE)
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get("/protected", headers={"Authorization": f"Bearer {wrong_tok.token}"})

    assert resp.status_code == 401


def test_pkm_write_scope_rejected_for_brokerage_endpoint():
    """pkm.write does not cover brokerage.transfer.write — distinct scopes."""
    pkm_write_tok = issue_token(USER_ID, AGENT_ID, ConsentScope.PKM_WRITE)

    with pytest.MonkeyPatch.context() as mp:
        mp.setitem(sys.modules, "hushh_mcp.services.consent_db", _fake_db_active(True))
        mp.setenv("TESTING", "false")

        app = _build_app_for_scope(SCOPE)
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get("/protected", headers={"Authorization": f"Bearer {pkm_write_tok.token}"})

    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Expired token → 401
# ---------------------------------------------------------------------------


def test_expired_token_rejected():
    """An already-expired token must be rejected regardless of scope."""
    expired_tok = issue_token(USER_ID, AGENT_ID, SCOPE, expires_in_ms=-1000)

    app = _build_app_for_scope(SCOPE)
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/protected", headers={"Authorization": f"Bearer {expired_tok.token}"})

    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# In-memory revoked token → 401
# ---------------------------------------------------------------------------


def test_in_memory_revoked_token_rejected():
    """Token revoked in local memory must be rejected before hitting the DB."""
    tok = issue_token(USER_ID, AGENT_ID, SCOPE)
    revoke_token(tok.token)

    with pytest.MonkeyPatch.context() as mp:
        mp.setitem(sys.modules, "hushh_mcp.services.consent_db", _fake_db_active(True))
        mp.setenv("TESTING", "false")

        app = _build_app_for_scope(SCOPE)
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get("/protected", headers={"Authorization": f"Bearer {tok.token}"})

    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# DB-revoked token (cross-instance) → 401
# ---------------------------------------------------------------------------


def test_db_revoked_token_rejected():
    """Token revoked in DB (not in local memory) must be caught by DB check."""
    tok = issue_token(USER_ID, AGENT_ID, SCOPE)

    with pytest.MonkeyPatch.context() as mp:
        mp.setitem(sys.modules, "hushh_mcp.services.consent_db", _fake_db_active(False))
        mp.setenv("TESTING", "false")

        app = _build_app_for_scope(SCOPE)
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get("/protected", headers={"Authorization": f"Bearer {tok.token}"})

    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# DB unavailable → scoped token fails closed (consent integrity)
# ---------------------------------------------------------------------------


def test_scoped_token_fails_closed_when_db_unavailable():
    """When DB is down, scoped tokens must be denied — revocation unconfirmable."""
    tok = issue_token(USER_ID, AGENT_ID, SCOPE)

    with pytest.MonkeyPatch.context() as mp:
        mp.setitem(sys.modules, "hushh_mcp.services.consent_db", _fake_db_error())
        mp.setenv("TESTING", "false")

        app = _build_app_for_scope(SCOPE)
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get("/protected", headers={"Authorization": f"Bearer {tok.token}"})

    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Bearer "   " (empty after strip) → 401
# ---------------------------------------------------------------------------


def test_bearer_prefix_with_no_token_returns_401():
    """'Bearer ' with no token value after it must be rejected."""
    app = _build_app_for_scope(SCOPE)
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/protected", headers={"Authorization": "Bearer "})

    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# verify_user_id_match contract
# ---------------------------------------------------------------------------


def test_verify_user_id_match_passes_when_ids_equal():
    """Matching user IDs must not raise."""
    middleware.verify_user_id_match("uid_abc", "uid_abc")


def test_verify_user_id_match_raises_403_on_mismatch():
    """Mismatched user IDs must raise HTTP 403 Forbidden."""
    with pytest.raises(HTTPException) as exc_info:
        middleware.verify_user_id_match("uid_real", "uid_impostor")

    assert exc_info.value.status_code == 403


def test_verify_user_id_match_raises_403_on_empty_vs_non_empty():
    """An empty string must not match any real user ID."""
    with pytest.raises(HTTPException) as exc_info:
        middleware.verify_user_id_match("", "uid_real")

    assert exc_info.value.status_code == 403


# ---------------------------------------------------------------------------
# Dynamic attr.* scope — wildcard grant covers specific leaf
# ---------------------------------------------------------------------------


def test_wildcard_domain_scope_covers_leaf_scope():
    """attr.financial.* token must satisfy a leaf attr.financial.holdings request."""
    wildcard_tok = issue_token(USER_ID, AGENT_ID, "attr.financial.*")

    with pytest.MonkeyPatch.context() as mp:
        mp.setitem(sys.modules, "hushh_mcp.services.consent_db", _fake_db_active(True))
        mp.setenv("TESTING", "false")

        app = _build_app_for_scope("attr.financial.holdings")
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get("/protected", headers={"Authorization": f"Bearer {wildcard_tok.token}"})

    assert resp.status_code == 200


def test_different_domain_wildcard_rejected():
    """attr.food.* must NOT cover attr.financial.holdings — domain isolation."""
    food_tok = issue_token(USER_ID, AGENT_ID, "attr.food.*")

    with pytest.MonkeyPatch.context() as mp:
        mp.setitem(sys.modules, "hushh_mcp.services.consent_db", _fake_db_active(True))
        mp.setenv("TESTING", "false")

        app = _build_app_for_scope("attr.financial.holdings")
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get("/protected", headers={"Authorization": f"Bearer {food_tok.token}"})

    assert resp.status_code == 401
