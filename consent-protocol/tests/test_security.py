"""
Tests for consent-protocol/utils/security.py

Verifies that PII (emails, phone numbers) is masked before values reach
log sinks or debug surfaces, in compliance with the Zero-Knowledge principle.
"""

from __future__ import annotations

import re

import pytest

from hushh_mcp.consent.pii_sanitizer import (
    mask_email,
    mask_phone,
    sanitize_log_value,
    sanitize_payload,
)

# ---------------------------------------------------------------------------
# mask_email
# ---------------------------------------------------------------------------


class TestMaskEmail:
    def test_standard_email_masked(self):
        assert mask_email("alice@example.com") == "a***e@example.com"

    def test_masked_email_contains_stars(self):
        # Verify masking always inserts asterisks (re confirms the pattern).
        assert re.search(r"\*+", mask_email("alice@example.com")) is not None

    def test_first_and_last_local_char_preserved(self):
        result = mask_email("john.doe@hushh.ai")
        assert result.startswith("j")
        assert "***" in result
        assert result.endswith("@hushh.ai")

    def test_short_local_part_fully_masked(self):
        # Local part ≤ 2 chars → entire local replaced with *
        assert mask_email("ab@x.io") == "*@x.io"

    def test_single_char_local_part(self):
        assert mask_email("a@b.com") == "*@b.com"

    def test_email_embedded_in_sentence(self):
        result = mask_email("Contact support@hushh.ai for help.")
        assert "support@hushh.ai" not in result
        assert "@hushh.ai" in result
        assert "***" in result

    def test_multiple_emails_in_string(self):
        result = mask_email("From: alice@a.com To: bob@b.com")
        assert "alice@a.com" not in result
        assert "bob@b.com" not in result
        assert result.count("***") == 2

    def test_no_email_returns_unchanged(self):
        s = "no personal data here"
        assert mask_email(s) == s

    def test_empty_string(self):
        assert mask_email("") == ""

    def test_subdomain_email(self):
        result = mask_email("user@mail.hushh.ai")
        assert "@mail.hushh.ai" in result
        assert "user@" not in result

    def test_plus_addressing(self):
        result = mask_email("alice+tag@example.com")
        assert "alice+tag@example.com" not in result
        assert "@example.com" in result


# ---------------------------------------------------------------------------
# mask_phone
# ---------------------------------------------------------------------------


class TestMaskPhone:
    def test_e164_format(self):
        result = mask_phone("+15551234567")
        assert "+15551234567" not in result
        assert "****" in result
        assert result.endswith("4567")

    def test_hyphenated_format(self):
        result = mask_phone("+1-555-123-4567")
        assert "+1-555-123-4567" not in result
        assert "****" in result
        assert result.endswith("4567")

    def test_parentheses_format(self):
        result = mask_phone("(800) 555-0199")
        assert "(800) 555-0199" not in result
        assert "****" in result
        assert result.endswith("0199")

    def test_no_phone_returns_unchanged(self):
        s = "no phone data here"
        assert mask_phone(s) == s

    def test_empty_string(self):
        assert mask_phone("") == ""

    def test_multiple_phones_in_string(self):
        result = mask_phone("Call +15551234567 or +442079460958.")
        assert "+15551234567" not in result
        assert "+442079460958" not in result
        assert result.count("****") == 2

    def test_phone_in_sentence(self):
        result = mask_phone("Reach us at +1-800-555-0100 any time.")
        assert "+1-800-555-0100" not in result
        assert "****" in result

    def test_short_digit_sequence_not_matched(self):
        # A 4-digit number like a PIN or year should not be treated as a phone
        assert mask_phone("Year 2026") == "Year 2026"


# ---------------------------------------------------------------------------
# sanitize_log_value
# ---------------------------------------------------------------------------


class TestSanitizeLogValue:
    def test_masks_email_and_phone_together(self):
        raw = "user alice@hushh.ai called from +15551234567"
        result = sanitize_log_value(raw)
        assert "alice@hushh.ai" not in result
        assert "+15551234567" not in result
        assert "***" in result
        assert "****" in result

    def test_plain_string_unchanged(self):
        s = "request processed successfully"
        assert sanitize_log_value(s) == s

    def test_empty_string(self):
        assert sanitize_log_value("") == ""


# ---------------------------------------------------------------------------
# sanitize_payload
# ---------------------------------------------------------------------------


class TestSanitizePayload:
    def test_email_field_masked(self):
        out = sanitize_payload({"email": "alice@example.com"})
        assert out["email"] != "alice@example.com"
        assert "***" in out["email"]

    def test_non_pii_scalar_unchanged(self):
        out = sanitize_payload({"amount": 42, "active": True, "note": None})
        assert out == {"amount": 42, "active": True, "note": None}

    def test_nested_dict_sanitized(self):
        out = sanitize_payload(
            {"user": {"email": "bob@example.com", "score": 99}}
        )
        assert "bob@example.com" not in out["user"]["email"]
        assert out["user"]["score"] == 99

    def test_list_of_strings_sanitized(self):
        out = sanitize_payload(
            {"contacts": ["alice@example.com", "bob@example.com"]}
        )
        for item in out["contacts"]:
            assert "@example.com" in item
            assert "***" in item

    def test_original_payload_not_mutated(self):
        original = {"email": "alice@example.com"}
        sanitize_payload(original)
        assert original["email"] == "alice@example.com"

    def test_empty_payload(self):
        assert sanitize_payload({}) == {}

    def test_mixed_payload(self):
        out = sanitize_payload(
            {
                "userId": "usr_123",
                "email": "dev@hushh.ai",
                "phone": "+15559876543",
                "requestId": "req_abc",
                "amount": 100,
            }
        )
        assert "dev@hushh.ai" not in out["email"]
        assert "+15559876543" not in out["phone"]
        assert out["requestId"] == "req_abc"
        assert out["amount"] == 100

    def test_deeply_nested_payload(self):
        out = sanitize_payload(
            {"level1": {"level2": {"email": "deep@example.com"}}}
        )
        assert "deep@example.com" not in out["level1"]["level2"]["email"]

    def test_list_of_dicts_sanitized(self):
        out = sanitize_payload(
            {
                "users": [
                    {"email": "alice@example.com"},
                    {"email": "bob@example.com"},
                ]
            }
        )
        for user in out["users"]:
            assert "***" in user["email"]

    @pytest.mark.parametrize(
        "email",
        [
            "user@domain.com",
            "first.last@subdomain.org",
            "user+tag@hushh.ai",
        ],
    )
    def test_various_email_formats_masked(self, email: str):
        out = sanitize_payload({"email": email})
        assert email not in out["email"]
        assert "***" in out["email"]
