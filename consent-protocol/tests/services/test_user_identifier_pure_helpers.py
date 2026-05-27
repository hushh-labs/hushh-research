"""Behavioral tests for pure functions in user_identifier_service.py.

These functions normalize phone numbers and country hints and resolve the
lookup identifier type used throughout the user-lookup pipeline. They are
pure (no DB / network / auth required) — phonenumbers and pycountry are
the only dependencies.

Coverage:
- normalize_country_hint — ISO-2 passthrough, alias expansion (UK→GB, USA→US,
  UAE→AE), full country name lookup, invalid/empty → None
- _extract_country_prefixed_phone — "Country: +number" pattern extraction,
  no-match passthrough, empty string
- normalize_phone_identifier — E.164 canonical output, tel: prefix stripping,
  country hint via country_iso2 / country, non-digit strings → None,
  non-parseable / invalid numbers → None
- resolve_lookup_identifier — email path (any "@" in raw), phone path (valid
  E.164 output), uid fallback, priority order, ValueError for all-missing
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.user_identifier_service import (
    _extract_country_prefixed_phone,
    normalize_country_hint,
    normalize_phone_identifier,
    resolve_lookup_identifier,
)

# ---------------------------------------------------------------------------
# normalize_country_hint
# ---------------------------------------------------------------------------


class TestNormalizeCountryHint:
    def test_none_returns_none(self):
        assert normalize_country_hint(None) is None

    def test_empty_string_returns_none(self):
        assert normalize_country_hint("") is None

    def test_whitespace_only_returns_none(self):
        assert normalize_country_hint("   ") is None

    def test_valid_iso2_us_returned(self):
        assert normalize_country_hint("US") == "US"

    def test_valid_iso2_gb_returned(self):
        assert normalize_country_hint("GB") == "GB"

    def test_alias_uk_maps_to_gb(self):
        assert normalize_country_hint("UK") == "GB"

    def test_alias_usa_maps_to_us(self):
        assert normalize_country_hint("USA") == "US"

    def test_alias_uae_maps_to_ae(self):
        assert normalize_country_hint("UAE") == "AE"

    def test_full_country_name_united_states(self):
        assert normalize_country_hint("United States") == "US"

    def test_full_country_name_india(self):
        assert normalize_country_hint("India") == "IN"

    def test_full_country_name_germany(self):
        assert normalize_country_hint("Germany") == "DE"

    def test_unrecognized_string_returns_none(self):
        assert normalize_country_hint("Narnia") is None

    def test_lowercase_iso2_accepted(self):
        assert normalize_country_hint("us") == "US"

    def test_mixed_case_alias_accepted(self):
        assert normalize_country_hint("Uk") == "GB"


# ---------------------------------------------------------------------------
# _extract_country_prefixed_phone
# ---------------------------------------------------------------------------


class TestExtractCountryPrefixedPhone:
    def test_empty_string_returns_none_and_empty(self):
        region, phone = _extract_country_prefixed_phone("")
        assert region is None
        assert phone == ""

    def test_plain_phone_no_prefix_returns_none_and_original(self):
        region, phone = _extract_country_prefixed_phone("+14155552671")
        assert region is None
        assert phone == "+14155552671"

    def test_country_colon_phone_pattern_extracted(self):
        region, phone = _extract_country_prefixed_phone("US: +14155552671")
        assert region == "US"
        assert "+14155552671" in phone

    def test_country_comma_phone_pattern_extracted(self):
        region, phone = _extract_country_prefixed_phone("India, 9876543210")
        assert region == "IN"

    def test_unrecognized_country_prefix_returns_none_and_original(self):
        region, phone = _extract_country_prefixed_phone("Narnia: +12345678")
        assert region is None


# ---------------------------------------------------------------------------
# normalize_phone_identifier
# ---------------------------------------------------------------------------


class TestNormalizePhoneIdentifier:
    def test_none_returns_none(self):
        assert normalize_phone_identifier(None) is None

    def test_empty_returns_none(self):
        assert normalize_phone_identifier("") is None

    def test_us_e164_accepted(self):
        result = normalize_phone_identifier("+14155552671")
        assert result == "+14155552671"

    def test_us_local_with_country_iso2(self):
        result = normalize_phone_identifier("4155552671", country_iso2="US")
        assert result == "+14155552671"

    def test_us_local_with_country_name(self):
        result = normalize_phone_identifier("4155552671", country="United States")
        assert result == "+14155552671"

    def test_tel_prefix_stripped(self):
        result = normalize_phone_identifier("tel:+14155552671")
        assert result == "+14155552671"

    def test_tel_prefix_uppercase_stripped(self):
        # candidate.lower().startswith("tel:") — so uppercase TEL: is also stripped
        result = normalize_phone_identifier("TEL:+14155552671")
        assert result == "+14155552671"

    def test_non_digit_string_returns_none(self):
        assert normalize_phone_identifier("not-a-number") is None

    def test_pure_alpha_returns_none(self):
        assert normalize_phone_identifier("ABCDEFGHIJ") is None

    def test_no_region_no_plus_returns_none(self):
        # Cannot parse local number without region context
        assert normalize_phone_identifier("4155552671") is None

    def test_invalid_number_returns_none(self):
        # Too short to be valid
        assert normalize_phone_identifier("+1415") is None

    def test_indian_number_e164(self):
        result = normalize_phone_identifier("+919876543210")
        assert result == "+919876543210"

    def test_uk_number_with_country_iso2(self):
        result = normalize_phone_identifier("07911123456", country_iso2="GB")
        assert result is not None
        assert result.startswith("+44")

    def test_whitespace_in_number_handled(self):
        result = normalize_phone_identifier("+1 415 555 2671")
        assert result == "+14155552671"


# ---------------------------------------------------------------------------
# resolve_lookup_identifier
# ---------------------------------------------------------------------------


class TestResolveLookupIdentifier:
    def test_all_none_raises_value_error(self):
        with pytest.raises(ValueError, match="Missing lookup identifier"):
            resolve_lookup_identifier(identifier=None, email=None, phone_number=None)

    def test_all_empty_raises_value_error(self):
        with pytest.raises(ValueError):
            resolve_lookup_identifier(identifier="", email="", phone_number="")

    def test_email_in_identifier_returns_email_type(self):
        kind, value = resolve_lookup_identifier(
            identifier="user@example.com", email=None, phone_number=None
        )
        assert kind == "email"
        assert value == "user@example.com"

    def test_email_field_returns_email_type(self):
        kind, value = resolve_lookup_identifier(
            identifier=None, email="user@example.com", phone_number=None
        )
        assert kind == "email"
        assert value == "user@example.com"

    def test_email_lowercased(self):
        _, value = resolve_lookup_identifier(
            identifier="User@EXAMPLE.COM", email=None, phone_number=None
        )
        assert value == "user@example.com"

    def test_phone_number_field_returns_phone_type(self):
        kind, value = resolve_lookup_identifier(
            identifier=None, email=None, phone_number="+14155552671"
        )
        assert kind == "phone"
        assert value == "+14155552671"

    def test_valid_phone_in_identifier_returns_phone_type(self):
        kind, value = resolve_lookup_identifier(
            identifier="+14155552671", email=None, phone_number=None
        )
        assert kind == "phone"
        assert value == "+14155552671"

    def test_identifier_takes_priority_over_email(self):
        kind, value = resolve_lookup_identifier(
            identifier="user@example.com",
            email="other@example.com",
            phone_number=None,
        )
        assert value == "user@example.com"

    def test_identifier_takes_priority_over_phone(self):
        kind, _ = resolve_lookup_identifier(
            identifier="user@example.com",
            email=None,
            phone_number="+14155552671",
        )
        assert kind == "email"

    def test_uid_fallback_for_non_email_non_phone(self):
        kind, value = resolve_lookup_identifier(
            identifier="firebase_uid_abc123xyz", email=None, phone_number=None
        )
        assert kind == "uid"
        assert value == "firebase_uid_abc123xyz"

    def test_phone_with_country_iso2(self):
        kind, value = resolve_lookup_identifier(
            identifier="4155552671",
            email=None,
            phone_number=None,
            country_iso2="US",
        )
        assert kind == "phone"
        assert value == "+14155552671"

    def test_whitespace_identifier_falls_through_to_email(self):
        kind, value = resolve_lookup_identifier(
            identifier="   ", email="user@example.com", phone_number=None
        )
        assert kind == "email"
        assert value == "user@example.com"
