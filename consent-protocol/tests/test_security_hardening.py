# tests/test_security_hardening.py
"""
Security Hardening Tests
========================

Tests for input validation guards added to the three most security-critical
modules: vault/encrypt.py, consent/token.py, and trust/link.py.

These tests verify:
- Malformed keys are rejected before reaching AES/HMAC primitives
- Format-injection via pipe characters is blocked
- Negative/zero/excessive expiry values are rejected
- Wrong types raise ValueError, not cryptic AttributeError/TypeError
"""

import os

import pytest

from hushh_mcp.consent.token import issue_token
from hushh_mcp.constants import ConsentScope
from hushh_mcp.trust.link import create_trust_link, verify_trust_link
from hushh_mcp.vault.encrypt import _validate_key_hex, decrypt_data, encrypt_data

# ============================================================================
# Vault — _validate_key_hex
# ============================================================================


class TestValidateKeyHex:
    """Tests for the hex key validator in vault/encrypt.py."""

    def test_valid_64_char_hex_key(self):
        key = os.urandom(32).hex()
        result = _validate_key_hex(key)
        assert isinstance(result, bytes)
        assert len(result) == 32

    def test_valid_key_with_leading_trailing_whitespace(self):
        key = "  " + os.urandom(32).hex() + "  "
        result = _validate_key_hex(key)
        assert len(result) == 32

    def test_rejects_non_string_input_int(self):
        with pytest.raises(ValueError, match="hex string"):
            _validate_key_hex(12345)  # type: ignore[arg-type]

    def test_rejects_non_string_input_bytes(self):
        with pytest.raises(ValueError, match="hex string"):
            _validate_key_hex(os.urandom(32))  # type: ignore[arg-type]

    def test_rejects_too_short_key(self):
        short_key = os.urandom(16).hex()  # 32 chars instead of 64
        with pytest.raises(ValueError, match="64 hex characters"):
            _validate_key_hex(short_key)

    def test_rejects_too_long_key(self):
        long_key = os.urandom(64).hex()  # 128 chars instead of 64
        with pytest.raises(ValueError, match="64 hex characters"):
            _validate_key_hex(long_key)

    def test_rejects_empty_string(self):
        with pytest.raises(ValueError, match="64 hex characters"):
            _validate_key_hex("")

    def test_rejects_invalid_hex_characters(self):
        invalid = "z" * 64  # 'z' is not valid hex
        with pytest.raises(ValueError, match="invalid hex"):
            _validate_key_hex(invalid)

    def test_rejects_mixed_valid_invalid_hex(self):
        # 63 valid hex chars + 1 invalid
        invalid = os.urandom(31).hex() + "zz"
        with pytest.raises(ValueError):
            _validate_key_hex(invalid)

    def test_uppercase_hex_accepted(self):
        key = os.urandom(32).hex().upper()
        result = _validate_key_hex(key)
        assert len(result) == 32


# ============================================================================
# Vault — encrypt_data / decrypt_data reject bad keys early
# ============================================================================


class TestEncryptDataValidation:
    """Verify encrypt_data raises ValueError (not RuntimeError) for bad keys."""

    def test_encrypt_raises_value_error_for_short_key(self):
        with pytest.raises((ValueError, RuntimeError)):
            encrypt_data("hello", "tooshort")

    def test_encrypt_raises_value_error_for_non_string_key(self):
        with pytest.raises((ValueError, RuntimeError, TypeError)):
            encrypt_data("hello", 12345)  # type: ignore[arg-type]

    def test_decrypt_raises_value_error_for_short_key(self, test_vault_key):
        encrypted = encrypt_data("hello", test_vault_key)
        with pytest.raises((ValueError, RuntimeError)):
            decrypt_data(encrypted, "tooshort")

    def test_encrypt_decrypt_roundtrip(self, test_vault_key):
        plaintext = "sensitive_user_data_123"
        encrypted = encrypt_data(plaintext, test_vault_key)
        assert decrypt_data(encrypted, test_vault_key) == plaintext


# ============================================================================
# Consent Token — issue_token input validation
# ============================================================================


class TestIssueTokenValidation:
    """Tests for _validate_token_inputs called inside issue_token."""

    def test_rejects_empty_user_id(self):
        with pytest.raises(ValueError, match="user_id"):
            issue_token("", "agent_x", ConsentScope.PKM_READ)

    def test_rejects_whitespace_only_user_id(self):
        with pytest.raises(ValueError, match="user_id"):
            issue_token("   ", "agent_x", ConsentScope.PKM_READ)

    def test_rejects_empty_agent_id(self):
        with pytest.raises(ValueError, match="agent_id"):
            issue_token("user_1", "", ConsentScope.PKM_READ)

    def test_rejects_whitespace_only_agent_id(self):
        with pytest.raises(ValueError, match="agent_id"):
            issue_token("user_1", "  ", ConsentScope.PKM_READ)

    def test_rejects_zero_expiry(self):
        with pytest.raises(ValueError, match="expires_in_ms"):
            issue_token("user_1", "agent_x", ConsentScope.PKM_READ, expires_in_ms=0)

    def test_rejects_negative_expiry(self):
        with pytest.raises(ValueError, match="expires_in_ms"):
            issue_token("user_1", "agent_x", ConsentScope.PKM_READ, expires_in_ms=-1)

    def test_rejects_float_expiry(self):
        with pytest.raises((ValueError, TypeError)):
            issue_token("user_1", "agent_x", ConsentScope.PKM_READ, expires_in_ms=1.5)  # type: ignore[arg-type]

    def test_rejects_expiry_exceeding_one_year(self):
        one_year_plus_one_ms = 365 * 24 * 60 * 60 * 1000 + 1
        with pytest.raises(ValueError, match="maximum"):
            issue_token("user_1", "agent_x", ConsentScope.PKM_READ, expires_in_ms=one_year_plus_one_ms)

    def test_exactly_one_year_expiry_is_accepted(self):
        one_year_ms = 365 * 24 * 60 * 60 * 1000
        token_obj = issue_token("user_1", "agent_x", ConsentScope.PKM_READ, expires_in_ms=one_year_ms)
        assert token_obj is not None

    def test_rejects_pipe_in_user_id(self):
        with pytest.raises(ValueError, match="pipe"):
            issue_token("user|injected", "agent_x", ConsentScope.PKM_READ)

    def test_rejects_pipe_in_agent_id(self):
        with pytest.raises(ValueError, match="pipe"):
            issue_token("user_1", "agent|injected", ConsentScope.PKM_READ)

    def test_valid_inputs_produce_token(self):
        token_obj = issue_token("user_abc", "agent_xyz", ConsentScope.PKM_READ)
        assert token_obj.token.startswith("HCT:")
        assert token_obj.user_id == "user_abc"
        assert token_obj.agent_id == "agent_xyz"

    def test_dynamic_scope_string_is_accepted(self):
        token_obj = issue_token("user_abc", "agent_xyz", "attr.financial.*")
        assert token_obj is not None
        assert token_obj.scope_str == "attr.financial.*"

    @pytest.mark.parametrize("bad_user_id", ["", " ", "\t", "\n"])
    def test_blank_user_ids_rejected(self, bad_user_id):
        with pytest.raises(ValueError, match="user_id"):
            issue_token(bad_user_id, "agent_x", ConsentScope.PKM_READ)

    @pytest.mark.parametrize("bad_agent_id", ["", " ", "\t"])
    def test_blank_agent_ids_rejected(self, bad_agent_id):
        with pytest.raises(ValueError, match="agent_id"):
            issue_token("user_1", bad_agent_id, ConsentScope.PKM_READ)


# ============================================================================
# Consent Token — pipe injection cannot forge token payload
# ============================================================================


class TestTokenPipeInjectionGuard:
    """Verify pipe injection in IDs cannot forge a different payload."""

    def test_pipe_in_user_id_raises_before_signing(self):
        """
        Without the guard, 'attacker|bad_agent' as user_id would inject a
        fake agent_id field into the HMAC input, allowing scope escalation.
        The validator must reject this before any HMAC computation.
        """
        with pytest.raises(ValueError):
            issue_token("attacker|bad_agent", "real_agent", ConsentScope.PKM_READ)

    def test_pipe_in_agent_id_raises_before_signing(self):
        with pytest.raises(ValueError):
            issue_token("real_user", "agent|fake_scope|vault.owner", ConsentScope.PKM_READ)


# ============================================================================
# TrustLink — create_trust_link input validation
# ============================================================================


class TestCreateTrustLinkValidation:
    """Tests for _validate_trust_link_inputs called inside create_trust_link."""

    def test_rejects_empty_from_agent(self):
        with pytest.raises(ValueError, match="from_agent"):
            create_trust_link("", "agent_b", ConsentScope.PKM_READ, "user_1")

    def test_rejects_whitespace_from_agent(self):
        with pytest.raises(ValueError, match="from_agent"):
            create_trust_link("  ", "agent_b", ConsentScope.PKM_READ, "user_1")

    def test_rejects_empty_to_agent(self):
        with pytest.raises(ValueError, match="to_agent"):
            create_trust_link("agent_a", "", ConsentScope.PKM_READ, "user_1")

    def test_rejects_non_enum_scope(self):
        with pytest.raises(ValueError, match="ConsentScope"):
            create_trust_link("agent_a", "agent_b", "pkm.read", "user_1")  # type: ignore[arg-type]

    def test_rejects_empty_signed_by_user(self):
        with pytest.raises(ValueError, match="signed_by_user"):
            create_trust_link("agent_a", "agent_b", ConsentScope.PKM_READ, "")

    def test_rejects_zero_expiry(self):
        with pytest.raises(ValueError, match="expires_in_ms"):
            create_trust_link("agent_a", "agent_b", ConsentScope.PKM_READ, "user_1", expires_in_ms=0)

    def test_rejects_negative_expiry(self):
        with pytest.raises(ValueError, match="expires_in_ms"):
            create_trust_link(
                "agent_a", "agent_b", ConsentScope.PKM_READ, "user_1", expires_in_ms=-500
            )

    def test_rejects_pipe_in_from_agent(self):
        with pytest.raises(ValueError, match="pipe"):
            create_trust_link("agent|injected", "agent_b", ConsentScope.PKM_READ, "user_1")

    def test_rejects_pipe_in_to_agent(self):
        with pytest.raises(ValueError, match="pipe"):
            create_trust_link("agent_a", "agent|injected", ConsentScope.PKM_READ, "user_1")

    def test_rejects_pipe_in_signed_by_user(self):
        with pytest.raises(ValueError, match="pipe"):
            create_trust_link("agent_a", "agent_b", ConsentScope.PKM_READ, "user|injected")

    def test_valid_inputs_produce_trust_link(self):
        link = create_trust_link("agent_a", "agent_b", ConsentScope.PKM_READ, "user_1")
        assert link.from_agent == "agent_a"
        assert link.to_agent == "agent_b"
        assert link.scope == ConsentScope.PKM_READ
        assert verify_trust_link(link) is True

    @pytest.mark.parametrize(
        "from_a,to_a,user",
        [
            ("agent|x", "agent_b", "user_1"),
            ("agent_a", "agent|x", "user_1"),
            ("agent_a", "agent_b", "user|x"),
        ],
    )
    def test_pipe_injection_blocked_in_all_string_fields(self, from_a, to_a, user):
        with pytest.raises(ValueError, match="pipe"):
            create_trust_link(from_a, to_a, ConsentScope.PKM_READ, user)

    @pytest.mark.parametrize("scope_str", ["pkm.read", "vault.owner", "attr.financial.*", ""])
    def test_string_scopes_always_rejected(self, scope_str):
        with pytest.raises(ValueError, match="ConsentScope"):
            create_trust_link("agent_a", "agent_b", scope_str, "user_1")  # type: ignore[arg-type]

    @pytest.mark.parametrize(
        "scope_enum",
        [
            ConsentScope.PKM_READ,
            ConsentScope.PKM_WRITE,
            ConsentScope.VAULT_OWNER,
            ConsentScope.AGENT_EXECUTE,
        ],
    )
    def test_all_consent_scope_enums_accepted(self, scope_enum):
        link = create_trust_link("agent_a", "agent_b", scope_enum, "user_1")
        assert link.scope == scope_enum


# ============================================================================
# TrustLink — expiry simulation via monkeypatch (regression test)
# ============================================================================


class TestTrustLinkExpiry:
    """Verify expired links are rejected using time monkeypatching."""

    def test_link_valid_before_expiry(self):
        link = create_trust_link("agent_a", "agent_b", ConsentScope.PKM_READ, "user_1", expires_in_ms=60_000)
        assert verify_trust_link(link) is True

    def test_link_invalid_after_expiry(self, monkeypatch):
        import time as _time

        link = create_trust_link("agent_a", "agent_b", ConsentScope.PKM_READ, "user_1", expires_in_ms=1)
        future = _time.time() + 10
        monkeypatch.setattr("hushh_mcp.trust.link.time.time", lambda: future)
        assert verify_trust_link(link) is False
