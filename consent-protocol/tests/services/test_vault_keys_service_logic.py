# tests/services/test_vault_keys_service_logic.py
"""
Vault Keys Service Logic Tests
===============================

Tests for the input sanitization and validation helpers in VaultKeysService.

These methods guard every vault key operation -- they validate unlock
methods, sanitize user-submitted strings, and mask user IDs for logging.
Incorrect behavior here can lead to vault lockout or data leakage.
"""

import time

import pytest

from hushh_mcp.services.vault_keys_service import (
    ALLOWED_METHODS,
    VaultKeysService,
)

# ============================================================================
# _mask_user_id
# ============================================================================


class TestMaskUserId:
    """Tests for user ID masking in log output."""

    def test_masks_long_user_id(self):
        result = VaultKeysService._mask_user_id("abcdefghijklmnop")
        assert result == "abcd...mnop"

    def test_does_not_mask_short_id(self):
        result = VaultKeysService._mask_user_id("abcd1234")
        assert result == "abcd1234"

    def test_does_not_mask_exactly_8_chars(self):
        result = VaultKeysService._mask_user_id("12345678")
        assert result == "12345678"

    def test_masks_9_char_id(self):
        result = VaultKeysService._mask_user_id("123456789")
        assert result == "1234...6789"

    def test_empty_returns_unknown(self):
        assert VaultKeysService._mask_user_id("") == "<unknown>"

    def test_none_returns_unknown(self):
        assert VaultKeysService._mask_user_id(None) == "<unknown>"


# ============================================================================
# _clean_text
# ============================================================================


class TestCleanText:
    """Tests for text input sanitization."""

    def test_strips_whitespace(self):
        assert VaultKeysService._clean_text("  hello  ") == "hello"

    def test_null_string_returns_empty(self):
        assert VaultKeysService._clean_text("null") == ""

    def test_undefined_string_returns_empty(self):
        assert VaultKeysService._clean_text("undefined") == ""

    def test_none_string_returns_empty(self):
        assert VaultKeysService._clean_text("None") == ""

    def test_case_insensitive_null_detection(self):
        assert VaultKeysService._clean_text("NULL") == ""
        assert VaultKeysService._clean_text("Null") == ""

    def test_none_input_returns_empty_by_default(self):
        assert VaultKeysService._clean_text(None) == ""

    def test_none_input_returns_none_when_allowed(self):
        assert VaultKeysService._clean_text(None, allow_none=True) is None

    def test_null_string_returns_none_when_allowed(self):
        assert VaultKeysService._clean_text("null", allow_none=True) is None

    def test_valid_text_preserved(self):
        assert VaultKeysService._clean_text("valid_key_material") == "valid_key_material"

    def test_empty_string_returns_empty(self):
        assert VaultKeysService._clean_text("") == ""

    def test_whitespace_only_returns_empty(self):
        assert VaultKeysService._clean_text("   ") == ""

    def test_whitespace_only_returns_none_when_allowed(self):
        assert VaultKeysService._clean_text("   ", allow_none=True) is None


# ============================================================================
# _clean_base64ish
# ============================================================================


class TestCleanBase64ish:
    """Tests for base64-like string sanitization."""

    def test_strips_whitespace_within_value(self):
        result = VaultKeysService._clean_base64ish("abc def ghi")
        assert result == "abcdefghi"

    def test_strips_newlines(self):
        result = VaultKeysService._clean_base64ish("abc\ndef\nghi")
        assert result == "abcdefghi"

    def test_null_string_returns_empty(self):
        assert VaultKeysService._clean_base64ish("null") == ""

    def test_none_input_returns_empty(self):
        assert VaultKeysService._clean_base64ish(None) == ""

    def test_none_input_returns_none_when_allowed(self):
        assert VaultKeysService._clean_base64ish(None, allow_none=True) is None

    def test_valid_base64_preserved(self):
        b64 = "SGVsbG8gV29ybGQ="
        assert VaultKeysService._clean_base64ish(b64) == b64


# ============================================================================
# _normalize_method
# ============================================================================


class TestNormalizeMethod:
    """Tests for vault unlock method normalization."""

    def test_passphrase_accepted(self):
        assert VaultKeysService._normalize_method("passphrase") == "passphrase"

    def test_biometric_accepted(self):
        result = VaultKeysService._normalize_method("generated_default_native_biometric")
        assert result == "generated_default_native_biometric"

    def test_web_prf_accepted(self):
        result = VaultKeysService._normalize_method("generated_default_web_prf")
        assert result == "generated_default_web_prf"

    def test_native_passkey_prf_accepted(self):
        result = VaultKeysService._normalize_method("generated_default_native_passkey_prf")
        assert result == "generated_default_native_passkey_prf"

    def test_case_insensitive(self):
        assert VaultKeysService._normalize_method("PASSPHRASE") == "passphrase"

    def test_strips_whitespace(self):
        assert VaultKeysService._normalize_method("  passphrase  ") == "passphrase"

    def test_rejects_unknown_method(self):
        with pytest.raises(ValueError, match="Unsupported vault method"):
            VaultKeysService._normalize_method("fingerprint")

    def test_rejects_empty_method(self):
        with pytest.raises(ValueError, match="Unsupported vault method"):
            VaultKeysService._normalize_method("")

    def test_rejects_none_method(self):
        with pytest.raises(ValueError, match="Unsupported vault method"):
            VaultKeysService._normalize_method(None)

    def test_all_allowed_methods_accepted(self):
        """Every method in ALLOWED_METHODS must be accepted by _normalize_method."""
        for method in ALLOWED_METHODS:
            assert VaultKeysService._normalize_method(method) == method


# ============================================================================
# Vault State Cache
# ============================================================================


class TestVaultStateCache:
    """Tests for the in-memory vault state cache."""

    def test_cache_miss_returns_none(self):
        service = VaultKeysService()
        assert service._get_cached_vault_state("user_123") is None

    def test_cache_roundtrip(self):
        service = VaultKeysService()
        payload = {"has_vault": True, "methods": ["passphrase"]}
        service._set_cached_vault_state("user_123", payload)
        cached = service._get_cached_vault_state("user_123")
        assert cached == payload

    def test_cache_invalidation(self):
        service = VaultKeysService()
        service._set_cached_vault_state("user_123", {"data": True})
        service._invalidate_vault_state_cache("user_123")
        assert service._get_cached_vault_state("user_123") is None

    def test_set_none_removes_cache(self):
        service = VaultKeysService()
        service._set_cached_vault_state("user_123", {"data": True})
        service._set_cached_vault_state("user_123", None)
        assert service._get_cached_vault_state("user_123") is None

    def test_cache_ttl_expiry(self, monkeypatch):
        service = VaultKeysService()
        service._set_cached_vault_state("user_123", {"data": True})

        # Simulate time passing beyond TTL
        expired_time = time.time() + service.VAULT_STATE_CACHE_TTL_SECONDS + 1
        monkeypatch.setattr(time, "time", lambda: expired_time)

        assert service._get_cached_vault_state("user_123") is None

    def test_independent_user_caches(self):
        service = VaultKeysService()
        service._set_cached_vault_state("user_a", {"a": True})
        service._set_cached_vault_state("user_b", {"b": True})

        service._invalidate_vault_state_cache("user_a")
        assert service._get_cached_vault_state("user_a") is None
        assert service._get_cached_vault_state("user_b") == {"b": True}


# ============================================================================
# ALLOWED_METHODS Registry
# ============================================================================


class TestAllowedMethods:
    """Structural tests for the vault method allowlist."""

    def test_passphrase_is_allowed(self):
        assert "passphrase" in ALLOWED_METHODS

    def test_biometric_is_allowed(self):
        assert "generated_default_native_biometric" in ALLOWED_METHODS

    def test_contains_expected_count(self):
        assert len(ALLOWED_METHODS) == 4

    def test_all_methods_are_lowercase(self):
        for method in ALLOWED_METHODS:
            assert method == method.lower(), f"Method '{method}' should be lowercase"
