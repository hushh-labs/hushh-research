"""Tests for quality_v2 parser helpers and quality gate.

Covers _to_num and _coerce_optional_number edge cases (NaN, Inf, booleans)
plus the downstream impact on evaluate_import_quality_gate_v2 when
poison market_value inputs appear in holdings.
"""

from __future__ import annotations

import math
from collections import Counter

from hushh_mcp.kai_import.quality_v2 import (
    _coerce_optional_number,
    _to_num,
    build_holdings_quality_report_v2,
    build_quality_report_v2,
    evaluate_import_quality_gate_v2,
)

# ---------------------------------------------------------------------------
# _to_num: standard conversions
# ---------------------------------------------------------------------------


class TestToNumStandard:
    def test_int(self) -> None:
        assert _to_num(42) == 42.0

    def test_float(self) -> None:
        assert _to_num(3.14) == 3.14

    def test_zero(self) -> None:
        assert _to_num(0) == 0.0

    def test_negative(self) -> None:
        assert _to_num(-5) == -5.0

    def test_string_rejected(self) -> None:
        assert _to_num("42") is None

    def test_none(self) -> None:
        assert _to_num(None) is None


# ---------------------------------------------------------------------------
# _to_num: poison inputs (the bug this PR fixes)
# ---------------------------------------------------------------------------


class TestToNumPoison:
    def test_nan_returns_none(self) -> None:
        assert _to_num(float("nan")) is None

    def test_inf_returns_none(self) -> None:
        assert _to_num(float("inf")) is None

    def test_neg_inf_returns_none(self) -> None:
        assert _to_num(float("-inf")) is None

    def test_bool_true_returns_none(self) -> None:
        # bool is a subclass of int. Without this guard, True -> 1.0.
        assert _to_num(True) is None

    def test_bool_false_returns_none(self) -> None:
        assert _to_num(False) is None


# ---------------------------------------------------------------------------
# _coerce_optional_number: standard conversions
# ---------------------------------------------------------------------------


class TestCoerceStandard:
    def test_int(self) -> None:
        assert _coerce_optional_number(42) == 42.0

    def test_float(self) -> None:
        assert _coerce_optional_number(2.5) == 2.5

    def test_plain_number_string(self) -> None:
        assert _coerce_optional_number("42") == 42.0

    def test_dollar_string(self) -> None:
        assert _coerce_optional_number("$1,234.56") == 1234.56

    def test_negative_string(self) -> None:
        assert _coerce_optional_number("-50.5") == -50.5

    def test_empty_string(self) -> None:
        assert _coerce_optional_number("") is None

    def test_whitespace(self) -> None:
        assert _coerce_optional_number("   ") is None

    def test_invalid_string(self) -> None:
        assert _coerce_optional_number("abc") is None

    def test_none(self) -> None:
        assert _coerce_optional_number(None) is None


# ---------------------------------------------------------------------------
# _coerce_optional_number: poison inputs
# ---------------------------------------------------------------------------


class TestCoercePoison:
    def test_nan_value(self) -> None:
        assert _coerce_optional_number(float("nan")) is None

    def test_inf_value(self) -> None:
        assert _coerce_optional_number(float("inf")) is None

    def test_bool_true(self) -> None:
        assert _coerce_optional_number(True) is None

    def test_bool_false(self) -> None:
        assert _coerce_optional_number(False) is None


# ---------------------------------------------------------------------------
# Downstream impact: NaN market_value must not corrupt the gate result
# ---------------------------------------------------------------------------


class TestQualityGateNaNRobustness:
    def test_nan_market_value_does_not_propagate_to_sum(self) -> None:
        holdings = [
            {"symbol": "AAPL", "market_value": 1000.0, "is_investable": True},
            {"symbol": "BAD", "market_value": float("nan"), "is_investable": True},
            {"symbol": "MSFT", "market_value": 500.0, "is_investable": True},
        ]
        _, result = evaluate_import_quality_gate_v2(
            holdings=holdings,
            placeholder_symbol_count=0,
            account_header_row_count=0,
            expected_total_value=None,
            core_keys_present=True,
            rows_with_symbol_pct=1.0,
            rows_with_market_value_pct=1.0,
        )
        # Previously NaN + 1000 + 500 = NaN. With the fix, NaN becomes None
        # which falls through to 0.0, so the sum is 1500.0.
        assert result["holdings_market_value_sum"] == 1500.0
        assert not math.isnan(result["holdings_market_value_sum"])

    def test_expected_total_value_nan_becomes_none(self) -> None:
        _, result = evaluate_import_quality_gate_v2(
            holdings=[{"symbol": "X", "market_value": 100.0}],
            placeholder_symbol_count=0,
            account_header_row_count=0,
            expected_total_value=float("nan"),
            core_keys_present=True,
        )
        assert result["expected_total_value"] is None


# ---------------------------------------------------------------------------
# evaluate_import_quality_gate_v2: severity signals
# ---------------------------------------------------------------------------


class TestQualityGateSeverity:
    def test_empty_holdings_fail(self) -> None:
        passed, result = evaluate_import_quality_gate_v2(
            holdings=[],
            placeholder_symbol_count=0,
            account_header_row_count=0,
            expected_total_value=None,
            core_keys_present=True,
        )
        assert passed is False
        assert "no_holdings_extracted" in result["reasons"]

    def test_missing_core_keys_fail(self) -> None:
        passed, result = evaluate_import_quality_gate_v2(
            holdings=[{"symbol": "X", "market_value": 100.0}],
            placeholder_symbol_count=0,
            account_header_row_count=0,
            expected_total_value=None,
            core_keys_present=False,
        )
        assert passed is False
        assert "core_keys_missing" in result["reasons"]

    def test_low_symbol_coverage_warns(self) -> None:
        passed, result = evaluate_import_quality_gate_v2(
            holdings=[{"symbol": "X", "market_value": 100.0}],
            placeholder_symbol_count=0,
            account_header_row_count=0,
            expected_total_value=None,
            core_keys_present=True,
            rows_with_symbol_pct=0.3,
            rows_with_market_value_pct=0.9,
        )
        assert passed is True
        assert result["severity"] == "warn"
        assert "low_symbol_coverage" in result["reasons"]

    def test_healthy_passes(self) -> None:
        passed, result = evaluate_import_quality_gate_v2(
            holdings=[{"symbol": "X", "market_value": 100.0}],
            placeholder_symbol_count=0,
            account_header_row_count=0,
            expected_total_value=None,
            core_keys_present=True,
            rows_with_symbol_pct=0.95,
            rows_with_market_value_pct=0.95,
        )
        assert passed is True
        assert result["severity"] == "pass"
        assert result["reasons"] == []


# ---------------------------------------------------------------------------
# build_holdings_quality_report_v2 and build_quality_report_v2 smoke
# ---------------------------------------------------------------------------


class TestReportBuilders:
    def test_holdings_report_clamps_percentages(self) -> None:
        report = build_holdings_quality_report_v2(
            raw_count=10,
            validated_count=8,
            aggregated_count=7,
            dropped_reasons=Counter({"missing_symbol": 2}),
            reconciled_count=0,
            mismatch_count=0,
            parse_diagnostics={
                "rows_with_symbol_pct": 1.5,  # out of range; should clamp to 1.0
                "rows_with_market_value_pct": -0.2,  # out of range; should clamp to 0.0
            },
            unknown_name_count=0,
            placeholder_symbol_count=0,
            zero_qty_zero_price_nonzero_value_count=0,
            account_header_row_count=0,
            duplicate_symbol_lot_count=0,
            average_confidence=0.9,
        )
        assert report["rows_with_symbol_pct"] == 1.0
        assert report["rows_with_market_value_pct"] == 0.0
        assert report["dropped"] == 2

    def test_quality_report_computes_parser_score(self) -> None:
        report = build_quality_report_v2(
            quality_report={
                "raw_count": 10,
                "aggregated_count": 8,
                "rows_with_symbol_pct": 0.8,
                "rows_with_market_value_pct": 0.7,
            },
            quality_gate={"passed": True, "severity": "pass"},
            holdings=[
                {"symbol": "X", "is_investable": True},
                {"symbol": "CASH", "is_cash_equivalent": True},
            ],
        )
        assert report["schema_version"] == 2
        assert report["parser_quality_score"] == 0.8
        assert report["investable_positions_count"] == 1
        assert report["cash_positions_count"] == 1

    def test_quality_report_zero_raw_does_not_divide_by_zero(self) -> None:
        report = build_quality_report_v2(
            quality_report={"raw_count": 0, "aggregated_count": 0},
            quality_gate={},
            holdings=[],
        )
        assert report["parser_quality_score"] == 0.0
