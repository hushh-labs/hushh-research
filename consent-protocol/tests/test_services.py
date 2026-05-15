"""Hermetic unit tests for ConsentCenterService._scrub_sensitive_data.

All methods under test are @staticmethod with no I/O.
No DB, no network, no LLM.

Covers:
    _scrub_sensitive_data   — email masking, phone masking, passthrough,
                              nested dict recursion, original not mutated
    _developer_email        — returns masked email after _scrub_sensitive_data
                              integration (attachment proof)

Integrated by Abdul Gaffar — canonical consent surface.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.consent_center_service import ConsentCenterService

SVC = ConsentCenterService


# ===========================================================================
# _scrub_sensitive_data — email masking
# ===========================================================================


class TestScrubSensitiveDataEmail:
    def test_standard_email_masked(self):
        result = SVC._scrub_sensitive_data({"email": "alice@example.com"})
        assert result["email"] != "alice@example.com"
        assert "***" in result["email"]
        assert "@example.com" in result["email"]

    def test_developer_contact_email_masked(self):
        result = SVC._scrub_sensitive_data(
            {"developer_contact_email": "dev@hushh.ai"}
        )
        assert "dev@hushh.ai" not in result["developer_contact_email"]
        assert "***" in result["developer_contact_email"]

    def test_counterpart_email_masked(self):
        result = SVC._scrub_sensitive_data(
            {"counterpart_email": "bob@corp.com"}
        )
        assert result["counterpart_email"] != "bob@corp.com"
        assert "@corp.com" in result["counterpart_email"]

    def test_long_local_part_preserves_first_last_char(self):
        result = SVC._scrub_sensitive_data({"email": "alice@x.io"})
        masked = result["email"]
        assert masked.startswith("a")
        assert "***" in masked
        assert masked.endswith("@x.io")

    def test_short_local_part_fully_masked(self):
        result = SVC._scrub_sensitive_data({"email": "ab@x.io"})
        masked = result["email"]
        assert "***" in masked
        assert "@x.io" in masked

    def test_email_without_at_sign_becomes_stars(self):
        result = SVC._scrub_sensitive_data({"email": "notanemail"})
        assert result["email"] == "***"

    def test_owner_email_masked(self):
        result = SVC._scrub_sensitive_data({"owner_email": "owner@company.com"})
        assert "owner@company.com" not in result["owner_email"]


# ===========================================================================
# _scrub_sensitive_data — phone masking
# ===========================================================================


class TestScrubSensitiveDataPhone:
    def test_phone_last_four_preserved(self):
        result = SVC._scrub_sensitive_data({"phone": "+15551234567"})
        masked = result["phone"]
        assert "****" in masked
        assert masked.endswith("4567")

    def test_phone_number_key_masked(self):
        result = SVC._scrub_sensitive_data({"phone_number": "8005550199"})
        assert "8005550199" not in result["phone_number"]
        assert result["phone_number"].endswith("0199")

    def test_mobile_key_masked(self):
        result = SVC._scrub_sensitive_data({"mobile": "5559876543"})
        assert "5559876543" not in result["mobile"]

    def test_short_phone_becomes_stars(self):
        result = SVC._scrub_sensitive_data({"phone": "123"})
        assert result["phone"] == "****"


# ===========================================================================
# _scrub_sensitive_data — passthrough and non-PII fields
# ===========================================================================


class TestScrubSensitiveDataPassthrough:
    def test_non_pii_string_unchanged(self):
        result = SVC._scrub_sensitive_data({"scope": "pkm.read", "agent_id": "dev_123"})
        assert result["scope"] == "pkm.read"
        assert result["agent_id"] == "dev_123"

    def test_integer_value_unchanged(self):
        result = SVC._scrub_sensitive_data({"amount": 42, "count": 0})
        assert result == {"amount": 42, "count": 0}

    def test_none_value_unchanged(self):
        result = SVC._scrub_sensitive_data({"email": None, "scope": "pkm.read"})
        assert result["email"] is None
        assert result["scope"] == "pkm.read"

    def test_empty_string_unchanged(self):
        result = SVC._scrub_sensitive_data({"email": ""})
        assert result["email"] == ""

    def test_empty_dict_returns_empty_dict(self):
        assert SVC._scrub_sensitive_data({}) == {}

    def test_mixed_payload_scrubs_only_pii_keys(self):
        data = {
            "scope": "attr.financial.read",
            "email": "alice@example.com",
            "phone": "5551234567",
            "agent_id": "ria:firm_001",
            "amount": 100,
        }
        result = SVC._scrub_sensitive_data(data)
        assert result["scope"] == "attr.financial.read"
        assert result["agent_id"] == "ria:firm_001"
        assert result["amount"] == 100
        assert "alice@example.com" not in result["email"]
        assert "5551234567" not in result["phone"]

    def test_bool_value_unchanged(self):
        result = SVC._scrub_sensitive_data({"active": True, "verified": False})
        assert result == {"active": True, "verified": False}


# ===========================================================================
# _scrub_sensitive_data — immutability and nested dicts
# ===========================================================================


class TestScrubSensitiveDataImmutability:
    def test_original_dict_not_mutated(self):
        original = {"email": "alice@example.com", "scope": "pkm.read"}
        snapshot = dict(original)
        SVC._scrub_sensitive_data(original)
        assert original == snapshot

    def test_nested_dict_email_scrubbed(self):
        data = {"metadata": {"email": "inner@example.com", "count": 3}}
        result = SVC._scrub_sensitive_data(data)
        assert "inner@example.com" not in result["metadata"]["email"]
        assert result["metadata"]["count"] == 3

    def test_returns_new_dict_not_same_object(self):
        original = {"scope": "pkm.read"}
        result = SVC._scrub_sensitive_data(original)
        assert result is not original


# ===========================================================================
# _developer_email — attachment proof: scrubbing is active
# ===========================================================================


class TestDeveloperEmailScrubbed:
    def test_developer_contact_email_is_masked(self):
        metadata = {"developer_contact_email": "contact@brand.com"}
        result = SVC._developer_email(metadata)
        assert result is not None
        assert "contact@brand.com" not in result
        assert "***" in result
        assert "@brand.com" in result

    def test_contact_email_fallback_masked(self):
        metadata = {"contact_email": "admin@example.com"}
        result = SVC._developer_email(metadata)
        assert result is not None
        assert "admin@example.com" not in result
        assert "***" in result

    def test_owner_email_fallback_masked(self):
        result = SVC._developer_email({"owner_email": "owner@firm.com"})
        assert result is not None
        assert "owner@firm.com" not in result

    def test_no_email_returns_none(self):
        assert SVC._developer_email({}) is None
        assert SVC._developer_email({"scope": "pkm.read"}) is None

    def test_masked_email_still_looks_like_email(self):
        result = SVC._developer_email({"contact_email": "alice@corp.io"})
        assert result is not None
        assert "@corp.io" in result

    @pytest.mark.parametrize(
        "raw_email",
        [
            "alice@example.com",
            "dev@hushh.ai",
            "contact@partner.org",
        ],
    )
    def test_various_emails_all_masked(self, raw_email: str):
        result = SVC._developer_email({"developer_contact_email": raw_email})
        assert result is not None
        assert raw_email not in result
        assert "***" in result
