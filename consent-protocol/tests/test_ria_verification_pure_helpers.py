"""Behavioral tests for pure module-level helpers in ria_verification.

These helpers sit at the boundary of regulatory identity verification
(CRD normalization, stage1 path/URL canonicalization, rejection-reason
classification, and official-source detection). None had test coverage.

All functions are pure / side-effect-free — no network or DB required.
"""

from __future__ import annotations

from hushh_mcp.services.ria_verification import (
    _contains_official_regulator_source,
    _normalize_crd,
    _normalize_identity_text,
    _normalize_stage1_path,
    _normalize_stage1_url,
    _reason_code_from_provider_reason,
)

# ---------------------------------------------------------------------------
# _normalize_identity_text
# ---------------------------------------------------------------------------


class TestNormalizeIdentityText:
    def test_lowercases_input(self):
        assert _normalize_identity_text("JOHN DOE") == "john doe"

    def test_replaces_non_alphanumeric_with_space(self):
        assert _normalize_identity_text("Smith, Jr.") == "smith jr"

    def test_collapses_multiple_separators(self):
        assert _normalize_identity_text("ABC---DEF") == "abc def"

    def test_strips_leading_trailing_whitespace(self):
        assert _normalize_identity_text("  alice  ") == "alice"

    def test_none_returns_empty_string(self):
        assert _normalize_identity_text(None) == ""

    def test_empty_string_returns_empty_string(self):
        assert _normalize_identity_text("") == ""

    def test_digits_preserved(self):
        assert _normalize_identity_text("CRD12345") == "crd12345"

    def test_mixed_punctuation_collapsed(self):
        result = _normalize_identity_text("O'Brien & Associates LLC")
        assert result == "o brien associates llc"


# ---------------------------------------------------------------------------
# _normalize_crd
# ---------------------------------------------------------------------------


class TestNormalizeCrd:
    def test_digits_only_returned_unchanged(self):
        assert _normalize_crd("1234567") == "1234567"

    def test_strips_non_digit_characters(self):
        assert _normalize_crd("CRD-1234567") == "1234567"

    def test_strips_spaces(self):
        assert _normalize_crd("123 456") == "123456"

    def test_none_returns_empty_string(self):
        assert _normalize_crd(None) == ""

    def test_empty_string_returns_empty_string(self):
        assert _normalize_crd("") == ""

    def test_all_letters_returns_empty_string(self):
        assert _normalize_crd("ABC") == ""

    def test_hash_prefixed_crd(self):
        assert _normalize_crd("#7654321") == "7654321"

    def test_preserves_leading_zeros(self):
        assert _normalize_crd("007890") == "007890"


# ---------------------------------------------------------------------------
# _normalize_stage1_path
# ---------------------------------------------------------------------------


class TestNormalizeStage1Path:
    def test_none_returns_default_path(self):
        assert _normalize_stage1_path(None) == "/v1/ria/profile/stage1"

    def test_empty_returns_default_path(self):
        assert _normalize_stage1_path("") == "/v1/ria/profile/stage1"

    def test_whitespace_only_returns_default_path(self):
        assert _normalize_stage1_path("   ") == "/v1/ria/profile/stage1"

    def test_path_without_leading_slash_gets_slash_prepended(self):
        result = _normalize_stage1_path("v1/ria/profile/stage1")
        assert result == "/v1/ria/profile/stage1"

    def test_profile_path_without_stage1_gets_stage1_appended(self):
        assert _normalize_stage1_path("/v1/ria/profile") == "/v1/ria/profile/stage1"

    def test_profile_path_with_trailing_slash_also_fixed(self):
        assert _normalize_stage1_path("/v1/ria/profile/") == "/v1/ria/profile/stage1"

    def test_already_correct_path_returned_unchanged(self):
        assert _normalize_stage1_path("/v1/ria/profile/stage1") == "/v1/ria/profile/stage1"

    def test_custom_path_returned_as_is_with_leading_slash(self):
        result = _normalize_stage1_path("custom/endpoint")
        assert result == "/custom/endpoint"


# ---------------------------------------------------------------------------
# _normalize_stage1_url
# ---------------------------------------------------------------------------


class TestNormalizeStage1Url:
    def test_none_returns_empty_string(self):
        assert _normalize_stage1_url(None) == ""

    def test_empty_returns_empty_string(self):
        assert _normalize_stage1_url("") == ""

    def test_url_ending_with_profile_gets_stage1_appended(self):
        result = _normalize_stage1_url("https://api.example.com/v1/ria/profile")
        assert result == "https://api.example.com/v1/ria/profile/stage1"

    def test_url_with_trailing_slash_also_fixed(self):
        result = _normalize_stage1_url("https://api.example.com/v1/ria/profile/")
        assert result == "https://api.example.com/v1/ria/profile/stage1"

    def test_url_already_containing_stage1_returned_unchanged(self):
        url = "https://api.example.com/v1/ria/profile/stage1"
        assert _normalize_stage1_url(url) == url

    def test_unrelated_url_returned_unchanged(self):
        url = "https://api.example.com/other/endpoint"
        assert _normalize_stage1_url(url) == url


# ---------------------------------------------------------------------------
# _reason_code_from_provider_reason
# ---------------------------------------------------------------------------


class TestReasonCodeFromProviderReason:
    def test_none_returns_no_confident_match(self):
        assert _reason_code_from_provider_reason(None) == "no_confident_match"

    def test_empty_returns_no_confident_match(self):
        assert _reason_code_from_provider_reason("") == "no_confident_match"

    def test_too_broad_marker_returns_query_too_broad(self):
        assert _reason_code_from_provider_reason("Query is too broad") == "query_too_broad"

    def test_insufficiently_specific_returns_query_too_broad(self):
        result = _reason_code_from_provider_reason("Name is insufficiently specific")
        assert result == "query_too_broad"

    def test_more_specific_returns_query_too_broad(self):
        assert (
            _reason_code_from_provider_reason("Please provide more specific information")
            == "query_too_broad"
        )

    def test_full_last_name_returns_query_too_broad(self):
        assert _reason_code_from_provider_reason("Provide full last name") == "query_too_broad"

    def test_full_legal_name_returns_query_too_broad(self):
        assert _reason_code_from_provider_reason("Full legal name required") == "query_too_broad"

    def test_firm_context_returns_query_too_broad(self):
        assert _reason_code_from_provider_reason("Please provide firm context") == "query_too_broad"

    def test_confidently_identify_marker_returns_query_too_broad(self):
        result = _reason_code_from_provider_reason(
            "Could not confidently identify a single adviser"
        )
        assert result == "query_too_broad"

    def test_case_insensitive_matching(self):
        assert _reason_code_from_provider_reason("TOO BROAD") == "query_too_broad"

    def test_unrecognized_reason_returns_no_confident_match(self):
        assert _reason_code_from_provider_reason("Record not found") == "no_confident_match"

    def test_generic_failure_returns_no_confident_match(self):
        assert _reason_code_from_provider_reason("Internal server error") == "no_confident_match"


# ---------------------------------------------------------------------------
# _contains_official_regulator_source
# ---------------------------------------------------------------------------


class TestContainsOfficialRegulatorSource:
    def test_empty_payload_returns_false(self):
        assert _contains_official_regulator_source({}) is False

    def test_no_verified_profiles_key_returns_false(self):
        assert _contains_official_regulator_source({"other_key": []}) is False

    def test_non_list_verified_profiles_returns_false(self):
        assert _contains_official_regulator_source({"verified_profiles": "not-a-list"}) is False

    def test_empty_list_returns_false(self):
        assert _contains_official_regulator_source({"verified_profiles": []}) is False

    def test_brokercheck_finra_url_detected(self):
        payload = {"verified_profiles": [{"url": "https://brokercheck.finra.org/individual/12345"}]}
        assert _contains_official_regulator_source(payload) is True

    def test_adviserinfo_sec_url_detected(self):
        payload = {"verified_profiles": [{"url": "https://adviserinfo.sec.gov/individual/12345"}]}
        assert _contains_official_regulator_source(payload) is True

    def test_sec_gov_url_detected(self):
        payload = {"verified_profiles": [{"url": "https://www.sec.gov/cgi-bin/browse-edgar"}]}
        assert _contains_official_regulator_source(payload) is True

    def test_source_url_field_also_checked(self):
        payload = {"verified_profiles": [{"source_url": "https://brokercheck.finra.org/x"}]}
        assert _contains_official_regulator_source(payload) is True

    def test_finra_label_detected(self):
        payload = {"verified_profiles": [{"label": "FINRA BrokerCheck", "url": ""}]}
        assert _contains_official_regulator_source(payload) is True

    def test_sec_label_detected(self):
        payload = {"verified_profiles": [{"label": "SEC EDGAR", "url": ""}]}
        assert _contains_official_regulator_source(payload) is True

    def test_brokercheck_label_detected(self):
        payload = {"verified_profiles": [{"platform": "BrokerCheck", "url": ""}]}
        assert _contains_official_regulator_source(payload) is True

    def test_non_regulator_source_returns_false(self):
        payload = {
            "verified_profiles": [{"url": "https://linkedin.com/in/someone", "label": "LinkedIn"}]
        }
        assert _contains_official_regulator_source(payload) is False

    def test_non_dict_item_skipped(self):
        payload = {"verified_profiles": ["not-a-dict", {"url": "https://sec.gov/x"}]}
        assert _contains_official_regulator_source(payload) is True

    def test_first_matching_item_short_circuits(self):
        payload = {
            "verified_profiles": [
                {"url": "https://brokercheck.finra.org/x"},
                {"url": "https://linkedin.com/in/other"},
            ]
        }
        assert _contains_official_regulator_source(payload) is True
