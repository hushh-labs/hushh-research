"""
CWE-400 (Resource Exhaustion) bounds tests for database proxy vault request models.

Verifies that request models in api/routes/db_proxy.py enforce max_length on
inbound string and list fields, preventing resource exhaustion on vault operations.
Response models are not constrained (contract-safe).
"""

import pytest
from pydantic import ValidationError

from api.routes.db_proxy import (
    SuccessResponse,
    VaultBootstrapStateRequest,
    VaultBootstrapStateResponse,
    VaultCheckRequest,
    VaultCheckResponse,
    VaultGetRequest,
    VaultIntegrityResponse,
    VaultPreStateUpdateRequest,
    VaultPrimaryMethodSetRequest,
    VaultSetupStateRequest,
    VaultStateData,
    VaultWrapperData,
    VaultWrapperDeleteRequest,
    VaultWrapperUpsertRequest,
)


class TestVaultCheckRequest:
    """Vault check request bounds (CWE-400)."""

    def test_valid_request(self):
        """Valid vault check request within bounds."""
        req = VaultCheckRequest(userId="user-123")
        assert req.userId == "user-123"

    def test_user_id_empty_rejected(self):
        """Empty user ID rejected."""
        with pytest.raises(ValidationError) as exc:
            VaultCheckRequest(userId="")
        assert "at least 1 character" in str(exc.value).lower()

    def test_user_id_max_length_accepted(self):
        """User ID at max length (256 chars) accepted."""
        req = VaultCheckRequest(userId="A" * 256)
        assert len(req.userId) == 256

    def test_user_id_exceeds_max_length_rejected(self):
        """User ID exceeding max length (257 chars) rejected."""
        with pytest.raises(ValidationError) as exc:
            VaultCheckRequest(userId="A" * 257)
        assert "at most 256 character" in str(exc.value).lower()


class TestVaultCheckResponse:
    """Vault check response (simple boolean)."""

    def test_valid_response(self):
        """Valid response."""
        resp = VaultCheckResponse(hasVault=True)
        assert resp.hasVault is True


class TestVaultBootstrapStateRequest:
    """Vault bootstrap state request bounds."""

    def test_valid_request_with_user_id(self):
        """Valid request with user ID."""
        req = VaultBootstrapStateRequest(userId="user-123")
        assert req.userId == "user-123"

    def test_valid_request_without_user_id(self):
        """Valid request without user ID."""
        req = VaultBootstrapStateRequest()
        assert req.userId is None

    def test_user_id_max_length(self):
        """User ID bounded to 256 chars."""
        with pytest.raises(ValidationError):
            VaultBootstrapStateRequest(userId="A" * 257)


class TestVaultBootstrapStateResponse:
    """Vault bootstrap state response -- no bounds (response contract must stay open)."""

    def test_valid_response(self):
        """Response accepts any valid field values from the DB."""
        resp = VaultBootstrapStateResponse(
            userId="user-123",
            hasVault=True,
            vaultStatus="active",
            loginCount=5,
        )
        assert resp.userId == "user-123"


class TestVaultPreStateUpdateRequest:
    """Vault pre-state update request bounds."""

    def test_valid_request_minimal(self):
        """Valid minimal request."""
        req = VaultPreStateUpdateRequest()
        assert req.userId is None

    def test_user_id_max_length(self):
        """User ID bounded to 256 chars."""
        with pytest.raises(ValidationError):
            VaultPreStateUpdateRequest(userId="A" * 257)

    def test_timestamp_bounds(self):
        """Timestamps bounded to >= 0."""
        with pytest.raises(ValidationError):
            VaultPreStateUpdateRequest(preOnboardingCompletedAt=-1)


class TestVaultGetRequest:
    """Vault get request bounds."""

    def test_valid_request(self):
        """Valid get request."""
        req = VaultGetRequest(userId="user-123")
        assert req.userId == "user-123"

    def test_user_id_max_length(self):
        """User ID bounded to 256 chars."""
        with pytest.raises(ValidationError):
            VaultGetRequest(userId="A" * 257)


class TestVaultWrapperData:
    """Vault wrapper data bounds."""

    def test_valid_wrapper(self):
        """Valid wrapper data within all bounds."""
        wrapper = VaultWrapperData(
            method="passphrase",
            encryptedVaultKey="encrypted" * 100,
            salt="salt" * 100,
            iv="iv" * 50,
        )
        assert wrapper.method == "passphrase"

    def test_method_max_length(self):
        """Method bounded to 64 chars."""
        with pytest.raises(ValidationError):
            VaultWrapperData(
                method="A" * 65,
                encryptedVaultKey="encrypted" * 100,
                salt="salt" * 100,
                iv="iv" * 50,
            )

    def test_wrapper_id_max_length(self):
        """Wrapper ID bounded to 256 chars."""
        with pytest.raises(ValidationError):
            VaultWrapperData(
                method="passphrase",
                wrapperId="A" * 257,
                encryptedVaultKey="encrypted" * 100,
                salt="salt" * 100,
                iv="iv" * 50,
            )

    def test_encrypted_vault_key_max_length(self):
        """Encrypted vault key bounded to 10000 chars."""
        with pytest.raises(ValidationError):
            VaultWrapperData(
                method="passphrase",
                encryptedVaultKey="A" * 10001,
                salt="salt" * 100,
                iv="iv" * 50,
            )

    def test_salt_max_length(self):
        """Salt bounded to 1024 chars."""
        with pytest.raises(ValidationError):
            VaultWrapperData(
                method="passphrase",
                encryptedVaultKey="encrypted" * 100,
                salt="A" * 1025,
                iv="iv" * 50,
            )

    def test_iv_max_length(self):
        """IV bounded to 512 chars."""
        with pytest.raises(ValidationError):
            VaultWrapperData(
                method="passphrase",
                encryptedVaultKey="encrypted" * 100,
                salt="salt" * 100,
                iv="A" * 513,
            )

    def test_passkey_credential_id_max_length(self):
        """Passkey credential ID bounded to 1024 chars."""
        with pytest.raises(ValidationError):
            VaultWrapperData(
                method="passphrase",
                encryptedVaultKey="encrypted" * 100,
                salt="salt" * 100,
                iv="iv" * 50,
                passkeyCredentialId="A" * 1025,
            )

    def test_passkey_prf_salt_max_length(self):
        """Passkey PRF salt bounded to 512 chars."""
        with pytest.raises(ValidationError):
            VaultWrapperData(
                method="passphrase",
                encryptedVaultKey="encrypted" * 100,
                salt="salt" * 100,
                iv="iv" * 50,
                passkeyPrfSalt="A" * 513,
            )

    def test_passkey_rp_id_max_length(self):
        """Passkey RP ID bounded to 256 chars."""
        with pytest.raises(ValidationError):
            VaultWrapperData(
                method="passphrase",
                encryptedVaultKey="encrypted" * 100,
                salt="salt" * 100,
                iv="iv" * 50,
                passkeyRpId="A" * 257,
            )

    def test_passkey_provider_max_length(self):
        """Passkey provider bounded to 128 chars."""
        with pytest.raises(ValidationError):
            VaultWrapperData(
                method="passphrase",
                encryptedVaultKey="encrypted" * 100,
                salt="salt" * 100,
                iv="iv" * 50,
                passkeyProvider="A" * 129,
            )

    def test_passkey_device_label_max_length(self):
        """Passkey device label bounded to 256 chars."""
        with pytest.raises(ValidationError):
            VaultWrapperData(
                method="passphrase",
                encryptedVaultKey="encrypted" * 100,
                salt="salt" * 100,
                iv="iv" * 50,
                passkeyDeviceLabel="A" * 257,
            )

    def test_passkey_last_used_at_bounds(self):
        """Passkey last used at bounded to >= 0."""
        with pytest.raises(ValidationError):
            VaultWrapperData(
                method="passphrase",
                encryptedVaultKey="encrypted" * 100,
                salt="salt" * 100,
                iv="iv" * 50,
                passkeyLastUsedAt=-1,
            )


class TestVaultStateData:
    """Vault state data bounds."""

    @staticmethod
    def _valid_wrapper():
        """Helper to create valid wrapper."""
        return VaultWrapperData(
            method="passphrase",
            encryptedVaultKey="encrypted" * 100,
            salt="salt" * 100,
            iv="iv" * 50,
        )

    def test_valid_state(self):
        """Valid vault state within bounds."""
        state = VaultStateData(
            vaultKeyHash="hash" * 100,
            primaryMethod="passphrase",
            recoveryEncryptedVaultKey="encrypted" * 100,
            recoverySalt="salt" * 100,
            recoveryIv="iv" * 50,
            wrappers=[self._valid_wrapper()],
        )
        assert state.primaryMethod == "passphrase"

    def test_vault_key_hash_max_length(self):
        """Vault key hash bounded to 1024 chars."""
        with pytest.raises(ValidationError):
            VaultStateData(
                vaultKeyHash="A" * 1025,
                primaryMethod="passphrase",
                recoveryEncryptedVaultKey="encrypted" * 100,
                recoverySalt="salt" * 100,
                recoveryIv="iv" * 50,
            )

    def test_primary_method_max_length(self):
        """Primary method bounded to 64 chars."""
        with pytest.raises(ValidationError):
            VaultStateData(
                vaultKeyHash="hash" * 100,
                primaryMethod="A" * 65,
                recoveryEncryptedVaultKey="encrypted" * 100,
                recoverySalt="salt" * 100,
                recoveryIv="iv" * 50,
            )

    def test_wrappers_list_max_length(self):
        """Wrappers list bounded to 100 items."""
        with pytest.raises(ValidationError):
            VaultStateData(
                vaultKeyHash="hash" * 100,
                primaryMethod="passphrase",
                recoveryEncryptedVaultKey="encrypted" * 100,
                recoverySalt="salt" * 100,
                recoveryIv="iv" * 50,
                wrappers=[self._valid_wrapper() for _ in range(101)],
            )


class TestVaultSetupStateRequest:
    """Vault setup state request bounds."""

    @staticmethod
    def _valid_wrapper():
        """Helper to create valid wrapper."""
        return VaultWrapperData(
            method="passphrase",
            encryptedVaultKey="encrypted" * 100,
            salt="salt" * 100,
            iv="iv" * 50,
        )

    def test_valid_request(self):
        """Valid setup state request."""
        req = VaultSetupStateRequest(
            userId="user-123",
            vaultKeyHash="hash" * 100,
            primaryMethod="passphrase",
            recoveryEncryptedVaultKey="encrypted" * 100,
            recoverySalt="salt" * 100,
            recoveryIv="iv" * 50,
            wrappers=[self._valid_wrapper()],
        )
        assert req.userId == "user-123"

    def test_user_id_max_length(self):
        """User ID bounded to 256 chars."""
        with pytest.raises(ValidationError):
            VaultSetupStateRequest(
                userId="A" * 257,
                vaultKeyHash="hash" * 100,
                primaryMethod="passphrase",
                recoveryEncryptedVaultKey="encrypted" * 100,
                recoverySalt="salt" * 100,
                recoveryIv="iv" * 50,
            )

    def test_wrappers_list_max_length(self):
        """Wrappers list bounded to 100 items."""
        with pytest.raises(ValidationError):
            VaultSetupStateRequest(
                userId="user-123",
                vaultKeyHash="hash" * 100,
                primaryMethod="passphrase",
                recoveryEncryptedVaultKey="encrypted" * 100,
                recoverySalt="salt" * 100,
                recoveryIv="iv" * 50,
                wrappers=[self._valid_wrapper() for _ in range(101)],
            )


class TestVaultWrapperUpsertRequest:
    """Vault wrapper upsert request bounds."""

    def test_valid_request(self):
        """Valid upsert request."""
        req = VaultWrapperUpsertRequest(
            userId="user-123",
            vaultKeyHash="hash" * 100,
            method="passphrase",
            encryptedVaultKey="encrypted" * 100,
            salt="salt" * 100,
            iv="iv" * 50,
        )
        assert req.userId == "user-123"

    def test_user_id_max_length(self):
        """User ID bounded to 256 chars."""
        with pytest.raises(ValidationError):
            VaultWrapperUpsertRequest(
                userId="A" * 257,
                vaultKeyHash="hash" * 100,
                method="passphrase",
                encryptedVaultKey="encrypted" * 100,
                salt="salt" * 100,
                iv="iv" * 50,
            )

    def test_method_max_length(self):
        """Method bounded to 64 chars."""
        with pytest.raises(ValidationError):
            VaultWrapperUpsertRequest(
                userId="user-123",
                vaultKeyHash="hash" * 100,
                method="A" * 65,
                encryptedVaultKey="encrypted" * 100,
                salt="salt" * 100,
                iv="iv" * 50,
            )


class TestVaultWrapperDeleteRequest:
    """Vault wrapper delete request bounds."""

    def test_valid_request(self):
        """Valid delete request with defaults."""
        req = VaultWrapperDeleteRequest(
            userId="user-123",
            vaultKeyHash="hash" * 100,
            method="passphrase",
        )
        assert req.fallbackPrimaryMethod == "passphrase"
        assert req.fallbackPrimaryWrapperId == "default"

    def test_user_id_max_length(self):
        """User ID bounded to 256 chars."""
        with pytest.raises(ValidationError):
            VaultWrapperDeleteRequest(
                userId="A" * 257,
                vaultKeyHash="hash" * 100,
                method="passphrase",
            )

    def test_vault_key_hash_max_length(self):
        """Vault key hash bounded to 1024 chars."""
        with pytest.raises(ValidationError):
            VaultWrapperDeleteRequest(
                userId="user-123",
                vaultKeyHash="A" * 1025,
                method="passphrase",
            )

    def test_method_max_length(self):
        """Method bounded to 64 chars."""
        with pytest.raises(ValidationError):
            VaultWrapperDeleteRequest(
                userId="user-123",
                vaultKeyHash="hash" * 100,
                method="A" * 65,
            )

    def test_fallback_primary_method_max_length(self):
        """Fallback primary method bounded to 64 chars."""
        with pytest.raises(ValidationError):
            VaultWrapperDeleteRequest(
                userId="user-123",
                vaultKeyHash="hash" * 100,
                method="passphrase",
                fallbackPrimaryMethod="A" * 65,
            )

    def test_fallback_primary_wrapper_id_max_length(self):
        """Fallback primary wrapper ID bounded to 256 chars."""
        with pytest.raises(ValidationError):
            VaultWrapperDeleteRequest(
                userId="user-123",
                vaultKeyHash="hash" * 100,
                method="passphrase",
                fallbackPrimaryWrapperId="A" * 257,
            )


class TestVaultPrimaryMethodSetRequest:
    """Vault primary method set request bounds."""

    def test_valid_request(self):
        """Valid primary method set request."""
        req = VaultPrimaryMethodSetRequest(
            userId="user-123",
            primaryMethod="passphrase",
        )
        assert req.userId == "user-123"

    def test_user_id_max_length(self):
        """User ID bounded to 256 chars."""
        with pytest.raises(ValidationError):
            VaultPrimaryMethodSetRequest(
                userId="A" * 257,
                primaryMethod="passphrase",
            )

    def test_primary_method_max_length(self):
        """Primary method bounded to 64 chars."""
        with pytest.raises(ValidationError):
            VaultPrimaryMethodSetRequest(
                userId="user-123",
                primaryMethod="A" * 65,
            )

    def test_primary_wrapper_id_max_length(self):
        """Primary wrapper ID bounded to 256 chars."""
        with pytest.raises(ValidationError):
            VaultPrimaryMethodSetRequest(
                userId="user-123",
                primaryMethod="passphrase",
                primaryWrapperId="A" * 257,
            )


class TestSuccessResponse:
    """Success response (simple boolean)."""

    def test_valid_response(self):
        """Valid success response."""
        resp = SuccessResponse(success=True)
        assert resp.success is True


class TestVaultIntegrityResponse:
    """Vault integrity response -- no bounds (response contract must stay open)."""

    def test_valid_response(self):
        """Response accepts any valid field values from the DB."""
        resp = VaultIntegrityResponse(
            valid=True,
            hasVault=True,
            wrapperCount=2,
            hasPassphraseWrapper=True,
            primaryMethodEnrolled=True,
            methods=["passphrase", "passkey"],
        )
        assert resp.wrapperCount == 2
