# tests/test_stream_consent_token_reason_leak.py
"""
Trust-boundary proof for CWE-209 / CWE-203 fixes in
api.routes.kai.stream and api.routes.consent.

Canonical attach points
-----------------------
api.routes.kai.stream._require_vault_owner_token
  -> validate_token_with_db(token, ConsentScope.VAULT_OWNER)
  -> raises HTTPException(401, "Token validation failed.") on failure
  -> called by all stream route handlers before any streaming begins

api.routes.consent.upload_refreshed_export       (POST /consent/export-refresh)
  -> validate_token_with_db(request.consentToken)
  -> raises HTTPException(401, "Token validation failed.") on failure

Before the fix:
- stream.py line 90:   detail=f"Invalid token: {reason}"
- consent.py line 1327: detail=f"Invalid consent token for export refresh: {reason or 'unknown'}"

Reason strings like "Scope mismatch: token has 'pkm.read', but 'vault.owner'
required" confirm which scope the caller's token holds and whether it is live
(CWE-203 information oracle).

After the fix both return the static "Token validation failed." message.
The internal reason is written to the server log at WARNING level.

Tests prove:
1. _require_vault_owner_token suppresses the reason from HTTP detail.
2. upload_refreshed_export suppresses the reason from HTTP detail.
3. A valid VAULT_OWNER token for the correct user succeeds (non-regression).
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes import consent as consent_module
from api.routes.kai import stream as stream_module

_POISON_REASON = (
    "Scope mismatch: token has 'pkm.read', but 'vault.owner' required. "
    "secret_key=abc123"  # noqa: S105
)


# ---------------------------------------------------------------------------
# Canonical attach-point proof:
# api.routes.kai.stream._require_vault_owner_token
# ---------------------------------------------------------------------------


class TestStreamRequireVaultOwnerTokenInfoDisclosure:
    """
    api.routes.kai.stream._require_vault_owner_token is the canonical
    token guard called by every stream route before streaming begins.

    Proves that validate_token_with_db failure reasons are suppressed
    before they reach the HTTP response.
    """

    @pytest.mark.asyncio
    async def test_invalid_token_detail_is_generic(self, monkeypatch):
        """validate_token_with_db failure reason must not reach the HTTP response."""

        async def _fail(token, scope):
            return (False, _POISON_REASON, None)

        monkeypatch.setattr(stream_module, "validate_token_with_db", _fail)

        with pytest.raises(HTTPException) as exc:
            await stream_module._require_vault_owner_token(
                user_id="user_123",
                authorization="Bearer some-token",
            )

        assert exc.value.status_code == 401
        assert exc.value.detail == "Token validation failed."
        assert "pkm.read" not in exc.value.detail
        assert "vault.owner" not in exc.value.detail
        assert "secret_key" not in exc.value.detail

    @pytest.mark.asyncio
    async def test_none_payload_detail_is_generic(self, monkeypatch):
        """valid=True but None payload must also return generic 401."""

        async def _none_payload(token, scope):
            return (True, None, None)

        monkeypatch.setattr(stream_module, "validate_token_with_db", _none_payload)

        with pytest.raises(HTTPException) as exc:
            await stream_module._require_vault_owner_token(
                user_id="user_123",
                authorization="Bearer some-token",
            )

        assert exc.value.status_code == 401
        assert exc.value.detail == "Token validation failed."

    @pytest.mark.asyncio
    async def test_valid_token_correct_user_succeeds(self, monkeypatch):
        """A valid VAULT_OWNER token for the correct user must succeed."""

        async def _ok(token, scope):
            return (True, None, SimpleNamespace(user_id="user_123"))

        monkeypatch.setattr(stream_module, "validate_token_with_db", _ok)

        result = await stream_module._require_vault_owner_token(
            user_id="user_123",
            authorization="Bearer valid-token",
        )
        assert result == "valid-token"


# ---------------------------------------------------------------------------
# Canonical attach-point proof:
# api.routes.consent.upload_refreshed_export (POST /consent/export-refresh)
# ---------------------------------------------------------------------------


class TestUploadRefreshedExportInfoDisclosure:
    """
    api.routes.consent.upload_refreshed_export is the canonical owner of
    the token validation guard for the export-refresh endpoint.

    Proves that validate_token_with_db failure reasons are suppressed
    before they reach the HTTP response.
    """

    @pytest.mark.asyncio
    async def test_invalid_token_detail_is_generic(self, monkeypatch):
        """
        Token validation reason must not appear in the export-refresh 401
        response.

        The guard raises HTTPException(401, "Token validation failed.") when
        validate_token_with_db returns (False, reason, None).
        """
        from api.routes import consent as consent_module

        async def _fail(token):
            return (False, _POISON_REASON, None)

        monkeypatch.setattr(consent_module, "validate_token_with_db", _fail)

        request = SimpleNamespace(userId="user_123", consentToken="bad-token")
        token_data = {"user_id": "user_123"}

        with pytest.raises(HTTPException) as exc:
            await consent_module.upload_refreshed_export(
                request=request,  # type: ignore[arg-type]
                token_data=token_data,
            )

        assert exc.value.status_code == 401
        assert exc.value.detail == "Token validation failed."
        assert "pkm.read" not in exc.value.detail
        assert "Scope mismatch" not in exc.value.detail
        assert "secret_key" not in exc.value.detail


# ---------------------------------------------------------------------------
# HTTP route-level proof (TestClient)
#
# These tests exercise the guards through the full FastAPI HTTP stack and
# confirm that the opaque detail string reaches the caller's JSON body.
# ---------------------------------------------------------------------------


def _stream_client() -> TestClient:
    """Minimal app including the kai stream router for HTTP-level testing."""
    app = FastAPI()
    app.include_router(stream_module.router)
    return TestClient(app, raise_server_exceptions=False)


def _consent_client() -> tuple[FastAPI, TestClient]:
    """App including the consent router with vault-owner dep stubbed out."""
    from api.routes.consent import router as consent_router

    app = FastAPI()
    app.include_router(consent_router)
    return app, TestClient(app, raise_server_exceptions=False)


class TestStreamRouteHTTPResponse:
    """
    Route-level proof: api.routes.kai.stream.analyze_run_active
    (GET /analyze/run/active) returns opaque 401 over the wire when
    _require_vault_owner_token rejects the token.

    Canonical attach point: api.routes.kai.stream._require_vault_owner_token
    """

    def test_http_detail_is_static_string(self, monkeypatch):
        """Response body must contain only the fixed opaque detail."""

        async def _fail(token, scope):
            return (False, _POISON_REASON, None)

        monkeypatch.setattr(stream_module, "validate_token_with_db", _fail)

        client = _stream_client()
        resp = client.get(
            "/analyze/run/active",
            params={"user_id": "u1", "debate_session_id": "s1"},
            headers={"Authorization": "Bearer bad-token"},
        )

        assert resp.status_code == 401
        assert resp.json()["detail"] == "Token validation failed."

    def test_http_detail_does_not_contain_reason(self, monkeypatch):
        """Internal reason string must not appear anywhere in the HTTP body."""

        async def _fail(token, scope):
            return (False, _POISON_REASON, None)

        monkeypatch.setattr(stream_module, "validate_token_with_db", _fail)

        client = _stream_client()
        resp = client.get(
            "/analyze/run/active",
            params={"user_id": "u1", "debate_session_id": "s1"},
            headers={"Authorization": "Bearer bad-token"},
        )

        assert _POISON_REASON not in resp.text
        assert "pkm.read" not in resp.text


class TestExportRefreshRouteHTTPResponse:
    """
    Route-level proof: api.routes.consent.upload_refreshed_export
    (POST /api/consent/export-refresh/upload) returns opaque 401 over
    the wire when validate_token_with_db rejects the consent token.

    Canonical attach point: api.routes.consent.upload_refreshed_export
    """

    def test_http_detail_is_static_string(self, monkeypatch):
        """Response body must contain only the fixed opaque detail."""

        async def _fail(token):
            return (False, _POISON_REASON, None)

        monkeypatch.setattr(consent_module, "validate_token_with_db", _fail)

        app, client = _consent_client()
        app.dependency_overrides[require_vault_owner_token] = lambda: {
            "user_id": "user_123",
            "token": "fake-vault-token",
            "scope": "vault.owner",
        }

        resp = client.post(
            "/api/consent/export-refresh/upload",
            json={
                "userId": "user_123",
                "consentToken": "bad-consent-token",
                "encryptedData": "abc",
                "encryptedIv": "iv",
                "encryptedTag": "tag",
                "wrappedExportKey": "key",
                "wrappedKeyIv": "kiv",
                "wrappedKeyTag": "ktag",
                "senderPublicKey": "pub",
            },
            headers={"Authorization": "Bearer fake-vault-token"},
        )

        assert resp.status_code == 401
        assert resp.json()["detail"] == "Token validation failed."

    def test_http_detail_does_not_contain_reason(self, monkeypatch):
        """Internal reason must not appear in the HTTP response body."""

        async def _fail(token):
            return (False, _POISON_REASON, None)

        monkeypatch.setattr(consent_module, "validate_token_with_db", _fail)

        app, client = _consent_client()
        app.dependency_overrides[require_vault_owner_token] = lambda: {
            "user_id": "user_123",
            "token": "fake-vault-token",
            "scope": "vault.owner",
        }

        resp = client.post(
            "/api/consent/export-refresh/upload",
            json={
                "userId": "user_123",
                "consentToken": "bad-consent-token",
                "encryptedData": "abc",
                "encryptedIv": "iv",
                "encryptedTag": "tag",
                "wrappedExportKey": "key",
                "wrappedKeyIv": "kiv",
                "wrappedKeyTag": "ktag",
                "senderPublicKey": "pub",
            },
            headers={"Authorization": "Bearer fake-vault-token"},
        )

        assert _POISON_REASON not in resp.text
        assert "pkm.read" not in resp.text
