# tests/test_dbproxy_consent_cwe209_remaining.py
"""
Regression tests for remaining CWE-209 information-exposure fixes in:
  api/routes/db_proxy.py   -- require_vault_owner_consent_header (POST /db/vault/wrapper/delete)
                           -- validate_vault_owner_token (POST /db/vault/status)
  api/routes/consent.py    -- approve_consent (POST /api/consent/pending/approve)
                           -- revoke_consent (POST /api/consent/revoke)
                           -- upload_refreshed_export (POST /api/consent/export-refresh/upload)

In all five locations the original code echoed internal token-validation
reason strings or caller-supplied scope values back in HTTP error responses.
Fixes replace them with static opaque messages while logging the full detail
server-side.

Verification strategy: inject a distinctive sentinel string into the mocked
return value and assert it does NOT appear in the HTTP response body.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.consent as consent_mod
import api.routes.db_proxy as db_proxy_mod
from api.middleware import require_firebase_auth, require_vault_owner_token
from hushh_mcp.services.consent_db import ConsentDBService

_SENTINEL = "LEAKED_INTERNAL_DETAIL_sentinel_xyzzy_99"
_GOOD_USER_ID = "firebase_uid_stub_28chars_abc"


def _db_proxy_app() -> FastAPI:
    app = FastAPI()
    app.include_router(db_proxy_mod.router)
    app.dependency_overrides[require_firebase_auth] = lambda: _GOOD_USER_ID
    return app


def _consent_app() -> FastAPI:
    app = FastAPI()
    app.include_router(consent_mod.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": _GOOD_USER_ID}
    return app


# ---------------------------------------------------------------------------
# db_proxy.py -- require_vault_owner_consent_header (POST /db/vault/wrapper/delete)
# ---------------------------------------------------------------------------


def test_vault_consent_header_invalid_token_does_not_echo_reason():
    """
    An invalid VAULT_OWNER token in the X-Hushh-Consent header must not echo
    the internal validation reason.
    """
    client = TestClient(_db_proxy_app(), raise_server_exceptions=False)

    async def _bad_token(token, scope=None):
        return False, _SENTINEL, None

    with patch.object(db_proxy_mod, "validate_token_with_db", side_effect=_bad_token):
        r = client.post(
            "/db/vault/wrapper/delete",
            json={
                "userId": _GOOD_USER_ID,
                "vaultKeyHash": "hash",
                "method": "passkey",
            },
            headers={"X-Hushh-Consent": "Bearer fake_token_value"},
        )
        assert r.status_code == 401, r.text
        assert _SENTINEL not in r.text, (
            f"CWE-209: internal reason exposed in response: {r.text!r}"
        )


# ---------------------------------------------------------------------------
# db_proxy.py -- validate_vault_owner_token (POST /db/vault/status)
# ---------------------------------------------------------------------------


def test_vault_status_invalid_consent_token_does_not_echo_reason():
    """
    Invalid consent token on POST /db/vault/status must not echo the
    validation reason.
    """
    client = TestClient(_db_proxy_app(), raise_server_exceptions=False)

    async def _bad_token(token, scope=None):
        return False, _SENTINEL, None

    with patch.object(db_proxy_mod, "validate_token_with_db", side_effect=_bad_token):
        r = client.post(
            "/db/vault/status",
            json={"userId": _GOOD_USER_ID, "consentToken": "fake_consent_token_value"},
        )
        assert r.status_code in (401, 403, 500), r.text
        assert _SENTINEL not in r.text, (
            f"CWE-209: internal reason exposed in response: {r.text!r}"
        )


def test_vault_status_invalid_token_returns_opaque_message():
    """The error detail for an invalid vault-owner token must be a static string."""
    client = TestClient(_db_proxy_app(), raise_server_exceptions=False)

    async def _bad_token(token, scope=None):
        return False, "Token expired", None

    with patch.object(db_proxy_mod, "validate_token_with_db", side_effect=_bad_token):
        r = client.post(
            "/db/vault/status",
            json={"userId": _GOOD_USER_ID, "consentToken": "bad_token"},
        )
        assert r.status_code in (401, 403, 500), r.text
        assert "Token expired" not in r.text, r.text


# ---------------------------------------------------------------------------
# consent.py -- scope_resolution_failed (approve_consent)
# ---------------------------------------------------------------------------


def test_approve_consent_scope_error_does_not_echo_scope():
    """
    When scope resolution fails in approve_consent, the scope string must
    not appear in the error response.
    """
    sentinel_scope = f"SENTINEL_SCOPE_{_SENTINEL}"
    client = TestClient(_consent_app(), raise_server_exceptions=False)

    def _bad_resolve(scope_str):
        raise ValueError(f"cannot resolve {scope_str}")

    with patch.object(
        ConsentDBService,
        "get_pending_by_request_id",
        new=AsyncMock(
            return_value={
                "scope": sentinel_scope,
                "user_id": _GOOD_USER_ID,
                "developer": "dev_app",
                "status": "pending",
                "metadata": {},
            }
        ),
    ):
        with patch.object(consent_mod, "resolve_scope_to_enum", side_effect=_bad_resolve):
            r = client.post(
                "/api/consent/pending/approve",
                json={"requestId": "req_12345", "userId": _GOOD_USER_ID},
            )
            assert r.status_code in (400, 401, 403, 422, 500), r.text
            assert sentinel_scope not in r.text, (
                f"CWE-209: scope echoed in error: {r.text!r}"
            )


# ---------------------------------------------------------------------------
# consent.py -- no active consent for scope (revoke_consent)
# ---------------------------------------------------------------------------


def test_revoke_not_found_does_not_echo_scope():
    """
    When no active consent exists for the requested scope, the scope value
    must not appear verbatim in the response body.
    """
    sentinel_scope = f"SENTINEL_scope_{_SENTINEL}"
    client = TestClient(_consent_app(), raise_server_exceptions=False)

    with patch.object(ConsentDBService, "get_active_tokens", new=AsyncMock(return_value=[])):
        with patch.object(
            ConsentDBService, "get_active_internal_tokens", new=AsyncMock(return_value=[])
        ):
            r = client.post(
                "/api/consent/revoke",
                json={"userId": _GOOD_USER_ID, "scope": sentinel_scope},
            )
            assert r.status_code in (400, 401, 403, 404, 422, 500), r.text
            assert sentinel_scope not in r.text, (
                f"CWE-209: scope echoed in error: {r.text!r}"
            )


# ---------------------------------------------------------------------------
# consent.py -- export refresh invalid token (upload_refreshed_export)
# ---------------------------------------------------------------------------


def test_export_refresh_upload_invalid_token_does_not_echo_reason():
    """
    Invalid consent token during export-refresh upload must not expose the
    validation reason.
    """
    client = TestClient(_consent_app(), raise_server_exceptions=False)

    async def _bad_token(token, expected_scope=None, **kwargs):
        return False, _SENTINEL, None

    with patch.object(consent_mod, "validate_token_with_db", side_effect=_bad_token):
        r = client.post(
            "/api/consent/export-refresh/upload",
            json={
                "userId": _GOOD_USER_ID,
                "consentToken": "fake_consent_token_value",
                "encryptedData": "data",
                "encryptedIv": "iv",
                "encryptedTag": "tag",
                "wrappedExportKey": "wrapped_key",
                "wrappedKeyIv": "wrapped_iv",
                "wrappedKeyTag": "wrapped_tag",
                "senderPublicKey": "sender_pub_key",
            },
        )
        assert r.status_code in (401, 403, 422, 500), r.text
        assert _SENTINEL not in r.text, (
            f"CWE-209: internal reason exposed in response: {r.text!r}"
        )
