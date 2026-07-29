# tests/test_dbproxy_consent_cwe209_remaining.py
"""
Regression tests for remaining CWE-209 information-exposure fixes in:
  api/routes/db_proxy.py   -- require_vault_owner_consent_header
                              (POST /db/vault/wrapper/delete)
                           -- validate_vault_owner_token
                              (POST /db/vault/status)
  api/routes/consent.py    -- approve_consent (POST /api/consent/pending/approve)
                           -- revoke_consent_by_scope (POST /api/consent/revoke)
                           -- upload_refreshed_export
                              (POST /api/consent/export-refresh/upload)

In all five locations the original code echoed internal token-validation
reason strings or caller-supplied scope values back in HTTP error responses.
Fixes replace them with static opaque messages while logging the full detail
server-side.

Each route is exercised by mounting only its router on a minimal FastAPI
app, never the full server.app, since the MCP session manager backing the
real app's lifespan can only be started once per process.

Verification strategy: inject a distinctive sentinel string into the mocked
return value and assert it does NOT appear in the HTTP response body.
"""

from __future__ import annotations

from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

_SENTINEL = "LEAKED_INTERNAL_DETAIL_sentinel_xyzzy_99"
_GOOD_USER_ID = "firebase_uid_stub_28chars_abc"


def _db_proxy_client() -> TestClient:
    """Mount only db_proxy.router so the MCP session-manager lifespan
    (which can only start once per process) is never touched."""
    import api.routes.db_proxy as db_proxy_mod
    from api.middleware import require_firebase_auth

    app = FastAPI()
    app.include_router(db_proxy_mod.router)
    app.dependency_overrides[require_firebase_auth] = lambda: _GOOD_USER_ID
    return TestClient(app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# db_proxy.py — require_vault_owner_consent_header
# ---------------------------------------------------------------------------

def test_vault_consent_header_invalid_token_does_not_echo_reason():
    """
    An invalid VAULT_OWNER token must not echo the internal validation reason.
    """
    import api.routes.db_proxy as db_proxy_mod

    async def _bad_token(token, scope=None):
        return False, _SENTINEL, None

    with patch.object(db_proxy_mod, "validate_token_with_db", side_effect=_bad_token):
        client = _db_proxy_client()
        r = client.post(
            "/db/vault/wrapper/delete",
            headers={"X-Hushh-Consent": "Bearer fake_token_value"},
            json={
                "userId": _GOOD_USER_ID,
                "vaultKeyHash": "stub_hash",
                "method": "passphrase",
            },
        )
        assert r.status_code == 401, r.text
        assert _SENTINEL not in r.text, (
            f"CWE-209: internal reason exposed in response: {r.text!r}"
        )


# ---------------------------------------------------------------------------
# db_proxy.py — validate_vault_owner_token (inside /db/vault/status)
# ---------------------------------------------------------------------------

def test_vault_route_invalid_consent_token_does_not_echo_reason():
    """
    Invalid consent token on the vault status route must not echo the
    validation reason.
    """
    import api.routes.db_proxy as db_proxy_mod

    async def _bad_token(token, scope=None):
        return False, _SENTINEL, None

    with patch.object(db_proxy_mod, "validate_token_with_db", side_effect=_bad_token):
        client = _db_proxy_client()
        r = client.post(
            "/db/vault/status",
            json={"userId": _GOOD_USER_ID, "consentToken": "fake_token_value"},
        )
        assert r.status_code == 401, r.text
        assert _SENTINEL not in r.text, (
            f"CWE-209: internal reason exposed in response: {r.text!r}"
        )


# ---------------------------------------------------------------------------
# consent.py — scope_resolution_failed (approve_consent line 450)
# ---------------------------------------------------------------------------

def test_approve_consent_scope_error_does_not_echo_scope():
    """
    When scope resolution fails in approve_consent, the scope string must
    not appear in the error response.
    """
    from unittest.mock import AsyncMock

    from fastapi import FastAPI

    sentinel_scope = f"SENTINEL_SCOPE_{_SENTINEL}"

    import api.routes.consent as consent_mod
    from api.middleware import require_vault_owner_token
    from hushh_mcp.services.consent_db import ConsentDBService

    app = FastAPI()
    app.include_router(consent_mod.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": _GOOD_USER_ID}

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
            client = TestClient(app, raise_server_exceptions=False)
            r = client.post(
                "/api/consent/pending/approve",
                json={
                    "requestId": "req_12345",
                    "userId": _GOOD_USER_ID,
                },
            )
            assert r.status_code in (400, 401, 403, 422, 500), r.text
            assert sentinel_scope not in r.text, (
                f"CWE-209: scope echoed in error: {r.text!r}"
            )


# ---------------------------------------------------------------------------
# consent.py — No active consent for scope (revoke_consent_by_scope line 1101)
# ---------------------------------------------------------------------------

def test_revoke_by_scope_not_found_does_not_echo_scope():
    """
    When no active consent exists for the requested scope, the scope value
    must not appear verbatim in the 404 response body.
    """
    from unittest.mock import AsyncMock

    from fastapi import FastAPI

    sentinel_scope = f"SENTINEL_scope_{_SENTINEL}"

    import api.routes.consent as consent_mod
    from api.middleware import require_vault_owner_token
    from hushh_mcp.services.consent_db import ConsentDBService

    app = FastAPI()
    app.include_router(consent_mod.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": _GOOD_USER_ID}

    with patch.object(ConsentDBService, "get_active_tokens", new=AsyncMock(return_value=[])):
        with patch.object(
            ConsentDBService, "get_active_internal_tokens", new=AsyncMock(return_value=[])
        ):
            client = TestClient(app, raise_server_exceptions=False)
            r = client.post(
                "/api/consent/revoke",
                json={"userId": _GOOD_USER_ID, "scope": sentinel_scope},
            )
            assert r.status_code in (400, 401, 403, 404, 422, 500), r.text
            assert sentinel_scope not in r.text, (
                f"CWE-209: scope echoed in error: {r.text!r}"
            )


# ---------------------------------------------------------------------------
# consent.py — export refresh invalid token (line 1327)
# ---------------------------------------------------------------------------

def test_export_refresh_invalid_token_does_not_echo_reason():
    """
    Invalid consent token during export refresh must not expose the validation reason.
    """
    import api.routes.consent as consent_mod
    from api.middleware import require_vault_owner_token

    async def _bad_token(token, scope=None):
        return False, _SENTINEL, None

    app = FastAPI()
    app.include_router(consent_mod.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": _GOOD_USER_ID}

    with patch.object(consent_mod, "validate_token_with_db", side_effect=_bad_token):
        client = TestClient(app, raise_server_exceptions=False)
        r = client.post(
            "/api/consent/export-refresh/upload",
            json={
                "userId": _GOOD_USER_ID,
                "consentToken": "fake_consent_token_value",
                "encryptedData": "stub_data",
                "encryptedIv": "stub_iv",
                "encryptedTag": "stub_tag",
                "wrappedExportKey": "stub_wrapped_key",
                "wrappedKeyIv": "stub_key_iv",
                "wrappedKeyTag": "stub_key_tag",
                "senderPublicKey": "stub_public_key",
            },
        )
        assert r.status_code == 401, r.text
        assert _SENTINEL not in r.text, (
            f"CWE-209: internal reason exposed in response: {r.text!r}"
        )


# ---------------------------------------------------------------------------
# Verify opaque messages are present in known error responses
# ---------------------------------------------------------------------------

def test_vault_invalid_token_returns_opaque_message():
    """The 401 detail for invalid vault token must be an opaque static string."""
    import api.routes.db_proxy as db_proxy_mod

    async def _bad_token(token, scope=None):
        return False, "Token expired", None

    with patch.object(db_proxy_mod, "validate_token_with_db", side_effect=_bad_token):
        client = _db_proxy_client()
        r = client.post(
            "/db/vault/wrapper/delete",
            headers={"X-Hushh-Consent": "Bearer bad_token"},
            json={
                "userId": _GOOD_USER_ID,
                "vaultKeyHash": "stub_hash",
                "method": "passphrase",
            },
        )
        assert r.status_code == 401, r.text
        # The specific internal reason must not appear
        assert "Token expired" not in r.text, r.text
