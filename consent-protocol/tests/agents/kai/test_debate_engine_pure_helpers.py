"""Behavioral tests for pure module-level helpers in debate_engine.

These three helpers are the formatting/parsing boundary between raw
numeric data from LLM responses and the strings rendered to the user:

    _safe_float   — coerce arbitrary input to Optional[float]
    _format_currency — format a numeric value as $B/$M/$K/$ string
    _format_percent  — format a fraction or percentage as "N%" string

All are pure / side-effect-free — no network, DB, or LLM required.
"""

from __future__ import annotations

import pytest

from hushh_mcp.agents.kai.debate_engine import (
    _format_currency,
    _format_percent,
    _safe_float,
)

# ---------------------------------------------------------------------------
# _safe_float
# ---------------------------------------------------------------------------


class TestSafeFloat:
    def test_none_returns_none(self):
        assert _safe_float(None) is None

    def test_true_returns_none(self):
        assert _safe_float(True) is None

    def test_false_returns_none(self):
        assert _safe_float(False) is None

    def test_integer_converted(self):
        assert _safe_float(42) == 42.0

    def test_float_returned(self):
        assert _safe_float(3.14) == pytest.approx(3.14)

    def test_zero_returned(self):
        assert _safe_float(0) == 0.0

    def test_negative_integer(self):
        assert _safe_float(-7) == -7.0

    def test_nan_returns_none(self):
        assert _safe_float(float("nan")) is None

    def test_inf_returns_inf(self):
        assert _safe_float(float("inf")) == float("inf")

    def test_string_integer(self):
        assert _safe_float("100") == 100.0

    def test_string_float(self):
        assert _safe_float("1.5") == 1.5

    def test_string_with_comma(self):
        assert _safe_float("1,000") == 1000.0

    def test_string_with_multiple_commas(self):
        assert _safe_float("1,234,567") == 1_234_567.0

    def test_empty_string_returns_none(self):
        assert _safe_float("") is None

    def test_whitespace_only_returns_none(self):
        assert _safe_float("   ") is None

    def test_non_numeric_string_returns_none(self):
        assert _safe_float("abc") is None

    def test_string_with_whitespace_stripped(self):
        assert _safe_float("  42.5  ") == 42.5

    def test_list_returns_none(self):
        assert _safe_float([1, 2]) is None

    def test_dict_returns_none(self):
        assert _safe_float({"value": 1}) is None

    def test_negative_float_string(self):
        assert _safe_float("-9.99") == -9.99


# ---------------------------------------------------------------------------
# _format_currency
# ---------------------------------------------------------------------------


class TestFormatCurrency:
    def test_none_returns_na(self):
        assert _format_currency(None) == "n/a"

    def test_bool_returns_na(self):
        assert _format_currency(True) == "n/a"

    def test_non_numeric_string_returns_na(self):
        assert _format_currency("not-a-number") == "n/a"

    def test_zero_formats_as_dollars(self):
        assert _format_currency(0) == "$0"

    def test_small_positive_formats_as_dollars(self):
        assert _format_currency(999) == "$999"

    def test_boundary_thousands_formats_as_k(self):
        assert _format_currency(1_000) == "$1K"

    def test_thousands_formats_as_k(self):
        assert _format_currency(5_500) == "$6K"

    def test_boundary_millions_formats_as_m(self):
        result = _format_currency(1_000_000)
        assert result == "$1.00M"

    def test_millions_formats_as_m(self):
        result = _format_currency(2_500_000)
        assert result == "$2.50M"

    def test_boundary_billions_formats_as_b(self):
        result = _format_currency(1_000_000_000)
        assert result == "$1.00B"

    def test_billions_formats_as_b(self):
        result = _format_currency(3_750_000_000)
        assert result == "$3.75B"

    def test_negative_small_value(self):
        assert _format_currency(-500) == "-$500"

    def test_negative_thousands(self):
        assert _format_currency(-2_000) == "-$2K"

    def test_negative_millions(self):
        assert _format_currency(-1_500_000) == "-$1.50M"

    def test_negative_billions(self):
        assert _format_currency(-2_000_000_000) == "-$2.00B"

    def test_string_number_formatted(self):
        assert _format_currency("1000000") == "$1.00M"

    def test_comma_formatted_string(self):
        assert _format_currency("1,000") == "$1K"


# ---------------------------------------------------------------------------
# _format_percent
# ---------------------------------------------------------------------------


class TestFormatPercent:
    def test_none_returns_na(self):
        assert _format_percent(None) == "n/a"

    def test_bool_returns_na(self):
        assert _format_percent(True) == "n/a"

    def test_non_numeric_string_returns_na(self):
        assert _format_percent("bad") == "n/a"

    def test_zero_returns_zero_pct(self):
        assert _format_percent(0) == "0%"

    def test_fraction_below_one_multiplied(self):
        # 0.25 → 25%
        assert _format_percent(0.25) == "25%"

    def test_fraction_at_one_multiplied(self):
        # 1.0 → 100%  (boundary: parsed <= 1.0 path)
        assert _format_percent(1.0) == "100%"

    def test_value_above_one_used_as_is(self):
        # 50.0 → 50%  (already a percentage)
        assert _format_percent(50.0) == "50%"

    def test_value_exactly_100(self):
        assert _format_percent(100.0) == "100%"

    def test_large_percentage(self):
        assert _format_percent(150.0) == "150%"

    def test_negative_fraction(self):
        # -0.05 → -5%
        assert _format_percent(-0.05) == "-5%"

    def test_negative_percentage(self):
        # -10.0 <= 1.0 is True, so the fraction path applies: -10.0 * 100 = -1000%
        assert _format_percent(-10.0) == "-1000%"

    def test_string_fraction(self):
        assert _format_percent("0.5") == "50%"

    def test_string_percentage(self):
        assert _format_percent("75") == "75%"

    def test_rounding_truncates_to_integer(self):
        # 0.256 → 25.6 → "26%" after rounding
        assert _format_percent(0.256) == "26%"
