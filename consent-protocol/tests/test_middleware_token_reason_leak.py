# tests/test_middleware_token_reason_leak.py
"""
Trust-boundary proof for CWE-209 fixes in api.middleware.

Canonical attach points
-----------------------
api.middleware.require_vault_owner_token
  -> validate_token_with_db(token, ConsentScope.VAULT_OWNER)
  -> raises HTTPException(401, "Token validation failed.") on any failure

api.middleware.require_consent_scope(scope)
  -> validate_token_with_db(token, scope)
  -> raises HTTPException(401, "Token validation failed.") on any failure

Both are FastAPI dependencies used by every protected route in the service.
Before the fix both raised:
  raise _auth_error(f"Invalid token: {reason}")
forwarding the raw validate_token_with_db reason string verbatim.

Reasons such as "Scope mismatch: token has 'pkm.read', but 'vault.owner'
required" confirm which scope a caller's token holds and whether it is live,
enabling oracle attacks (CWE-203 / CWE-209).

After the fix both raise:
  raise _auth_error("Token validation failed.")
The internal reason is written to the server log only.

Tests prove:
1. The reason string never appears in the HTTP detail.
2. The detail is the exact static string "Token validation failed."
3. All distinct failure reasons produce identical HTTP detail (no oracle).
"""

from __future__ import annotations

import pytest
from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient

import api.middleware as middleware

_POISON = "scope mismatch: token has 'pkm.read', but 'vault.owner' required"


def _make_validate(reason: str):
    """Return an async validate stub that always fails with *reason*."""

    async def _validate(token: str, scope):
        return False, reason, None

    return _validate


# ---------------------------------------------------------------------------
# Canonical attach-point proof:
# api.middleware.require_vault_owner_token
# ---------------------------------------------------------------------------


class TestRequireVaultOwnerTokenReasonSuppression:
    """
    api.middleware.require_vault_owner_token is the canonical dependency
    for every route that requires VAULT_OWNER scope.

    Proves that validate_token_with_db failure reasons are suppressed
    before they reach the HTTP response.
    """

    @pytest.mark.asyncio
    async def test_reason_not_in_detail(self, monkeypatch):
        """Validation failure reason must not appear in the HTTP detail."""
        monkeypatch.setattr(middleware, "validate_token_with_db", _make_validate(_POISON))

        with pytest.raises(HTTPException) as exc_info:
            await middleware.require_vault_owner_token(
                authorization="Bearer fake.jwt.token", hushh_consent=None
            )

        assert exc_info.value.status_code == 401
        assert _POISON not in exc_info.value.detail

    @pytest.mark.asyncio
    async def test_detail_is_static_generic_message(self, monkeypatch):
        """Detail must be the fixed opaque string, not any dynamic content."""
        monkeypatch.setattr(middleware, "validate_token_with_db", _make_validate(_POISON))

        with pytest.raises(HTTPException) as exc_info:
            await middleware.require_vault_owner_token(
                authorization="Bearer fake.jwt.token", hushh_consent=None
            )

        assert exc_info.value.detail == "Token validation failed."

    @pytest.mark.asyncio
    async def test_db_dsn_not_in_detail(self, monkeypatch):
        """Database DSN must not leak through validation error reason."""
        db_dsn = "postgresql://admin:hunter2@db.internal:5432/hushh"
        monkeypatch.setattr(middleware, "validate_token_with_db", _make_validate(db_dsn))

        with pytest.raises(HTTPException) as exc_info:
            await middleware.require_vault_owner_token(
                authorization="Bearer fake.jwt.token", hushh_consent=None
            )

        assert db_dsn not in exc_info.value.detail
        assert "postgresql" not in exc_info.value.detail

    @pytest.mark.asyncio
    async def test_distinct_reasons_produce_identical_detail(self, monkeypatch):
        """All failure reasons must produce identical HTTP detail (no oracle)."""
        reasons = [
            "Token expired",
            "Token revoked",
            _POISON,
            "postgresql://admin:s3cr3t@host/db",
        ]
        details = set()

        for reason in reasons:
            monkeypatch.setattr(middleware, "validate_token_with_db", _make_validate(reason))
            with pytest.raises(HTTPException) as exc_info:
                await middleware.require_vault_owner_token(
                    authorization="Bearer fake.jwt.token", hushh_consent=None
                )
            details.add(exc_info.value.detail)

        assert len(details) == 1, f"Multiple distinct detail values leaked: {details}"


# ---------------------------------------------------------------------------
# Canonical attach-point proof:
# api.middleware.require_consent_scope(scope)
# ---------------------------------------------------------------------------


class TestRequireConsentScopeReasonSuppression:
    """
    api.middleware.require_consent_scope is the canonical dependency for
    routes that require a specific (non-VAULT_OWNER) consent scope.

    Proves that validate_token_with_db failure reasons are suppressed
    before they reach the HTTP response.
    """

    @pytest.mark.asyncio
    async def test_reason_not_in_detail(self, monkeypatch):
        """require_consent_scope must not surface reason strings in HTTP detail."""
        monkeypatch.setattr(middleware, "validate_token_with_db", _make_validate(_POISON))

        dep = middleware.require_consent_scope("pkm.read")
        with pytest.raises(HTTPException) as exc_info:
            await dep(authorization="Bearer fake.jwt.token")

        assert exc_info.value.status_code == 401
        assert _POISON not in exc_info.value.detail

    @pytest.mark.asyncio
    async def test_detail_is_static_generic_message(self, monkeypatch):
        """require_consent_scope detail must be the fixed opaque string."""
        monkeypatch.setattr(middleware, "validate_token_with_db", _make_validate(_POISON))

        dep = middleware.require_consent_scope("pkm.read")
        with pytest.raises(HTTPException) as exc_info:
            await dep(authorization="Bearer fake.jwt.token")

        assert exc_info.value.detail == "Token validation failed."


# ---------------------------------------------------------------------------
# HTTP route-level proof (TestClient)
#
# These tests exercise the dependencies through the full FastAPI HTTP stack
# and confirm that the opaque detail string reaches the caller's JSON body.
# This is the canonical route-owner proof requested by the trust-boundary
# review: an actual HTTP 401 with a static body, not just a raised exception.
# ---------------------------------------------------------------------------


def _build_vault_app() -> FastAPI:
    """Minimal app with one sentinel route protected by require_vault_owner_token."""
    app = FastAPI()

    @app.get("/protected")
    async def _sentinel(_: dict = Depends(middleware.require_vault_owner_token)):
        return {"ok": True}

    return app


def _build_scoped_app(scope: str = "pkm.read") -> FastAPI:
    """Minimal app with one sentinel route protected by require_consent_scope."""
    app = FastAPI()

    @app.get("/protected")
    async def _sentinel(_: dict = Depends(middleware.require_consent_scope(scope))):
        return {"ok": True}

    return app


class TestRequireVaultOwnerTokenHTTPResponse:
    """
    Route-level proof: require_vault_owner_token produces an opaque 401 body
    over the wire. Uses TestClient so the full FastAPI exception-handler
    pipeline is exercised, not just the dependency coroutine.

    Canonical attach point: api.middleware.require_vault_owner_token
    """

    def test_http_detail_is_static_string(self, monkeypatch):
        """The JSON response body must contain only the fixed opaque detail."""
        monkeypatch.setattr(middleware, "validate_token_with_db", _make_validate(_POISON))

        client = TestClient(_build_vault_app(), raise_server_exceptions=False)
        resp = client.get("/protected", headers={"Authorization": "Bearer fake.token"})

        assert resp.status_code == 401
        assert resp.json()["detail"] == "Token validation failed."

    def test_http_detail_does_not_contain_reason(self, monkeypatch):
        """The HTTP response body must not contain the internal failure reason."""
        monkeypatch.setattr(middleware, "validate_token_with_db", _make_validate(_POISON))

        client = TestClient(_build_vault_app(), raise_server_exceptions=False)
        resp = client.get("/protected", headers={"Authorization": "Bearer fake.token"})

        assert _POISON not in resp.text

    def test_distinct_reasons_produce_identical_http_body(self, monkeypatch):
        """Four different failure reasons must all produce the same HTTP detail."""
        reasons = [
            "Token expired",
            "Token revoked",
            _POISON,
            "postgresql://admin:s3cr3t@host/db",
        ]
        details = set()
        client = TestClient(_build_vault_app(), raise_server_exceptions=False)

        for reason in reasons:
            monkeypatch.setattr(middleware, "validate_token_with_db", _make_validate(reason))
            resp = client.get("/protected", headers={"Authorization": "Bearer fake.token"})
            assert resp.status_code == 401
            details.add(resp.json()["detail"])

        assert len(details) == 1, f"Multiple detail values leaked over HTTP: {details}"


class TestRequireConsentScopeHTTPResponse:
    """
    Route-level proof: require_consent_scope produces an opaque 401 body
    over the wire.

    Canonical attach point: api.middleware.require_consent_scope(scope)
    """

    def test_http_detail_is_static_string(self, monkeypatch):
        """The JSON response body must contain only the fixed opaque detail."""
        monkeypatch.setattr(middleware, "validate_token_with_db", _make_validate(_POISON))

        client = TestClient(_build_scoped_app("pkm.read"), raise_server_exceptions=False)
        resp = client.get("/protected", headers={"Authorization": "Bearer fake.token"})

        assert resp.status_code == 401
        assert resp.json()["detail"] == "Token validation failed."

    def test_http_detail_does_not_contain_reason(self, monkeypatch):
        """The HTTP response body must not contain the internal failure reason."""
        monkeypatch.setattr(middleware, "validate_token_with_db", _make_validate(_POISON))

        client = TestClient(_build_scoped_app("pkm.read"), raise_server_exceptions=False)
        resp = client.get("/protected", headers={"Authorization": "Bearer fake.token"})

        assert _POISON not in resp.text
