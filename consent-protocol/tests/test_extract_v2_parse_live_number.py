"""Tests for _parse_live_number in extract_v2.

Covers the live portfolio extraction parser used on every incoming
holding row. Ensures NaN, Inf, and boolean inputs cannot reach
downstream reconciliation or quality math.
"""

from __future__ import annotations

import math

from hushh_mcp.kai_import.extract_v2 import _parse_live_number

# ---------------------------------------------------------------------------
# Standard numeric conversions
# ---------------------------------------------------------------------------


class TestParseLiveNumberStandard:
    def test_int(self) -> None:
        assert _parse_live_number(42) == 42.0

    def test_float(self) -> None:
        assert _parse_live_number(3.14) == 3.14

    def test_zero(self) -> None:
        assert _parse_live_number(0) == 0.0

    def test_negative(self) -> None:
        assert _parse_live_number(-5) == -5.0

    def test_dollar_string(self) -> None:
        assert _parse_live_number("$1,234.56") == 1234.56

    def test_parens_negative(self) -> None:
        assert _parse_live_number("(100)") == -100.0

    def test_dollar_parens_negative(self) -> None:
        assert _parse_live_number("($500.00)") == -500.0

    def test_percentage_stripped(self) -> None:
        assert _parse_live_number("12.5%") == 12.5

    def test_plain_negative_string(self) -> None:
        assert _parse_live_number("-100") == -100.0


# ---------------------------------------------------------------------------
# None-returning paths
# ---------------------------------------------------------------------------


class TestParseLiveNumberNone:
    def test_none(self) -> None:
        assert _parse_live_number(None) is None

    def test_empty_string(self) -> None:
        assert _parse_live_number("") is None

    def test_whitespace(self) -> None:
        assert _parse_live_number("   ") is None

    def test_invalid_string(self) -> None:
        assert _parse_live_number("abc") is None

    def test_empty_parens(self) -> None:
        assert _parse_live_number("()") is None

    def test_just_dollar(self) -> None:
        assert _parse_live_number("$") is None


# ---------------------------------------------------------------------------
# Float NaN / Inf are already rejected via math.isfinite
# ---------------------------------------------------------------------------


class TestFloatPoison:
    def test_float_nan(self) -> None:
        assert _parse_live_number(float("nan")) is None

    def test_float_inf(self) -> None:
        assert _parse_live_number(float("inf")) is None

    def test_float_neg_inf(self) -> None:
        assert _parse_live_number(float("-inf")) is None


# ---------------------------------------------------------------------------
# Booleans: bool is subclass of int in Python (the bug this PR fixes)
# ---------------------------------------------------------------------------


class TestBoolPoison:
    def test_bool_true_returns_none(self) -> None:
        # Previously returned 1.0. A JSON flag like is_cash_equivalent coming
        # through the extraction pipeline would parse as a phantom $1 holding.
        assert _parse_live_number(True) is None

    def test_bool_false_returns_none(self) -> None:
        assert _parse_live_number(False) is None


# ---------------------------------------------------------------------------
# String-form NaN / Inf (the sneakier bug this PR fixes)
# ---------------------------------------------------------------------------


class TestStringPoison:
    """Python's float() accepts 'inf', 'nan', 'Infinity', etc. These strings
    appear when JSON serializers round-trip non-finite floats through text.
    Without a post-parse finiteness check they previously leaked through.
    """

    def test_string_inf(self) -> None:
        assert _parse_live_number("inf") is None

    def test_string_Inf(self) -> None:
        assert _parse_live_number("Inf") is None

    def test_string_Infinity(self) -> None:
        assert _parse_live_number("Infinity") is None

    def test_string_negative_infinity(self) -> None:
        assert _parse_live_number("-inf") is None

    def test_string_nan_lower(self) -> None:
        assert _parse_live_number("nan") is None

    def test_string_nan_upper(self) -> None:
        assert _parse_live_number("NaN") is None

    def test_string_negative_nan(self) -> None:
        assert _parse_live_number("-nan") is None

    def test_parens_infinity_does_not_produce_neg_inf(self) -> None:
        # Previously produced -inf via the parens-negate path
        result = _parse_live_number("(inf)")
        assert result is None or math.isfinite(result)
        assert _parse_live_number("(inf)") is None
