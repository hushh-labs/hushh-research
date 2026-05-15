"""Pure-helper unit tests for hushh_mcp/services/receipt_memory_service.py.

All tests are hermetic: no database, no network, no LLM required.
Covers every module-level helper function in the file.
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta, timezone

import pytest

from hushh_mcp.services.receipt_memory_service import (
    _canonicalize_merchant,
    _clean_text,
    _clip_text,
    _dedupe_strings,
    _email_domain_root,
    _format_dt_iso,
    _format_pattern_label,
    _json_object,
    _median,
    _merchant_id_from_label,
    _parse_dt,
    _safe_float,
    _safe_int,
    _sha256_json,
    _sha256_text,
    _top_currency_summary,
)

# ---------------------------------------------------------------------------
# _clean_text
# ---------------------------------------------------------------------------


class TestCleanText:
    def test_plain_string(self):
        assert _clean_text("hello") == "hello"

    def test_strips_whitespace(self):
        assert _clean_text("  hi  ") == "hi"

    def test_empty_string_returns_default(self):
        assert _clean_text("") == ""

    def test_empty_string_custom_default(self):
        assert _clean_text("", default="n/a") == "n/a"

    def test_whitespace_only_returns_default(self):
        assert _clean_text("   ") == ""

    def test_whitespace_only_custom_default(self):
        assert _clean_text("   ", default="MISSING") == "MISSING"

    def test_integer_returns_default(self):
        # int is not a str — returns default
        assert _clean_text(123) == ""

    def test_none_returns_default(self):
        assert _clean_text(None) == ""

    def test_none_custom_default(self):
        assert _clean_text(None, default="nil") == "nil"

    def test_list_returns_default(self):
        assert _clean_text(["a", "b"]) == ""

    def test_zero_returns_default(self):
        # 0 is not a str
        assert _clean_text(0) == ""

    def test_false_returns_default(self):
        assert _clean_text(False) == ""

    def test_unicode_preserved(self):
        assert _clean_text("  café  ") == "café"

    def test_newline_stripped(self):
        assert _clean_text("\nhello\n") == "hello"


# ---------------------------------------------------------------------------
# _safe_float
# ---------------------------------------------------------------------------


class TestSafeFloat:
    def test_none_returns_none(self):
        assert _safe_float(None) is None

    def test_empty_string_returns_none(self):
        assert _safe_float("") is None

    def test_integer(self):
        assert _safe_float(42) == 42.0

    def test_float(self):
        assert _safe_float(3.14) == pytest.approx(3.14)

    def test_numeric_string(self):
        assert _safe_float("9.99") == pytest.approx(9.99)

    def test_nan_returns_none(self):
        assert _safe_float(float("nan")) is None

    def test_nan_string_returns_none(self):
        assert _safe_float("nan") is None

    def test_infinity_allowed(self):
        # float("inf") is not NaN — returned as-is
        result = _safe_float(float("inf"))
        assert result == float("inf")

    def test_invalid_string_returns_none(self):
        assert _safe_float("abc") is None

    def test_negative_float(self):
        assert _safe_float("-12.5") == pytest.approx(-12.5)

    def test_zero(self):
        assert _safe_float(0) == 0.0

    def test_zero_string(self):
        assert _safe_float("0") == 0.0

    def test_list_returns_none(self):
        assert _safe_float([1, 2]) is None


# ---------------------------------------------------------------------------
# _safe_int
# ---------------------------------------------------------------------------


class TestSafeInt:
    def test_none_returns_none(self):
        assert _safe_int(None) is None

    def test_empty_string_returns_none(self):
        assert _safe_int("") is None

    def test_integer_passthrough(self):
        assert _safe_int(7) == 7

    def test_integer_string(self):
        assert _safe_int("42") == 42

    def test_negative_integer_string(self):
        assert _safe_int("-5") == -5

    def test_float_string_returns_none(self):
        # int("3.14") raises ValueError
        assert _safe_int("3.14") is None

    def test_float_value_converted(self):
        # int(3.9) == 3 — truncates
        assert _safe_int(3.9) == 3

    def test_invalid_string_returns_none(self):
        assert _safe_int("abc") is None

    def test_zero(self):
        assert _safe_int(0) == 0

    def test_large_number(self):
        assert _safe_int(10**15) == 10**15


# ---------------------------------------------------------------------------
# _parse_dt
# ---------------------------------------------------------------------------


class TestParseDt:
    def test_none_returns_none(self):
        assert _parse_dt(None) is None

    def test_empty_string_returns_none(self):
        assert _parse_dt("") is None

    def test_whitespace_returns_none(self):
        assert _parse_dt("   ") is None

    def test_aware_datetime_passthrough(self):
        dt = datetime(2024, 6, 15, 12, 0, 0, tzinfo=UTC)
        result = _parse_dt(dt)
        assert result == dt
        assert result.tzinfo is not None

    def test_naive_datetime_gets_utc(self):
        naive = datetime(2024, 6, 15, 12, 0, 0)
        result = _parse_dt(naive)
        assert result.tzinfo == UTC

    def test_iso_string_with_z(self):
        result = _parse_dt("2024-01-01T00:00:00Z")
        assert result == datetime(2024, 1, 1, 0, 0, 0, tzinfo=UTC)

    def test_iso_string_with_offset(self):
        result = _parse_dt("2024-01-01T06:00:00+05:30")
        expected = datetime(2024, 1, 1, 0, 30, 0, tzinfo=UTC)
        assert result == expected

    def test_iso_string_naive(self):
        result = _parse_dt("2024-01-01T00:00:00")
        assert result.tzinfo == UTC

    def test_invalid_string_returns_none(self):
        assert _parse_dt("not-a-date") is None

    def test_non_str_non_datetime_returns_none(self):
        assert _parse_dt(12345) is None

    def test_aware_datetime_converted_to_utc(self):
        tz_plus5 = timezone(timedelta(hours=5))
        dt = datetime(2024, 1, 1, 10, 0, 0, tzinfo=tz_plus5)
        result = _parse_dt(dt)
        assert result.hour == 5
        assert result.tzinfo == UTC


# ---------------------------------------------------------------------------
# _json_object
# ---------------------------------------------------------------------------


class TestJsonObject:
    def test_dict_passthrough(self):
        d = {"a": 1}
        assert _json_object(d) is d

    def test_json_string_parsed(self):
        assert _json_object('{"key": "value"}') == {"key": "value"}

    def test_json_array_string_returns_empty(self):
        assert _json_object("[1,2,3]") == {}

    def test_invalid_json_string_returns_empty(self):
        assert _json_object("{not json}") == {}

    def test_none_returns_empty(self):
        assert _json_object(None) == {}

    def test_integer_returns_empty(self):
        assert _json_object(42) == {}

    def test_list_returns_empty(self):
        assert _json_object([1, 2]) == {}

    def test_empty_dict_passthrough(self):
        assert _json_object({}) == {}

    def test_nested_dict(self):
        d = {"a": {"b": 2}}
        assert _json_object(d) == {"a": {"b": 2}}

    def test_json_string_with_nested(self):
        s = json.dumps({"x": [1, 2, 3]})
        assert _json_object(s) == {"x": [1, 2, 3]}


# ---------------------------------------------------------------------------
# _sha256_text and _sha256_json
# ---------------------------------------------------------------------------


class TestSha256:
    def test_sha256_text_known_hash(self):
        expected = hashlib.sha256(b"hello").hexdigest()
        assert _sha256_text("hello") == expected

    def test_sha256_text_empty_string(self):
        expected = hashlib.sha256(b"").hexdigest()
        assert _sha256_text("") == expected

    def test_sha256_text_unicode(self):
        text = "café"
        expected = hashlib.sha256(text.encode("utf-8")).hexdigest()
        assert _sha256_text(text) == expected

    def test_sha256_text_length(self):
        result = _sha256_text("test")
        assert len(result) == 64

    def test_sha256_json_dict(self):
        data = {"b": 2, "a": 1}
        # _json_dumps uses sort_keys=True
        canonical = json.dumps(data, sort_keys=True, separators=(",", ":"), default=str)
        expected = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        assert _sha256_json(data) == expected

    def test_sha256_json_stable(self):
        # Same data in different key order → same hash
        h1 = _sha256_json({"z": 1, "a": 2})
        h2 = _sha256_json({"a": 2, "z": 1})
        assert h1 == h2

    def test_sha256_json_list(self):
        result = _sha256_json([1, 2, 3])
        assert isinstance(result, str)
        assert len(result) == 64

    def test_sha256_json_different_for_different_values(self):
        assert _sha256_json({"a": 1}) != _sha256_json({"a": 2})


# ---------------------------------------------------------------------------
# _clip_text
# ---------------------------------------------------------------------------


class TestClipText:
    def test_short_text_unchanged(self):
        assert _clip_text("hello", 10) == "hello"

    def test_exact_max_unchanged(self):
        assert _clip_text("hello", 5) == "hello"

    def test_clipped_has_ellipsis(self):
        result = _clip_text("hello world", 8)
        assert result.endswith("…")

    def test_clipped_length_correct(self):
        # max_chars=8 → first 7 chars (rstripped) + "…" = 8 chars total
        result = _clip_text("hello world", 8)
        assert len(result) <= 8

    def test_normalizes_whitespace(self):
        result = _clip_text("  hello   world  ", 20)
        assert result == "hello world"

    def test_normalizes_newlines(self):
        result = _clip_text("hello\nworld", 20)
        assert result == "hello world"

    def test_empty_string(self):
        assert _clip_text("", 10) == ""

    def test_max_chars_one(self):
        result = _clip_text("abc", 1)
        # max(0, 1-1)=0 → "" rstripped → "" + "…" = "…"
        assert result == "…"

    def test_max_chars_zero(self):
        # max(0, 0-1) = max(0,-1) = 0 → "" + "…" = "…"
        result = _clip_text("abc", 0)
        assert result == "…"

    def test_unicode_preserved(self):
        result = _clip_text("café au lait", 50)
        assert result == "café au lait"


# ---------------------------------------------------------------------------
# _dedupe_strings
# ---------------------------------------------------------------------------


class TestDedupeStrings:
    def test_deduplicates(self):
        assert _dedupe_strings(["a", "b", "a"]) == ["a", "b"]

    def test_preserves_order(self):
        assert _dedupe_strings(["c", "a", "b", "a"]) == ["c", "a", "b"]

    def test_skips_blank(self):
        assert _dedupe_strings(["", "a", "  ", "b"]) == ["a", "b"]

    def test_strips_whitespace_for_comparison(self):
        # " a " and "a" are both normalized to "a" → second is duplicate
        assert _dedupe_strings([" a ", "a"]) == ["a"]

    def test_limit_applied(self):
        assert _dedupe_strings(["a", "b", "c", "d"], limit=2) == ["a", "b"]

    def test_limit_none_no_cap(self):
        values = [str(i) for i in range(20)]
        assert _dedupe_strings(values) == values

    def test_empty_list(self):
        assert _dedupe_strings([]) == []

    def test_all_blanks(self):
        assert _dedupe_strings(["", " ", "\t"]) == []

    def test_limit_larger_than_list(self):
        assert _dedupe_strings(["x", "y"], limit=100) == ["x", "y"]

    def test_limit_zero(self):
        # Implementation appends before checking limit; 1 >= 0 → breaks after first item
        assert _dedupe_strings(["a", "b"], limit=0) == ["a"]


# ---------------------------------------------------------------------------
# _merchant_id_from_label
# ---------------------------------------------------------------------------


class TestMerchantIdFromLabel:
    def test_simple_name(self):
        assert _merchant_id_from_label("Amazon") == "amazon"

    def test_suffix_tokens_removed(self):
        # "Inc" is in _SUFFIX_TOKENS
        assert _merchant_id_from_label("Acme Inc") == "acme"

    def test_multiple_words(self):
        assert _merchant_id_from_label("Whole Foods") == "whole_foods"

    def test_punctuation_split(self):
        assert _merchant_id_from_label("Best Buy!") == "best_buy"

    def test_all_suffix_tokens_returns_unknown(self):
        # "LLC" + "Co" are both suffix tokens → no real tokens → "unknown_merchant"
        assert _merchant_id_from_label("LLC Co") == "unknown_merchant"

    def test_empty_string_returns_unknown(self):
        assert _merchant_id_from_label("") == "unknown_merchant"

    def test_numbers_preserved(self):
        assert _merchant_id_from_label("7-Eleven") == "7_eleven"

    def test_store_suffix_removed(self):
        # "store" is in _SUFFIX_TOKENS
        assert _merchant_id_from_label("Apple Store") == "apple"

    def test_corp_suffix_removed(self):
        assert _merchant_id_from_label("Big Corp") == "big"


# ---------------------------------------------------------------------------
# _email_domain_root
# ---------------------------------------------------------------------------


class TestEmailDomainRoot:
    def test_gmail(self):
        assert _email_domain_root("user@gmail.com") == "gmail"

    def test_subdomain(self):
        # user@mail.company.org → parts = ["mail","company","org"] → parts[-2] = "company"
        assert _email_domain_root("user@mail.company.org") == "company"

    def test_no_at_returns_none(self):
        assert _email_domain_root("notanemail") is None

    def test_none_returns_none(self):
        assert _email_domain_root(None) is None

    def test_empty_string_returns_none(self):
        assert _email_domain_root("") is None

    def test_at_only_returns_none(self):
        assert _email_domain_root("@") is None

    def test_at_with_no_domain_returns_none(self):
        assert _email_domain_root("user@") is None

    def test_single_part_domain(self):
        # user@localhost → parts = ["localhost"] → parts[0]
        assert _email_domain_root("user@localhost") == "localhost"

    def test_case_insensitive(self):
        assert _email_domain_root("USER@GMAIL.COM") == "gmail"


# ---------------------------------------------------------------------------
# _canonicalize_merchant
# ---------------------------------------------------------------------------


class TestCanonicalizeMerchant:
    def test_amazon_canonical(self):
        row = {"merchant_name": "Amazon Marketplace"}
        mid, label = _canonicalize_merchant(row)
        assert mid == "amazon"
        assert label == "Amazon"

    def test_amazon_amzn(self):
        row = {"merchant_name": "AMZN Digital"}
        mid, label = _canonicalize_merchant(row)
        assert label == "Amazon"

    def test_apple_itunes(self):
        row = {"merchant_name": "iTunes Store"}
        _, label = _canonicalize_merchant(row)
        assert label == "Apple"

    def test_netflix(self):
        row = {"merchant_name": "Netflix.com"}
        _, label = _canonicalize_merchant(row)
        assert label == "Netflix"

    def test_spotify(self):
        row = {"merchant_name": "Spotify AB"}
        _, label = _canonicalize_merchant(row)
        assert label == "Spotify"

    def test_unknown_merchant_fallback(self):
        row = {"merchant_name": "Piccolo Bistro"}
        mid, label = _canonicalize_merchant(row)
        assert "piccolo" in mid
        assert "Piccolo" in label

    def test_empty_row_uses_unknown(self):
        mid, label = _canonicalize_merchant({})
        # source = "Unknown merchant" → tokens ["unknown","merchant"] → title-cased
        assert label == "Unknown Merchant"
        assert "unknown" in mid

    def test_from_name_used_as_fallback(self):
        row = {"from_name": "Swiggy"}
        _, label = _canonicalize_merchant(row)
        assert label == "Swiggy"

    def test_email_domain_last_resort(self):
        row = {"from_email": "no-reply@paypal.com"}
        _, label = _canonicalize_merchant(row)
        assert label == "PayPal"

    def test_merchant_name_takes_precedence(self):
        row = {"merchant_name": "Uber", "from_name": "Lyft"}
        _, label = _canonicalize_merchant(row)
        assert label == "Uber"

    def test_suffix_only_merchant_label_preserved(self):
        # merchant_name = "LLC" → all suffix tokens → label fallback = "LLC", mid = unknown
        row = {"merchant_name": "LLC"}
        mid, label = _canonicalize_merchant(row)
        # "llc" matches no canonical rules; token list after suffix removal is empty
        assert mid == "unknown_merchant"

    def test_label_title_cased(self):
        row = {"merchant_name": "whole foods market"}
        _, label = _canonicalize_merchant(row)
        # Takes first 3 tokens, title-cased
        assert label == label.title()


# ---------------------------------------------------------------------------
# _median
# ---------------------------------------------------------------------------


class TestMedian:
    def test_empty_returns_none(self):
        assert _median([]) is None

    def test_single_value(self):
        assert _median([5.0]) == 5.0

    def test_odd_count(self):
        assert _median([1.0, 2.0, 3.0]) == 2.0

    def test_even_count(self):
        assert _median([1.0, 2.0, 3.0, 4.0]) == 2.5

    def test_filters_non_numeric(self):
        # strings filtered out; only ints/floats remain
        result = _median([1.0, "abc", 3.0])  # type: ignore[list-item]
        assert result == 2.0

    def test_all_non_numeric_returns_none(self):
        # All strings filtered out → cleaned=[] → None
        assert _median(["a", "b"]) is None  # type: ignore[arg-type]

    def test_mixed_int_and_float(self):
        assert _median([1, 2, 3]) == 2.0

    def test_negative_values(self):
        assert _median([-3.0, -1.0, -2.0]) == -2.0

    def test_returns_float(self):
        result = _median([4])
        assert isinstance(result, float)


# ---------------------------------------------------------------------------
# _top_currency_summary
# ---------------------------------------------------------------------------


class TestTopCurrencySummary:
    def test_empty_rows_returns_none_tuple(self):
        assert _top_currency_summary([]) == (None, None)

    def test_single_currency(self):
        rows = [
            {"amount": "10.00", "currency": "USD"},
            {"amount": "20.00", "currency": "USD"},
        ]
        currency, total = _top_currency_summary(rows)
        assert currency == "USD"
        assert total == pytest.approx(30.0)

    def test_multiple_currencies_picks_highest(self):
        rows = [
            {"amount": "5.00", "currency": "EUR"},
            {"amount": "100.00", "currency": "USD"},
            {"amount": "10.00", "currency": "EUR"},
        ]
        currency, total = _top_currency_summary(rows)
        assert currency == "USD"
        assert total == pytest.approx(100.0)

    def test_missing_amount_skipped(self):
        rows = [
            {"amount": None, "currency": "USD"},
            {"amount": "50.00", "currency": "EUR"},
        ]
        currency, total = _top_currency_summary(rows)
        assert currency == "EUR"
        assert total == pytest.approx(50.0)

    def test_missing_currency_skipped(self):
        rows = [
            {"amount": "30.00", "currency": ""},
            {"amount": "10.00", "currency": "GBP"},
        ]
        currency, total = _top_currency_summary(rows)
        assert currency == "GBP"

    def test_currency_uppercased(self):
        rows = [{"amount": "15.00", "currency": "usd"}]
        currency, _ = _top_currency_summary(rows)
        assert currency == "USD"

    def test_total_rounded_to_two_decimals(self):
        rows = [
            {"amount": "10.001", "currency": "USD"},
            {"amount": "20.004", "currency": "USD"},
        ]
        _, total = _top_currency_summary(rows)
        assert total == pytest.approx(30.01, abs=0.001)

    def test_all_invalid_amounts_returns_none_tuple(self):
        rows = [{"amount": "bad", "currency": "USD"}]
        assert _top_currency_summary(rows) == (None, None)


# ---------------------------------------------------------------------------
# _format_pattern_label
# ---------------------------------------------------------------------------


class TestFormatPatternLabel:
    def test_monthly(self):
        result = _format_pattern_label("Netflix", "monthly")
        assert result == "Shows a monthly purchase pattern with Netflix"

    def test_quarterly(self):
        result = _format_pattern_label("Spotify", "quarterly")
        assert result == "Shows a quarterly purchase pattern with Spotify"

    def test_biweekly(self):
        result = _format_pattern_label("Uber", "biweekly")
        assert result == "Shows a biweekly purchase pattern with Uber"

    def test_weekly_default(self):
        result = _format_pattern_label("Amazon", "weekly")
        assert result == "Shows a weekly purchase pattern with Amazon"

    def test_unknown_cadence_falls_through_to_weekly(self):
        # No explicit "daily" branch → returns weekly string
        result = _format_pattern_label("Target", "daily")
        assert result == "Shows a weekly purchase pattern with Target"

    def test_empty_merchant(self):
        result = _format_pattern_label("", "monthly")
        assert "monthly" in result


# ---------------------------------------------------------------------------
# _format_dt_iso
# ---------------------------------------------------------------------------


class TestFormatDtIso:
    def test_none_returns_none(self):
        assert _format_dt_iso(None) is None

    def test_utc_datetime_ends_with_z(self):
        dt = datetime(2024, 1, 15, 10, 30, 0, tzinfo=UTC)
        result = _format_dt_iso(dt)
        assert result == "2024-01-15T10:30:00Z"

    def test_offset_datetime_converted_to_utc(self):
        tz_plus5 = timezone(timedelta(hours=5))
        dt = datetime(2024, 1, 15, 15, 30, 0, tzinfo=tz_plus5)
        result = _format_dt_iso(dt)
        # 15:30 +05:00 → 10:30 UTC
        assert result == "2024-01-15T10:30:00Z"

    def test_output_format_no_plus00(self):
        dt = datetime(2024, 6, 1, 0, 0, 0, tzinfo=UTC)
        result = _format_dt_iso(dt)
        assert "+00:00" not in result
        assert result.endswith("Z")

    def test_is_string(self):
        dt = datetime(2024, 1, 1, tzinfo=UTC)
        assert isinstance(_format_dt_iso(dt), str)
