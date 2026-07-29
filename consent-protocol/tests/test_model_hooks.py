"""Model lifecycle hook tests for hushh_mcp/types.py.

Verifies the pre-save (@model_validator mode='before') and post-load
(public_dict()) hooks on HushhConsentToken, TrustLink, and EncryptedPayload:

Pre-Save hooks  — messy input (whitespace, padding) is automatically
                  stripped before field validation runs.
Post-Load hooks — public_dict() returns a privacy-safe view with token,
                  signature, and identity fields masked.
Logging         — "Pre-Save Hook Triggered" and "Post-Load Hook Triggered"
                  log lines are emitted (verified with caplog).

No DB, no network, no LLM.

Integrated by Abdul Gaffar — canonical pre-save and post-load model hooks.
"""

from __future__ import annotations

import logging

import pytest

from hushh_mcp.constants import ConsentScope
from hushh_mcp.types import (
    EncryptedPayload,
    HushhConsentToken,
    TrustLink,
    _mask_id,
    _mask_token,
)

_LOGGER_NAME = "hushh_mcp.types"

# ---------------------------------------------------------------------------
# Fixtures — messy (un-normalised) raw data
# ---------------------------------------------------------------------------

_MESSY_TOKEN_DATA = {
    "token": "  HCT:dGVzdA==.fakesig  ",
    "user_id": "  user-hook-test-001  ",
    "agent_id": "  agent:firm-hook-001  ",
    "scope": ConsentScope.VAULT_OWNER,
    "scope_str": "  vault.owner  ",
    "issued_at": 1_000_000,
    "expires_at": 2_000_000,
    "signature": "  abc123sig  ",
    "commercial": False,
}

_MESSY_TRUST_DATA = {
    "from_agent": "  agent:alpha  ",
    "to_agent": "  agent:beta  ",
    "scope": ConsentScope.PKM_READ,
    "created_at": 1_000_000,
    "expires_at": 2_000_000,
    "signed_by_user": "  user-001  ",
    "signature": "  trust-sig  ",
}

_MESSY_PAYLOAD_DATA = {
    "ciphertext": "  base64data==  ",
    "iv": "  ivdata==  ",
    "tag": "  tagdata==  ",
    "encoding": "base64",
    "algorithm": "aes-256-gcm",
}


# ===========================================================================
# HushhConsentToken — Pre-Save hook (whitespace normalization)
# ===========================================================================


class TestHushhConsentTokenPreSaveHook:
    def test_token_whitespace_stripped(self):
        obj = HushhConsentToken.model_validate(_MESSY_TOKEN_DATA)
        assert obj.token == "HCT:dGVzdA==.fakesig"  # noqa: S105

    def test_user_id_whitespace_stripped(self):
        obj = HushhConsentToken.model_validate(_MESSY_TOKEN_DATA)
        assert obj.user_id == "user-hook-test-001"

    def test_agent_id_whitespace_stripped(self):
        obj = HushhConsentToken.model_validate(_MESSY_TOKEN_DATA)
        assert obj.agent_id == "agent:firm-hook-001"

    def test_scope_str_whitespace_stripped(self):
        obj = HushhConsentToken.model_validate(_MESSY_TOKEN_DATA)
        assert obj.scope_str == "vault.owner"

    def test_signature_whitespace_stripped(self):
        obj = HushhConsentToken.model_validate(_MESSY_TOKEN_DATA)
        assert obj.signature == "abc123sig"

    def test_clean_input_unchanged(self):
        clean = dict(_MESSY_TOKEN_DATA)
        clean["token"] = "HCT:clean.sig"  # noqa: S105
        clean["user_id"] = "user-clean"
        clean["agent_id"] = "agent-clean"
        clean["scope_str"] = "vault.owner"
        clean["signature"] = "cleansig"
        obj = HushhConsentToken.model_validate(clean)
        assert obj.token == "HCT:clean.sig"  # noqa: S105
        assert obj.user_id == "user-clean"

    def test_non_string_fields_untouched(self):
        obj = HushhConsentToken.model_validate(_MESSY_TOKEN_DATA)
        assert obj.issued_at == 1_000_000
        assert obj.expires_at == 2_000_000
        assert obj.commercial is False


class TestHushhConsentTokenPreSaveLog:
    def test_pre_save_log_emitted(self, caplog):
        with caplog.at_level(logging.INFO, logger=_LOGGER_NAME):
            HushhConsentToken.model_validate(_MESSY_TOKEN_DATA)
        messages = [r.message for r in caplog.records if r.name == _LOGGER_NAME]
        assert any("Pre-Save Hook Triggered" in m for m in messages), (
            "Expected 'Pre-Save Hook Triggered' log during HushhConsentToken construction"
        )

    def test_pre_save_log_mentions_normalizing(self, caplog):
        with caplog.at_level(logging.INFO, logger=_LOGGER_NAME):
            HushhConsentToken.model_validate(_MESSY_TOKEN_DATA)
        assert any(
            "normalizing" in r.message.lower()
            for r in caplog.records if r.name == _LOGGER_NAME
        )


# ===========================================================================
# HushhConsentToken — Post-Load hook (public_dict masking)
# ===========================================================================


class TestHushhConsentTokenPostLoadHook:
    @pytest.fixture
    def token_obj(self):
        return HushhConsentToken.model_validate(_MESSY_TOKEN_DATA)

    def test_public_dict_returns_dict(self, token_obj):
        assert isinstance(token_obj.public_dict(), dict)

    def test_public_dict_token_masked(self, token_obj):
        public = token_obj.public_dict()
        assert "HCT:" in public["token"]
        assert "***" in public["token"]
        assert "fakesig" not in public["token"]

    def test_public_dict_signature_fully_masked(self, token_obj):
        public = token_obj.public_dict()
        assert public["signature"] == "***"

    def test_public_dict_user_id_masked(self, token_obj):
        public = token_obj.public_dict()
        # Only the first 4 chars are shown
        assert "***" in public["user_id"]
        assert "user-hook-test-001" not in public["user_id"]

    def test_public_dict_agent_id_masked(self, token_obj):
        public = token_obj.public_dict()
        assert "***" in public["agent_id"]
        assert "firm-hook-001" not in public["agent_id"]

    def test_public_dict_non_sensitive_fields_present(self, token_obj):
        public = token_obj.public_dict()
        assert public["scope"] == "vault.owner"
        assert public["issued_at"] == 1_000_000
        assert public["expires_at"] == 2_000_000
        assert public["commercial"] is False

    def test_public_dict_has_expected_keys(self, token_obj):
        public = token_obj.public_dict()
        assert set(public.keys()) == {
            "user_id", "agent_id", "scope",
            "issued_at", "expires_at", "commercial",
            "token", "signature",
        }

    def test_public_dict_log_emitted(self, token_obj, caplog):
        with caplog.at_level(logging.INFO, logger=_LOGGER_NAME):
            token_obj.public_dict()
        messages = [r.message for r in caplog.records if r.name == _LOGGER_NAME]
        assert any("Post-Load Hook Triggered" in m for m in messages)


# ===========================================================================
# TrustLink — Pre-Save hook
# ===========================================================================


class TestTrustLinkPreSaveHook:
    def test_from_agent_stripped(self):
        obj = TrustLink.model_validate(_MESSY_TRUST_DATA)
        assert obj.from_agent == "agent:alpha"

    def test_to_agent_stripped(self):
        obj = TrustLink.model_validate(_MESSY_TRUST_DATA)
        assert obj.to_agent == "agent:beta"

    def test_signed_by_user_stripped(self):
        obj = TrustLink.model_validate(_MESSY_TRUST_DATA)
        assert obj.signed_by_user == "user-001"

    def test_signature_stripped(self):
        obj = TrustLink.model_validate(_MESSY_TRUST_DATA)
        assert obj.signature == "trust-sig"

    def test_pre_save_log_emitted(self, caplog):
        with caplog.at_level(logging.INFO, logger=_LOGGER_NAME):
            TrustLink.model_validate(_MESSY_TRUST_DATA)
        assert any(
            "Pre-Save Hook Triggered" in r.message
            for r in caplog.records if r.name == _LOGGER_NAME
        )


# ===========================================================================
# EncryptedPayload — Pre-Save hook
# ===========================================================================


class TestEncryptedPayloadPreSaveHook:
    def test_ciphertext_stripped(self):
        obj = EncryptedPayload.model_validate(_MESSY_PAYLOAD_DATA)
        assert obj.ciphertext == "base64data=="

    def test_iv_stripped(self):
        obj = EncryptedPayload.model_validate(_MESSY_PAYLOAD_DATA)
        assert obj.iv == "ivdata=="

    def test_tag_stripped(self):
        obj = EncryptedPayload.model_validate(_MESSY_PAYLOAD_DATA)
        assert obj.tag == "tagdata=="

    def test_pre_save_log_emitted(self, caplog):
        with caplog.at_level(logging.INFO, logger=_LOGGER_NAME):
            EncryptedPayload.model_validate(_MESSY_PAYLOAD_DATA)
        assert any(
            "Pre-Save Hook Triggered" in r.message
            for r in caplog.records if r.name == _LOGGER_NAME
        )


# ===========================================================================
# _mask_id and _mask_token — unit tests
# ===========================================================================


class TestMaskHelpers:
    def test_mask_id_shows_prefix(self):
        result = _mask_id("user-hook-test-001")
        assert result.startswith("user")
        assert "***" in result

    def test_mask_id_short_value_fully_masked(self):
        assert _mask_id("abc") == "***"

    def test_mask_id_exactly_at_threshold(self):
        assert _mask_id("abcd") == "***"

    def test_mask_id_one_over_threshold(self):
        result = _mask_id("abcde")
        assert result == "abcd***"

    def test_mask_token_preserves_scheme_prefix(self):
        result = _mask_token("HCT:some.signature")
        assert result == "HCT:***"

    def test_mask_token_no_colon_fully_masked(self):
        assert _mask_token("noschemeatall") == "***"

    def test_mask_token_multiple_colons(self):
        # Only the first colon determines the prefix
        result = _mask_token("ZKP:user:agent:nonce:sig")
        assert result == "ZKP:***"


# ===========================================================================
# Trust-boundary proof — @model_validator fires on the canonical issue_token path
# ===========================================================================


class TestTrustBoundaryProof:
    """
    Canonical surface : hushh_mcp.types.HushhConsentToken
                        @model_validator(mode="before") — pre-save hook
                        .public_dict()                  — post-load masking hook
    Canonical caller  : hushh_mcp.consent.token.issue_token()
                          -> HushhConsentToken(token=..., user_id=..., ...)
                          -> @model_validator fires before field assignment
                          -> whitespace stripped from all string fields
                        The pre-save hook runs on EVERY HushhConsentToken
                        construction — there is no code path that bypasses it.
    Attach point proof: The tests below call issue_token() with deliberately
                        whitespace-padded fields and prove the pre-save hook
                        fires automatically, plus that public_dict() masks the
                        token and user_id fields in the issued token.
    """

    def test_pre_save_hook_fires_via_issue_token(self):
        """Pre-save hook strips whitespace from user_id when HushhConsentToken is constructed."""
        from hushh_mcp.consent.token import issue_token
        from hushh_mcp.constants import ConsentScope

        token = issue_token(
            user_id="  test-user-001  ",
            agent_id="  ria:firm-001  ",
            scope=ConsentScope.PKM_READ,
        )
        assert token.user_id == "test-user-001", (
            "Pre-save hook must strip whitespace from user_id on issue_token()"
        )
        assert token.agent_id == "ria:firm-001", (
            "Pre-save hook must strip whitespace from agent_id on issue_token()"
        )

    def test_public_dict_masks_token_on_issued_token(self):
        """public_dict() masks the token string on a token produced by issue_token()."""
        from hushh_mcp.consent.token import issue_token
        from hushh_mcp.constants import ConsentScope

        token = issue_token(
            user_id="test-user-001",
            agent_id="ria:firm-001",
            scope=ConsentScope.PKM_READ,
        )
        safe = token.public_dict()
        assert "***" in safe["token"], "public_dict() must mask the token field"
        assert token.token not in safe["token"], "Raw token must not appear in public_dict()"

    def test_model_validator_is_the_sole_whitespace_normalizer(self):
        """Whitespace normalization is done by @model_validator — not the caller."""
        obj = HushhConsentToken.model_validate(_MESSY_TOKEN_DATA)
        assert obj.user_id == _MESSY_TOKEN_DATA["user_id"].strip()
        assert obj.agent_id == _MESSY_TOKEN_DATA["agent_id"].strip()

    def test_hook_fires_on_every_construction_path(self):
        """@model_validator fires for both model_validate() and direct construction."""
        obj1 = HushhConsentToken.model_validate(_MESSY_TOKEN_DATA)
        obj2 = HushhConsentToken(**_MESSY_TOKEN_DATA)
        assert obj1.user_id == obj2.user_id == _MESSY_TOKEN_DATA["user_id"].strip()
