"""
Regression tests: vault/wrapper/upsert, vault/wrapper/delete, and vault/primary/set
must not echo raw ValueError message strings in HTTP 400 responses (CWE-209).

CWE-209 - Information Exposure Through Error Messages.

Three vault routes in api/routes/db_proxy.py had the same pattern:

    except ValueError as e:
        message = str(e)
        raise HTTPException(status_code=400, detail={"error": message, ...})

The VaultKeysService raises ValueError for business-rule violations (key hash
mismatch, missing wrapper, passkey metadata errors). The raw message can contain
internal identifiers, schema column names, or caller-supplied inputs that give an
attacker information about the vault's internal state.

Fix: replace "error": message with typed opaque static strings keyed by the
existing error-code classification. The full ValueError message is logged at
WARNING level server-side (with masked user_id) for operator diagnostics.

Note: vault/setup was patched in a separate PR. This PR handles the other three
mutating vault routes that were not covered there.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

SENTINEL = "XK9_VAULT_WRAPPER_VALUEERROR_SENTINEL_XK9"

_FAKE_FIREBASE_UID = "test-firebase-uid-cwe209"
_FAKE_TOKEN_DATA = {"user_id": _FAKE_FIREBASE_UID, "token_type": "VAULT_OWNER"}

_WRAPPER_UPSERT_BODY = {
    "userId": _FAKE_FIREBASE_UID,
    "vaultKeyHash": "abc123",
    "method": "passkey",
    "wrapperId": "wrapper-1",
    "encryptedVaultKey": "encrypted",
    "salt": "salt",
    "iv": "iv",
}

_WRAPPER_DELETE_BODY = {
    "userId": _FAKE_FIREBASE_UID,
    "vaultKeyHash": "abc123",
    "method": "passkey",
    "wrapperId": "wrapper-1",
}

_PRIMARY_SET_BODY = {
    "userId": _FAKE_FIREBASE_UID,
    "primaryMethod": "passkey",
    "primaryWrapperId": "wrapper-1",
}


@pytest.fixture()
def client():
    from fastapi import FastAPI

    from api.middleware import require_firebase_auth
    from api.routes import db_proxy as db_proxy_mod

    app = FastAPI()
    app.include_router(db_proxy_mod.router)
    app.dependency_overrides[require_firebase_auth] = lambda: _FAKE_FIREBASE_UID
    app.dependency_overrides[db_proxy_mod.require_vault_owner_consent_header] = (
        lambda: _FAKE_TOKEN_DATA
    )
    # Disable the client-version gate so tests reach the business-logic layer.
    with patch.object(db_proxy_mod, "ENFORCE_VAULT_WRITE_CLIENT_VERSION", ""):
        yield TestClient(app, raise_server_exceptions=False)


def _patch_auth(uid: str = _FAKE_FIREBASE_UID):
    return patch(
        "api.routes.db_proxy.require_firebase_auth",
        return_value=uid,
    )


def _patch_vault_owner_auth(uid: str = _FAKE_FIREBASE_UID):
    return patch(
        "api.routes.db_proxy.require_vault_owner_consent_header",
        return_value=_FAKE_TOKEN_DATA,
    )


# ---------------------------------------------------------------------------
# vault/wrapper/upsert
# ---------------------------------------------------------------------------


def test_wrapper_upsert_passkey_mismatch_does_not_echo_sentinel(client):
    """VAULT_PASSKEY_RP_MISMATCH 400 must not contain the raw ValueError message."""
    error_msg = f"requires passkey credential metadata including rp id: {SENTINEL}"

    with (
        _patch_auth(),
        patch(
            "api.routes.db_proxy.VaultKeysService",
        ) as MockService,
    ):
        instance = MockService.return_value
        instance.upsert_wrapper = AsyncMock(side_effect=ValueError(error_msg))
        response = client.post(
            "/db/vault/wrapper/upsert",
            json=_WRAPPER_UPSERT_BODY,
            headers={"Authorization": "Bearer fake-token"},
        )

    assert response.status_code == 400
    body = response.text
    assert SENTINEL not in body, f"Sentinel leaked in wrapper/upsert response: {body}"


def test_wrapper_upsert_generic_error_does_not_echo_sentinel(client):
    """Generic VAULT_VALIDATION_ERROR 400 must not contain raw ValueError text."""
    error_msg = f"internal schema detail: {SENTINEL}"

    with (
        _patch_auth(),
        patch("api.routes.db_proxy.VaultKeysService") as MockService,
    ):
        instance = MockService.return_value
        instance.upsert_wrapper = AsyncMock(side_effect=ValueError(error_msg))
        response = client.post(
            "/db/vault/wrapper/upsert",
            json=_WRAPPER_UPSERT_BODY,
            headers={"Authorization": "Bearer fake-token"},
        )

    assert response.status_code == 400
    body = response.text
    assert SENTINEL not in body


def test_wrapper_upsert_error_response_uses_static_message(client):
    """Opaque static message must be present in the error response."""
    with (
        _patch_auth(),
        patch("api.routes.db_proxy.VaultKeysService") as MockService,
    ):
        instance = MockService.return_value
        instance.upsert_wrapper = AsyncMock(
            side_effect=ValueError("wrapper rp id is not allowed for this environment")
        )
        response = client.post(
            "/db/vault/wrapper/upsert",
            json=_WRAPPER_UPSERT_BODY,
            headers={"Authorization": "Bearer fake-token"},
        )

    assert response.status_code == 400
    data = response.json()
    detail = data.get("detail", {})
    assert SENTINEL not in str(detail)
    assert detail.get("code") == "VAULT_PASSKEY_RP_MISMATCH"
    assert "internal" not in detail.get("error", "").lower()


# ---------------------------------------------------------------------------
# vault/wrapper/delete
# ---------------------------------------------------------------------------


def test_wrapper_delete_hash_mismatch_does_not_echo_sentinel(client):
    """VAULT_KEY_HASH_MISMATCH 400 must not contain the raw ValueError text."""
    error_msg = f"vaultKeyHash mismatch: expected=abc {SENTINEL}"

    with (
        _patch_auth(),
        _patch_vault_owner_auth(),
        patch("api.routes.db_proxy.VaultKeysService") as MockService,
    ):
        instance = MockService.return_value
        instance.delete_wrapper = AsyncMock(side_effect=ValueError(error_msg))
        response = client.post(
            "/db/vault/wrapper/delete",
            json=_WRAPPER_DELETE_BODY,
            headers={
                "Authorization": "Bearer fake-token",
                "X-Hushh-Consent": "fake-consent-token",
            },
        )

    assert response.status_code == 400
    body = response.text
    assert SENTINEL not in body


def test_wrapper_delete_wrapper_not_found_does_not_echo_sentinel(client):
    """VAULT_WRAPPER_NOT_FOUND 400 must use opaque message."""
    error_msg = f"Vault wrapper not found: id={SENTINEL}"

    with (
        _patch_auth(),
        _patch_vault_owner_auth(),
        patch("api.routes.db_proxy.VaultKeysService") as MockService,
    ):
        instance = MockService.return_value
        instance.delete_wrapper = AsyncMock(side_effect=ValueError(error_msg))
        response = client.post(
            "/db/vault/wrapper/delete",
            json=_WRAPPER_DELETE_BODY,
            headers={
                "Authorization": "Bearer fake-token",
                "X-Hushh-Consent": "fake-consent-token",
            },
        )

    assert response.status_code == 400
    body = response.text
    assert SENTINEL not in body
    data = response.json()
    assert data.get("detail", {}).get("code") == "VAULT_WRAPPER_NOT_FOUND"


# ---------------------------------------------------------------------------
# vault/primary/set
# ---------------------------------------------------------------------------


def test_primary_set_not_enrolled_does_not_echo_sentinel(client):
    """VAULT_PRIMARY_WRAPPER_NOT_FOUND 400 must not expose raw ValueError."""
    error_msg = f"Primary method/wrapper must be an enrolled wrapper: {SENTINEL}"

    with (
        _patch_auth(),
        patch("api.routes.db_proxy.VaultKeysService") as MockService,
    ):
        instance = MockService.return_value
        instance.set_primary_method = AsyncMock(side_effect=ValueError(error_msg))
        response = client.post(
            "/db/vault/primary/set",
            json=_PRIMARY_SET_BODY,
            headers={"Authorization": "Bearer fake-token"},
        )

    assert response.status_code == 400
    body = response.text
    assert SENTINEL not in body


def test_primary_set_generic_error_does_not_echo_sentinel(client):
    """Generic VAULT_VALIDATION_ERROR 400 must use opaque static message."""
    error_msg = f"internal_column_check_failed: {SENTINEL}"

    with (
        _patch_auth(),
        patch("api.routes.db_proxy.VaultKeysService") as MockService,
    ):
        instance = MockService.return_value
        instance.set_primary_method = AsyncMock(side_effect=ValueError(error_msg))
        response = client.post(
            "/db/vault/primary/set",
            json=_PRIMARY_SET_BODY,
            headers={"Authorization": "Bearer fake-token"},
        )

    assert response.status_code == 400
    body = response.text
    assert SENTINEL not in body
    data = response.json()
    assert data.get("detail", {}).get("code") == "VAULT_VALIDATION_ERROR"
