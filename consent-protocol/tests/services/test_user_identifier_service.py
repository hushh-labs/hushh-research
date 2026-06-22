"""Behavioral tests for user_identifier_service.

Covers:
- normalize_country_hint: ISO-2 pass-through, common aliases (UK→GB, UAE→AE,
  USA→US), full country names via pycountry, invalid/empty inputs
- normalize_phone_identifier: E.164 pass-through, national numbers with
  country hint, tel: prefix stripping, country-prefixed strings
  ("India: 98765…"), rejection of non-phone strings, rejection of national
  numbers with no region hint
- resolve_lookup_identifier: email routing (lowercased), phone routing
  (E.164 normalised), UID fall-through, ValueError on empty inputs
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.user_identifier_service import (
    normalize_country_hint,
    normalize_phone_identifier,
    resolve_lookup_identifier,
)

# ---------------------------------------------------------------------------
# normalize_country_hint
# ---------------------------------------------------------------------------


def test_normalize_country_hint_iso2_passthrough():
    assert normalize_country_hint("US") == "US"
    assert normalize_country_hint("DE") == "DE"
    assert normalize_country_hint("IN") == "IN"


def test_normalize_country_hint_uk_alias_maps_to_gb():
    assert normalize_country_hint("UK") == "GB"


def test_normalize_country_hint_uae_alias_maps_to_ae():
    assert normalize_country_hint("UAE") == "AE"


def test_normalize_country_hint_usa_alias_maps_to_us():
    assert normalize_country_hint("USA") == "US"


def test_normalize_country_hint_alias_is_case_insensitive():
    assert normalize_country_hint("uk") == "GB"
    assert normalize_country_hint("Uk") == "GB"


def test_normalize_country_hint_full_name_united_states():
    assert normalize_country_hint("United States") == "US"


def test_normalize_country_hint_full_name_germany():
    assert normalize_country_hint("Germany") == "DE"


def test_normalize_country_hint_empty_string_returns_none():
    assert normalize_country_hint("") is None


def test_normalize_country_hint_none_returns_none():
    assert normalize_country_hint(None) is None


def test_normalize_country_hint_invalid_code_returns_none():
    assert normalize_country_hint("ZZ") is None


def test_normalize_country_hint_gibberish_returns_none():
    assert normalize_country_hint("not-a-country") is None


# ---------------------------------------------------------------------------
# normalize_phone_identifier
# ---------------------------------------------------------------------------


def test_normalize_phone_e164_passthrough():
    assert normalize_phone_identifier("+14155552671") == "+14155552671"


def test_normalize_phone_national_with_iso2_country_hint():
    result = normalize_phone_identifier("4155552671", country_iso2="US")
    assert result == "+14155552671"


def test_normalize_phone_national_with_full_country_name():
    result = normalize_phone_identifier("4155552671", country="United States")
    assert result == "+14155552671"


def test_normalize_phone_strips_tel_prefix():
    result = normalize_phone_identifier("tel:+14155552671")
    assert result == "+14155552671"


def test_normalize_phone_strips_tel_prefix_with_spaces():
    result = normalize_phone_identifier("tel: +14155552671")
    assert result == "+14155552671"


def test_normalize_phone_country_prefixed_string():
    # "India: <number>" — region extracted from prefix token
    result = normalize_phone_identifier("India: 9876543210")
    assert result is not None
    assert result.startswith("+91")


def test_normalize_phone_uk_alias_in_prefix():
    result = normalize_phone_identifier("UK: 7911123456")
    assert result is not None
    assert result.startswith("+44")


def test_normalize_phone_empty_returns_none():
    assert normalize_phone_identifier("") is None
    assert normalize_phone_identifier(None) is None


def test_normalize_phone_national_no_country_hint_returns_none():
    # National number with no + and no region → cannot resolve
    assert normalize_phone_identifier("4155552671") is None


def test_normalize_phone_non_phone_string_returns_none():
    assert normalize_phone_identifier("not-a-phone") is None
    assert normalize_phone_identifier("hello world") is None


def test_normalize_phone_formatted_us_number_with_hint():
    result = normalize_phone_identifier("+1 (415) 555-2671")
    assert result == "+14155552671"


# ---------------------------------------------------------------------------
# resolve_lookup_identifier
# ---------------------------------------------------------------------------


def test_resolve_email_via_identifier_param():
    kind, value = resolve_lookup_identifier(
        identifier="user@example.com",
        email=None,
        phone_number=None,
    )
    assert kind == "email"
    assert value == "user@example.com"


def test_resolve_email_is_lowercased():
    kind, value = resolve_lookup_identifier(
        identifier=None,
        email="User@Example.COM",
        phone_number=None,
    )
    assert kind == "email"
    assert value == "user@example.com"


def test_resolve_phone_e164_via_identifier_param():
    kind, value = resolve_lookup_identifier(
        identifier="+14155552671",
        email=None,
        phone_number=None,
    )
    assert kind == "phone"
    assert value == "+14155552671"


def test_resolve_phone_via_phone_number_param():
    kind, value = resolve_lookup_identifier(
        identifier=None,
        email=None,
        phone_number="+447911123456",
    )
    assert kind == "phone"
    assert value == "+447911123456"


def test_resolve_uid_for_non_email_non_phone_string():
    kind, value = resolve_lookup_identifier(
        identifier="firebase-uid-abc123",
        email=None,
        phone_number=None,
    )
    assert kind == "uid"
    assert value == "firebase-uid-abc123"


def test_resolve_identifier_takes_priority_over_email():
    # When both `identifier` and `email` are set, `identifier` wins.
    kind, value = resolve_lookup_identifier(
        identifier="primary@example.com",
        email="secondary@example.com",
        phone_number=None,
    )
    assert value == "primary@example.com"


def test_resolve_email_takes_priority_over_phone():
    kind, value = resolve_lookup_identifier(
        identifier=None,
        email="winner@example.com",
        phone_number="+14155552671",
    )
    assert kind == "email"
    assert value == "winner@example.com"


def test_resolve_raises_on_all_none():
    with pytest.raises(ValueError, match="Missing lookup identifier"):
        resolve_lookup_identifier(identifier=None, email=None, phone_number=None)


def test_resolve_raises_on_all_blank_strings():
    with pytest.raises(ValueError, match="Missing lookup identifier"):
        resolve_lookup_identifier(identifier="  ", email="", phone_number=None)
