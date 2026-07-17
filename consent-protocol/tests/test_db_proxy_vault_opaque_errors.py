"""Route-level proof that vault write endpoints return opaque error messages.

These tests exercise the live db_proxy router (prefix /db) end to end through
FastAPI's TestClient. They force VaultKeysService to raise the domain
ValueError variants each handler branches on, then assert that:

1. The HTTP status code is preserved.
2. The machine-readable "code" field is preserved so clients keep working.
3. The human-readable "error" field is an opaque constant that does not echo
   the raw exception text (CWE-209 information exposure).

The endpoints under test are reachable from the vault enrollment flow:
setup, wrapper upsert, wrapper delete, and primary method selection.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import db_proxy

USER_ID = "user_123"


class _RaisingVaultKeysService:
    """Stand-in VaultKeysService whose write methods raise a chosen ValueError."""

    raise_message = "internal sentinel detail that must not reach the client"

    def __init__(self, *args, **kwargs):
        pass

    async def setup_vault_state(self, *args, **kwargs):
        raise ValueError(self.raise_message)

    async def upsert_wrapper(self, *args, **kwargs):
        raise ValueError(self.raise_message)

    async def delete_wrapper(self, *args, **kwargs):
        raise ValueError(self.raise_message)

    async def set_primary_method(self, *args, **kwargs):
        raise ValueError(self.raise_message)


@pytest.fixture
def client(monkeypatch):
    """Build the db_proxy app with auth and version gates neutralized for tests."""
    monkeypatch.setattr(db_proxy, "ENFORCE_VAULT_WRITE_CLIENT_VERSION", False)

    app = FastAPI()
    app.include_router(db_proxy.router)
    app.dependency_overrides[db_proxy.require_firebase_auth] = lambda: USER_ID
    app.dependency_overrides[db_proxy.require_vault_owner_consent_header] = lambda: {
        "user_id": USER_ID
    }
    return TestClient(app)


def _set_service_error(monkeypatch, message: str):
    _RaisingVaultKeysService.raise_message = message
    monkeypatch.setattr(db_proxy, "VaultKeysService", _RaisingVaultKeysService)


def _assert_opaque(detail: dict, expected_code: str, leaked: str):
    assert detail["code"] == expected_code
    assert leaked not in detail["error"]
    assert detail["error"] != leaked


def test_vault_setup_primary_wrapper_error_is_opaque(client, monkeypatch):
    _set_service_error(monkeypatch, "primaryMethod + primaryWrapperId leaked path /srv/x")

    response = client.post(
        "/db/vault/setup",
        json={
            "userId": USER_ID,
            "vaultKeyHash": "hash-1",
            "primaryMethod": "passphrase",
            "recoveryEncryptedVaultKey": "rek",
            "recoverySalt": "rs",
            "recoveryIv": "ri",
            "wrappers": [
                {
                    "method": "passphrase",
                    "encryptedVaultKey": "evk",
                    "salt": "s",
                    "iv": "i",
                }
            ],
        },
    )

    assert response.status_code == 400
    detail = response.json()["detail"]
    _assert_opaque(detail, "VAULT_PRIMARY_WRAPPER_NOT_FOUND", "/srv/x")
    assert detail["error"] == "Primary wrapper configuration is invalid"


def test_vault_setup_generic_validation_error_is_opaque(client, monkeypatch):
    _set_service_error(monkeypatch, "some internal validation trace user_123 secret")

    response = client.post(
        "/db/vault/setup",
        json={
            "userId": USER_ID,
            "vaultKeyHash": "hash-1",
            "primaryMethod": "passphrase",
            "recoveryEncryptedVaultKey": "rek",
            "recoverySalt": "rs",
            "recoveryIv": "ri",
            "wrappers": [
                {
                    "method": "passphrase",
                    "encryptedVaultKey": "evk",
                    "salt": "s",
                    "iv": "i",
                }
            ],
        },
    )

    assert response.status_code == 400
    detail = response.json()["detail"]
    _assert_opaque(detail, "VAULT_VALIDATION_ERROR", "secret")
    assert detail["error"] == "Vault setup configuration is invalid"


def test_vault_setup_already_exists_error_is_opaque(client, monkeypatch):
    _set_service_error(monkeypatch, "Active vault already exists for internal-row-42")

    response = client.post(
        "/db/vault/setup",
        json={
            "userId": USER_ID,
            "vaultKeyHash": "hash-1",
            "primaryMethod": "passphrase",
            "recoveryEncryptedVaultKey": "rek",
            "recoverySalt": "rs",
            "recoveryIv": "ri",
            "wrappers": [
                {
                    "method": "passphrase",
                    "encryptedVaultKey": "evk",
                    "salt": "s",
                    "iv": "i",
                }
            ],
        },
    )

    assert response.status_code == 409
    detail = response.json()["detail"]
    _assert_opaque(detail, "VAULT_ALREADY_EXISTS", "internal-row-42")
    assert detail["error"] == "An active vault already exists for this user"


def test_vault_wrapper_upsert_passkey_rp_error_is_opaque(client, monkeypatch):
    _set_service_error(
        monkeypatch, "wrapper rp id is not allowed for this environment host=internal.db"
    )

    response = client.post(
        "/db/vault/wrapper/upsert",
        json={
            "userId": USER_ID,
            "vaultKeyHash": "hash-1",
            "method": "generated_default_web_prf",
            "encryptedVaultKey": "evk",
            "salt": "s",
            "iv": "i",
        },
    )

    assert response.status_code == 400
    detail = response.json()["detail"]
    _assert_opaque(detail, "VAULT_PASSKEY_RP_MISMATCH", "internal.db")
    assert detail["error"] == "Passkey relying party configuration is not allowed"


def test_vault_wrapper_upsert_generic_error_is_opaque(client, monkeypatch):
    _set_service_error(monkeypatch, "raw stack trace File line 99 token=abc")

    response = client.post(
        "/db/vault/wrapper/upsert",
        json={
            "userId": USER_ID,
            "vaultKeyHash": "hash-1",
            "method": "generated_default_web_prf",
            "encryptedVaultKey": "evk",
            "salt": "s",
            "iv": "i",
        },
    )

    assert response.status_code == 400
    detail = response.json()["detail"]
    _assert_opaque(detail, "VAULT_VALIDATION_ERROR", "token=abc")
    assert detail["error"] == "Vault wrapper configuration is invalid"


def test_vault_wrapper_delete_error_is_opaque_with_specific_code(client, monkeypatch):
    _set_service_error(monkeypatch, "Vault wrapper not found internal-id-7")

    response = client.post(
        "/db/vault/wrapper/delete",
        json={
            "userId": USER_ID,
            "vaultKeyHash": "hash-1",
            "method": "generated_default_web_prf",
            "wrapperId": "cred-1",
        },
    )

    assert response.status_code == 400
    detail = response.json()["detail"]
    _assert_opaque(detail, "VAULT_WRAPPER_NOT_FOUND", "internal-id-7")
    assert detail["error"] == "Vault wrapper deletion request is invalid"


def test_vault_primary_set_not_enrolled_error_is_opaque(client, monkeypatch):
    _set_service_error(
        monkeypatch, "Primary method/wrapper must be an enrolled wrapper db_row=88"
    )

    response = client.post(
        "/db/vault/primary/set",
        json={
            "userId": USER_ID,
            "primaryMethod": "passphrase",
            "primaryWrapperId": "default",
        },
    )

    assert response.status_code == 400
    detail = response.json()["detail"]
    _assert_opaque(detail, "VAULT_PRIMARY_WRAPPER_NOT_FOUND", "db_row=88")
    assert detail["error"] == "Primary wrapper configuration is invalid"


def test_vault_primary_set_generic_error_is_opaque(client, monkeypatch):
    _set_service_error(monkeypatch, "unexpected internal value column=secret_col")

    response = client.post(
        "/db/vault/primary/set",
        json={
            "userId": USER_ID,
            "primaryMethod": "passphrase",
            "primaryWrapperId": "default",
        },
    )

    assert response.status_code == 400
    detail = response.json()["detail"]
    _assert_opaque(detail, "VAULT_VALIDATION_ERROR", "secret_col")
    assert detail["error"] == "Primary method configuration is invalid"
