"""Regression tests for CWE-209 in api/routes/db_proxy.py vault write routes.

The ValueError handlers in vault_setup, vault_wrapper_upsert,
vault_wrapper_delete, and vault_primary_set previously echoed
str(e) directly into the HTTP response body. Service-layer ValueError
text can include DSN-shaped strings, key material descriptors, and other
internal detail. This suite drives each route through the real router,
forces the service layer to raise the specific ValueError messages each
handler branches on, and asserts the response body never contains the
raw exception text while the intended status code and error code are
preserved.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes import db_proxy

_USER_ID = "test-vault-user"


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(db_proxy.router)
    app.dependency_overrides[require_firebase_auth] = lambda: _USER_ID
    app.dependency_overrides[db_proxy.require_vault_owner_consent_header] = lambda: {
        "user_id": _USER_ID
    }
    return app


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(db_proxy, "ENFORCE_VAULT_WRITE_CLIENT_VERSION", False)
    return TestClient(_build_app(), raise_server_exceptions=False)


def _mock_service_raising(method_name: str, message: str) -> MagicMock:
    service = MagicMock()
    setattr(service, method_name, AsyncMock(side_effect=ValueError(message)))
    return service


class TestVaultSetupOpaque:
    _PAYLOAD = {
        "userId": _USER_ID,
        "vaultKeyHash": "hash",
        "primaryMethod": "passphrase",
        "recoveryEncryptedVaultKey": "enc",
        "recoverySalt": "salt",
        "recoveryIv": "iv",
        "wrappers": [
            {
                "method": "passphrase",
                "encryptedVaultKey": "enc",
                "salt": "salt",
                "iv": "iv",
            }
        ],
    }

    def test_vault_already_exists_is_opaque(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        raw = "Active vault already exists for connection postgres://user:pw@internal-db:5432/vault"
        monkeypatch.setattr(
            db_proxy,
            "VaultKeysService",
            lambda: _mock_service_raising("setup_vault_state", raw),
        )
        resp = client.post("/db/vault/setup", json=self._PAYLOAD)
        assert resp.status_code == 409
        body = resp.json()
        assert body["detail"]["code"] == "VAULT_ALREADY_EXISTS"
        assert "postgres://" not in resp.text
        assert raw not in resp.text

    def test_generic_validation_error_is_opaque(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        raw = "primaryMethod + primaryWrapperId mismatch: /etc/secrets/vault.key not found"
        monkeypatch.setattr(
            db_proxy,
            "VaultKeysService",
            lambda: _mock_service_raising("setup_vault_state", raw),
        )
        resp = client.post("/db/vault/setup", json=self._PAYLOAD)
        assert resp.status_code == 400
        body = resp.json()
        assert body["detail"]["code"] == "VAULT_PRIMARY_WRAPPER_NOT_FOUND"
        assert "/etc/secrets" not in resp.text
        assert raw not in resp.text


class TestVaultWrapperUpsertOpaque:
    _PAYLOAD = {
        "userId": _USER_ID,
        "vaultKeyHash": "hash",
        "method": "passkey",
        "encryptedVaultKey": "enc",
        "salt": "salt",
        "iv": "iv",
    }

    def test_passkey_rp_mismatch_is_opaque(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        raw = "wrapper rp id is not allowed for this environment: internal.hushh.local"
        monkeypatch.setattr(
            db_proxy,
            "VaultKeysService",
            lambda: _mock_service_raising("upsert_wrapper", raw),
        )
        resp = client.post("/db/vault/wrapper/upsert", json=self._PAYLOAD)
        assert resp.status_code == 400
        body = resp.json()
        assert body["detail"]["code"] == "VAULT_PASSKEY_RP_MISMATCH"
        assert "internal.hushh.local" not in resp.text
        assert raw not in resp.text

    def test_generic_validation_error_is_opaque(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        raw = "unexpected wrapper state for key 0xDEADBEEF"
        monkeypatch.setattr(
            db_proxy,
            "VaultKeysService",
            lambda: _mock_service_raising("upsert_wrapper", raw),
        )
        resp = client.post("/db/vault/wrapper/upsert", json=self._PAYLOAD)
        assert resp.status_code == 400
        body = resp.json()
        assert body["detail"]["code"] == "VAULT_VALIDATION_ERROR"
        assert "0xDEADBEEF" not in resp.text
        assert raw not in resp.text


class TestVaultWrapperDeleteOpaque:
    _PAYLOAD = {
        "userId": _USER_ID,
        "vaultKeyHash": "hash",
        "method": "passkey",
    }

    def test_key_hash_mismatch_is_opaque_with_specific_code(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        raw = "vaultKeyHash mismatch against stored hash abcdef1234567890"
        monkeypatch.setattr(
            db_proxy,
            "VaultKeysService",
            lambda: _mock_service_raising("delete_wrapper", raw),
        )
        resp = client.post("/db/vault/wrapper/delete", json=self._PAYLOAD)
        assert resp.status_code == 400
        body = resp.json()
        assert body["detail"]["code"] == "VAULT_KEY_HASH_MISMATCH"
        assert "abcdef1234567890" not in resp.text
        assert raw not in resp.text

    def test_wrapper_not_found_is_opaque_with_specific_code(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        raw = "Vault wrapper not found for internal row id 998877"
        monkeypatch.setattr(
            db_proxy,
            "VaultKeysService",
            lambda: _mock_service_raising("delete_wrapper", raw),
        )
        resp = client.post("/db/vault/wrapper/delete", json=self._PAYLOAD)
        assert resp.status_code == 400
        body = resp.json()
        assert body["detail"]["code"] == "VAULT_WRAPPER_NOT_FOUND"
        assert "998877" not in resp.text
        assert raw not in resp.text


class TestVaultPrimarySetOpaque:
    _PAYLOAD = {
        "userId": _USER_ID,
        "primaryMethod": "passkey",
    }

    def test_primary_wrapper_not_enrolled_is_opaque(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        raw = "Primary method/wrapper must be an enrolled wrapper, got internal-id=zz-77"
        monkeypatch.setattr(
            db_proxy,
            "VaultKeysService",
            lambda: _mock_service_raising("set_primary_method", raw),
        )
        resp = client.post("/db/vault/primary/set", json=self._PAYLOAD)
        assert resp.status_code == 400
        body = resp.json()
        assert body["detail"]["code"] == "VAULT_PRIMARY_WRAPPER_NOT_FOUND"
        assert "zz-77" not in resp.text
        assert raw not in resp.text

    def test_generic_validation_error_is_opaque(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        raw = "primary method conflicts with config at /opt/hushh/vault.cfg"
        monkeypatch.setattr(
            db_proxy,
            "VaultKeysService",
            lambda: _mock_service_raising("set_primary_method", raw),
        )
        resp = client.post("/db/vault/primary/set", json=self._PAYLOAD)
        assert resp.status_code == 400
        body = resp.json()
        assert body["detail"]["code"] == "VAULT_VALIDATION_ERROR"
        assert "/opt/hushh" not in resp.text
        assert raw not in resp.text
