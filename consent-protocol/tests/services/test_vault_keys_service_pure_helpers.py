"""
Pure unit tests for the static helper methods on VaultKeysService.

All helpers under test are @staticmethod — they perform pure data
normalization with no DB, no network, and no side effects.  Despite
being on the critical path for every vault setup and key-exchange
operation, they had zero dedicated test coverage before this file.

Methods covered
---------------
VaultKeysService._clean_text(value, *, allow_none=False)
    Strip whitespace; treat "null"/"undefined"/"none" as absent;
    return "" or None depending on allow_none flag.

VaultKeysService._clean_base64ish(value, *, allow_none=False)
    _clean_text + strip all internal whitespace (spaces/tabs/newlines).

VaultKeysService._normalize_method(method)
    Lower-case, validate against ALLOWED_METHODS, raise ValueError for
    unknown methods.

VaultKeysService._normalize_wrapper_id(wrapper_id)
    Strip whitespace, fall back to "default" for blank/None.

VaultKeysService._is_passkey_method(method)
    Return True only for passkey-based method strings.

VaultKeysService._normalize_vault_status(value)
    Coerce to "placeholder" or "active"; default to "active" for unknown.

VaultKeysService._normalize_bool_or_none(value)
    Coerce bool/int/str to bool or return None for unrecognised inputs.

VaultKeysService._normalize_int_ms_or_none(value)
    Coerce int-convertible values to int; None otherwise.

Constants exercised
-------------------
ALLOWED_METHODS  = {"passphrase", "generated_default_native_biometric",
                    "generated_default_web_prf",
                    "generated_default_native_passkey_prf"}
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.vault_keys_service import ALLOWED_METHODS, VaultKeysService

# ---------------------------------------------------------------------------
# Convenience aliases for the static methods under test
# ---------------------------------------------------------------------------
_clean = VaultKeysService._clean_text
_b64 = VaultKeysService._clean_base64ish
_method = VaultKeysService._normalize_method
_wrapper = VaultKeysService._normalize_wrapper_id
_is_passkey = VaultKeysService._is_passkey_method
_status = VaultKeysService._normalize_vault_status
_bool = VaultKeysService._normalize_bool_or_none
_int_ms = VaultKeysService._normalize_int_ms_or_none


# ===========================================================================
# _clean_text
# ===========================================================================


class TestCleanText:
    # --- allow_none=False (default) ----------------------------------------

    def test_normal_string_returned_stripped(self):
        assert _clean("  hello  ") == "hello"

    def test_already_clean_string_unchanged(self):
        assert _clean("hello") == "hello"

    def test_none_returns_empty_string_by_default(self):
        assert _clean(None) == ""

    def test_empty_string_returns_empty_string(self):
        assert _clean("") == ""

    def test_whitespace_only_returns_empty_string(self):
        assert _clean("   ") == ""

    def test_literal_null_returns_empty_string(self):
        assert _clean("null") == ""

    def test_literal_null_case_insensitive(self):
        assert _clean("NULL") == ""
        assert _clean("Null") == ""

    def test_literal_undefined_returns_empty_string(self):
        assert _clean("undefined") == ""

    def test_literal_none_string_returns_empty_string(self):
        assert _clean("none") == ""

    def test_literal_none_case_insensitive(self):
        assert _clean("NONE") == ""

    # --- allow_none=True ---------------------------------------------------

    def test_none_with_allow_none_returns_none(self):
        assert _clean(None, allow_none=True) is None

    def test_empty_string_with_allow_none_returns_none(self):
        assert _clean("", allow_none=True) is None

    def test_whitespace_with_allow_none_returns_none(self):
        assert _clean("   ", allow_none=True) is None

    def test_null_string_with_allow_none_returns_none(self):
        assert _clean("null", allow_none=True) is None

    def test_undefined_with_allow_none_returns_none(self):
        assert _clean("undefined", allow_none=True) is None

    def test_valid_string_with_allow_none_returned_unchanged(self):
        assert _clean("  token123  ", allow_none=True) == "token123"

    def test_preserves_internal_whitespace(self):
        # _clean_text only strips leading/trailing, not internal
        assert _clean("hello world") == "hello world"

    def test_numeric_string_returned(self):
        assert _clean("  42  ") == "42"


# ===========================================================================
# _clean_base64ish
# ===========================================================================


class TestCleanBase64ish:
    def test_strips_all_whitespace(self):
        assert _b64("abc def\tghi\njkl") == "abcdefghijkl"

    def test_normal_base64_string_unchanged(self):
        token = "dGVzdF90b2tlbl92YWx1ZQ=="  # noqa: S105
        assert _b64(token) == token

    def test_none_returns_empty_string_by_default(self):
        assert _b64(None) == ""

    def test_none_with_allow_none_returns_none(self):
        assert _b64(None, allow_none=True) is None

    def test_null_string_returns_empty_string(self):
        assert _b64("null") == ""

    def test_null_string_with_allow_none_returns_none(self):
        assert _b64("null", allow_none=True) is None

    def test_leading_trailing_whitespace_removed(self):
        assert _b64("  abc  ") == "abc"

    def test_base64_with_newlines_cleaned(self):
        # Simulate a PEM-style multi-line base64 blob
        raw = "AAAA\nBBBB\nCCCC"
        assert _b64(raw) == "AAAABBBBCCCC"


# ===========================================================================
# _normalize_method
# ===========================================================================


class TestNormalizeMethod:
    @pytest.mark.parametrize("method", sorted(ALLOWED_METHODS))
    def test_each_allowed_method_accepted(self, method: str):
        assert _method(method) == method

    def test_method_lowercased(self):
        assert _method("Passphrase") == "passphrase"
        assert _method("PASSPHRASE") == "passphrase"

    def test_method_with_whitespace_stripped(self):
        assert _method("  passphrase  ") == "passphrase"

    def test_unknown_method_raises_value_error(self):
        with pytest.raises(ValueError, match="Unsupported vault method"):
            _method("biometrics")

    def test_none_method_raises_value_error(self):
        with pytest.raises(ValueError, match="Unsupported vault method"):
            _method(None)

    def test_empty_string_raises_value_error(self):
        with pytest.raises(ValueError, match="Unsupported vault method"):
            _method("")

    def test_partial_match_raises_value_error(self):
        with pytest.raises(ValueError):
            _method("passphras")

    def test_generated_default_web_prf_accepted(self):
        assert _method("generated_default_web_prf") == "generated_default_web_prf"

    def test_generated_default_native_passkey_prf_accepted(self):
        result = _method("generated_default_native_passkey_prf")
        assert result == "generated_default_native_passkey_prf"


# ===========================================================================
# _normalize_wrapper_id
# ===========================================================================


class TestNormalizeWrapperId:
    def test_normal_wrapper_id_returned(self):
        assert _wrapper("my_wrapper") == "my_wrapper"

    def test_whitespace_stripped(self):
        assert _wrapper("  my_wrapper  ") == "my_wrapper"

    def test_none_returns_default(self):
        assert _wrapper(None) == "default"

    def test_empty_string_returns_default(self):
        assert _wrapper("") == "default"

    def test_whitespace_only_returns_default(self):
        assert _wrapper("   ") == "default"

    def test_literal_default_preserved(self):
        assert _wrapper("default") == "default"

    def test_numeric_id_as_string(self):
        assert _wrapper("12345") == "12345"

    def test_complex_id_preserved(self):
        assert _wrapper("wrapper-v2-passkey") == "wrapper-v2-passkey"


# ===========================================================================
# _is_passkey_method
# ===========================================================================


class TestIsPasskeyMethod:
    def test_web_prf_is_passkey(self):
        assert _is_passkey("generated_default_web_prf") is True

    def test_native_passkey_prf_is_passkey(self):
        assert _is_passkey("generated_default_native_passkey_prf") is True

    def test_passphrase_not_passkey(self):
        assert _is_passkey("passphrase") is False

    def test_native_biometric_not_passkey(self):
        assert _is_passkey("generated_default_native_biometric") is False

    def test_unknown_string_not_passkey(self):
        assert _is_passkey("face_id") is False

    def test_empty_string_not_passkey(self):
        assert _is_passkey("") is False


# ===========================================================================
# _normalize_vault_status
# ===========================================================================


class TestNormalizeVaultStatus:
    def test_placeholder_preserved(self):
        assert _status("placeholder") == "placeholder"

    def test_active_preserved(self):
        assert _status("active") == "active"

    def test_none_defaults_to_active(self):
        assert _status(None) == "active"

    def test_empty_string_defaults_to_active(self):
        assert _status("") == "active"

    def test_unknown_value_defaults_to_active(self):
        assert _status("suspended") == "active"
        assert _status("pending") == "active"

    def test_uppercase_lowercased_before_check(self):
        # Implementation does .lower() before the set check, so uppercase variants
        # ARE recognized: "ACTIVE" → "active", "PLACEHOLDER" → "placeholder"
        assert _status("ACTIVE") == "active"
        assert _status("PLACEHOLDER") == "placeholder"

    def test_whitespace_stripped(self):
        assert _status("  active  ") == "active"
        assert _status("  placeholder  ") == "placeholder"


# ===========================================================================
# _normalize_bool_or_none
# ===========================================================================


class TestNormalizeBoolOrNone:
    # --- bool passthrough --------------------------------------------------
    def test_true_returned(self):
        assert _bool(True) is True

    def test_false_returned(self):
        assert _bool(False) is False

    # --- None passthrough --------------------------------------------------
    def test_none_returned(self):
        assert _bool(None) is None

    # --- int coercion ------------------------------------------------------
    def test_int_1_is_true(self):
        assert _bool(1) is True

    def test_int_0_is_false(self):
        assert _bool(0) is False

    def test_int_nonzero_is_true(self):
        assert _bool(42) is True

    def test_float_nonzero_is_true(self):
        assert _bool(1.5) is True

    def test_float_zero_is_false(self):
        assert _bool(0.0) is False

    # --- string coercion ---------------------------------------------------
    def test_string_true_is_true(self):
        assert _bool("true") is True

    def test_string_true_case_insensitive(self):
        assert _bool("True") is True
        assert _bool("TRUE") is True

    def test_string_1_is_true(self):
        assert _bool("1") is True

    def test_string_yes_is_true(self):
        assert _bool("yes") is True

    def test_string_false_is_false(self):
        assert _bool("false") is False

    def test_string_false_case_insensitive(self):
        assert _bool("False") is False
        assert _bool("FALSE") is False

    def test_string_0_is_false(self):
        assert _bool("0") is False

    def test_string_no_is_false(self):
        assert _bool("no") is False

    def test_unrecognised_string_returns_none(self):
        assert _bool("maybe") is None
        assert _bool("") is None
        assert _bool("nope") is None

    def test_list_returns_none(self):
        assert _bool([]) is None

    def test_dict_returns_none(self):
        assert _bool({}) is None


# ===========================================================================
# _normalize_int_ms_or_none
# ===========================================================================


class TestNormalizeIntMsOrNone:
    def test_none_returns_none(self):
        assert _int_ms(None) is None

    def test_int_returned_as_int(self):
        assert _int_ms(1_700_000_000_000) == 1_700_000_000_000

    def test_float_truncated_to_int(self):
        assert _int_ms(1_700_000_000_000.9) == 1_700_000_000_000

    def test_zero_returned(self):
        assert _int_ms(0) == 0

    def test_string_int_coerced(self):
        assert _int_ms("1700000000000") == 1_700_000_000_000

    def test_string_float_returns_none(self):
        # int("1700000000000.5") raises ValueError (Python can't int() a float string),
        # so the function returns None rather than truncating
        assert _int_ms("1700000000000.5") is None

    def test_non_numeric_string_returns_none(self):
        assert _int_ms("not_a_number") is None

    def test_empty_string_returns_none(self):
        assert _int_ms("") is None

    def test_list_returns_none(self):
        assert _int_ms([1, 2, 3]) is None

    def test_dict_returns_none(self):
        assert _int_ms({"ts": 123}) is None

    def test_negative_int_returned(self):
        assert _int_ms(-1) == -1
