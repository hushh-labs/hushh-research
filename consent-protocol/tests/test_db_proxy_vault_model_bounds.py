"""
Tests for db_proxy vault request model input bounds.

Canonical attach points
-----------------------
api.routes.db_proxy.vault_check
  -> payload: VaultCheckRequest (userId max_length=128)
  -> FastAPI returns HTTP 422 when any bound is exceeded

api.routes.db_proxy.vault_setup
  -> payload: VaultSetupStateRequest (userId max_length=128,
     vaultKeyHash max_length=256, wrappers list max_length=20, ...)
  -> FastAPI returns HTTP 422 when any bound is exceeded

All vault request models previously had unbounded string fields.
Pydantic unit tests below verify model-layer rejection. Route-level tests
confirm the bounds fire at the HTTP framework layer via real TestClient requests.
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from api.routes.db_proxy import (
    VaultBootstrapStateRequest,
    VaultCheckRequest,
    VaultGetRequest,
    VaultPreStateUpdateRequest,
    VaultPrimaryMethodSetRequest,
    VaultSetupStateRequest,
    VaultWrapperData,
    VaultWrapperDeleteRequest,
    VaultWrapperUpsertRequest,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_VALID_WRAPPER = dict(
    method="passphrase",
    encryptedVaultKey="a" * 64,
    salt="s" * 44,
    iv="i" * 24,
)


def _make_wrapper(**overrides) -> dict:
    return {**_VALID_WRAPPER, **overrides}


# ---------------------------------------------------------------------------
# VaultCheckRequest
# ---------------------------------------------------------------------------


class TestVaultCheckRequest:
    def test_valid_passes(self):
        r = VaultCheckRequest(userId="uid_abc")
        assert r.userId == "uid_abc"

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            VaultCheckRequest(userId="u" * 129)

    def test_user_id_exactly_max_passes(self):
        r = VaultCheckRequest(userId="u" * 128)
        assert len(r.userId) == 128


# ---------------------------------------------------------------------------
# VaultBootstrapStateRequest
# ---------------------------------------------------------------------------


class TestVaultBootstrapStateRequest:
    def test_none_user_id_passes(self):
        r = VaultBootstrapStateRequest()
        assert r.userId is None

    def test_valid_user_id_passes(self):
        r = VaultBootstrapStateRequest(userId="uid_abc")
        assert r.userId == "uid_abc"

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            VaultBootstrapStateRequest(userId="u" * 129)


# ---------------------------------------------------------------------------
# VaultPreStateUpdateRequest
# ---------------------------------------------------------------------------


class TestVaultPreStateUpdateRequest:
    def test_none_user_id_passes(self):
        r = VaultPreStateUpdateRequest()
        assert r.userId is None

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            VaultPreStateUpdateRequest(userId="u" * 129)


# ---------------------------------------------------------------------------
# VaultGetRequest
# ---------------------------------------------------------------------------


class TestVaultGetRequest:
    def test_valid_passes(self):
        r = VaultGetRequest(userId="uid_abc")
        assert r.userId == "uid_abc"

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            VaultGetRequest(userId="u" * 129)


# ---------------------------------------------------------------------------
# VaultWrapperData
# ---------------------------------------------------------------------------


class TestVaultWrapperData:
    def test_valid_passes(self):
        w = VaultWrapperData(**_VALID_WRAPPER)
        assert w.method == "passphrase"

    def test_method_too_long_raises(self):
        with pytest.raises(ValidationError):
            VaultWrapperData(**_make_wrapper(method="x" * 51))

    def test_encrypted_vault_key_too_long_raises(self):
        with pytest.raises(ValidationError):
            VaultWrapperData(**_make_wrapper(encryptedVaultKey="a" * 2049))

    def test_encrypted_vault_key_max_passes(self):
        w = VaultWrapperData(**_make_wrapper(encryptedVaultKey="a" * 2048))
        assert len(w.encryptedVaultKey) == 2048

    def test_salt_too_long_raises(self):
        with pytest.raises(ValidationError):
            VaultWrapperData(**_make_wrapper(salt="s" * 257))

    def test_iv_too_long_raises(self):
        with pytest.raises(ValidationError):
            VaultWrapperData(**_make_wrapper(iv="i" * 257))

    def test_passkey_credential_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            VaultWrapperData(**_make_wrapper(passkeyCredentialId="p" * 513))

    def test_passkey_rp_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            VaultWrapperData(**_make_wrapper(passkeyRpId="r" * 254))

    def test_passkey_device_label_too_long_raises(self):
        with pytest.raises(ValidationError):
            VaultWrapperData(**_make_wrapper(passkeyDeviceLabel="d" * 257))

    def test_optional_passkey_fields_none_passes(self):
        w = VaultWrapperData(**_VALID_WRAPPER)
        assert w.passkeyCredentialId is None
        assert w.passkeyRpId is None
        assert w.passkeyDeviceLabel is None


# ---------------------------------------------------------------------------
# VaultSetupStateRequest
# ---------------------------------------------------------------------------


class TestVaultSetupStateRequest:
    def _valid(self, **overrides) -> dict:
        base = dict(
            userId="uid_abc",
            vaultKeyHash="h" * 64,
            primaryMethod="passphrase",
            recoveryEncryptedVaultKey="a" * 64,
            recoverySalt="s" * 44,
            recoveryIv="i" * 24,
            wrappers=[_VALID_WRAPPER],
        )
        return {**base, **overrides}

    def test_valid_passes(self):
        r = VaultSetupStateRequest(**self._valid())
        assert r.userId == "uid_abc"

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            VaultSetupStateRequest(**self._valid(userId="u" * 129))

    def test_vault_key_hash_too_long_raises(self):
        with pytest.raises(ValidationError):
            VaultSetupStateRequest(**self._valid(vaultKeyHash="h" * 257))

    def test_primary_method_too_long_raises(self):
        with pytest.raises(ValidationError):
            VaultSetupStateRequest(**self._valid(primaryMethod="x" * 51))

    def test_recovery_encrypted_vault_key_too_long_raises(self):
        with pytest.raises(ValidationError):
            VaultSetupStateRequest(**self._valid(recoveryEncryptedVaultKey="a" * 2049))

    def test_wrappers_list_over_20_raises(self):
        with pytest.raises(ValidationError):
            VaultSetupStateRequest(**self._valid(wrappers=[_VALID_WRAPPER] * 21))

    def test_wrappers_list_exactly_20_passes(self):
        r = VaultSetupStateRequest(**self._valid(wrappers=[_VALID_WRAPPER] * 20))
        assert len(r.wrappers) == 20


# ---------------------------------------------------------------------------
# VaultWrapperUpsertRequest
# ---------------------------------------------------------------------------


class TestVaultWrapperUpsertRequest:
    def _valid(self, **overrides) -> dict:
        base = dict(
            userId="uid_abc",
            vaultKeyHash="h" * 64,
            **_VALID_WRAPPER,
        )
        return {**base, **overrides}

    def test_valid_passes(self):
        r = VaultWrapperUpsertRequest(**self._valid())
        assert r.userId == "uid_abc"

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            VaultWrapperUpsertRequest(**self._valid(userId="u" * 129))

    def test_vault_key_hash_too_long_raises(self):
        with pytest.raises(ValidationError):
            VaultWrapperUpsertRequest(**self._valid(vaultKeyHash="h" * 257))

    def test_encrypted_vault_key_too_long_raises(self):
        with pytest.raises(ValidationError):
            VaultWrapperUpsertRequest(**self._valid(encryptedVaultKey="a" * 2049))


# ---------------------------------------------------------------------------
# VaultWrapperDeleteRequest
# ---------------------------------------------------------------------------


class TestVaultWrapperDeleteRequest:
    def _valid(self, **overrides) -> dict:
        base = dict(userId="uid_abc", vaultKeyHash="h" * 64, method="passphrase")
        return {**base, **overrides}

    def test_valid_passes(self):
        r = VaultWrapperDeleteRequest(**self._valid())
        assert r.fallbackPrimaryMethod == "passphrase"

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            VaultWrapperDeleteRequest(**self._valid(userId="u" * 129))

    def test_method_too_long_raises(self):
        with pytest.raises(ValidationError):
            VaultWrapperDeleteRequest(**self._valid(method="x" * 51))

    def test_fallback_method_too_long_raises(self):
        with pytest.raises(ValidationError):
            VaultWrapperDeleteRequest(**self._valid(fallbackPrimaryMethod="x" * 51))

    def test_fallback_wrapper_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            VaultWrapperDeleteRequest(**self._valid(fallbackPrimaryWrapperId="x" * 129))


# ---------------------------------------------------------------------------
# VaultPrimaryMethodSetRequest
# ---------------------------------------------------------------------------


class TestVaultPrimaryMethodSetRequest:
    def test_valid_passes(self):
        r = VaultPrimaryMethodSetRequest(userId="uid_abc", primaryMethod="passkey")
        assert r.primaryMethod == "passkey"

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            VaultPrimaryMethodSetRequest(userId="u" * 129, primaryMethod="passphrase")

    def test_primary_method_too_long_raises(self):
        with pytest.raises(ValidationError):
            VaultPrimaryMethodSetRequest(userId="uid_abc", primaryMethod="x" * 51)

    def test_primary_wrapper_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            VaultPrimaryMethodSetRequest(
                userId="uid_abc", primaryMethod="passkey", primaryWrapperId="x" * 129
            )


# ===========================================================================
# Canonical route-level caller proof
# ===========================================================================

import api.routes.db_proxy as db_proxy_module  # noqa: E402
from api.middleware import require_firebase_auth  # noqa: E402


def _firebase_stub():
    return "test-firebase-uid"


def _db_client() -> TestClient:
    app = FastAPI()
    app.include_router(db_proxy_module.router)
    app.dependency_overrides[require_firebase_auth] = _firebase_stub
    return TestClient(app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# Canonical attach point: api.routes.db_proxy.vault_check
# POST /db/vault/check  ->  VaultCheckRequest
# ---------------------------------------------------------------------------


class TestVaultCheckRouteInputBounds:
    """
    api.routes.db_proxy.vault_check is the canonical owner of VaultCheckRequest
    validation for POST /db/vault/check.

    Proves FastAPI returns HTTP 422 when userId exceeds max_length=128.
    """

    _URL = "/db/vault/check"

    def test_valid_user_id_passes_validation(self):
        """A valid userId must not be rejected by Pydantic validation."""
        resp = _db_client().post(self._URL, json={"userId": "test-firebase-uid"})
        assert resp.status_code != 422

    def test_user_id_over_max_returns_422(self):
        """userId > 128 chars must be rejected with 422 at the framework layer."""
        resp = _db_client().post(self._URL, json={"userId": "u" * 129})
        assert resp.status_code == 422

    def test_user_id_at_max_passes_validation(self):
        """userId of exactly 128 chars must not be rejected by validation."""
        resp = _db_client().post(self._URL, json={"userId": "u" * 128})
        assert resp.status_code != 422


# ---------------------------------------------------------------------------
# Canonical attach point: api.routes.db_proxy.vault_setup
# POST /db/vault/setup  ->  VaultSetupStateRequest
# ---------------------------------------------------------------------------


class TestVaultSetupRouteInputBounds:
    """
    api.routes.db_proxy.vault_setup is the canonical owner of
    VaultSetupStateRequest validation for POST /db/vault/setup.

    Proves FastAPI returns HTTP 422 when userId, vaultKeyHash, or
    wrappers list exceed their bounds, before any DB I/O.
    """

    _URL = "/db/vault/setup"

    def _valid_body(self, **overrides) -> dict:
        base = {
            "userId": "test-firebase-uid",
            "vaultKeyHash": "hash_value",
            "primaryMethod": "passphrase",
            "recoveryEncryptedVaultKey": "rec_key",
            "recoverySalt": "rec_salt",
            "recoveryIv": "rec_iv",
            "wrappers": [
                {
                    "method": "passphrase",
                    "encryptedVaultKey": "key_data",
                    "salt": "salt_val",
                    "iv": "iv_val",
                }
            ],
        }
        return {**base, **overrides}

    def test_valid_body_passes_validation(self):
        """A valid body must not be rejected by Pydantic validation."""
        resp = _db_client().post(self._URL, json=self._valid_body())
        assert resp.status_code != 422

    def test_user_id_over_max_returns_422(self):
        """userId > 128 chars must be rejected with 422."""
        resp = _db_client().post(self._URL, json=self._valid_body(userId="u" * 129))
        assert resp.status_code == 422

    def test_vault_key_hash_over_max_returns_422(self):
        """vaultKeyHash > 256 chars must be rejected with 422."""
        resp = _db_client().post(self._URL, json=self._valid_body(vaultKeyHash="h" * 257))
        assert resp.status_code == 422

    def test_wrappers_over_max_returns_422(self):
        """wrappers list with > 20 items must be rejected with 422."""
        wrapper = {"method": "passphrase", "encryptedVaultKey": "k", "salt": "s", "iv": "i"}
        resp = _db_client().post(self._URL, json=self._valid_body(wrappers=[wrapper] * 21))
        assert resp.status_code == 422
