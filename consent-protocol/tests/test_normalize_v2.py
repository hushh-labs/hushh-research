"""Tests for normalize_v2 portfolio normalization helpers.

Covers _to_num edge cases (NaN, Inf, booleans, currency formats) and
_allocation_mix_from_holdings bucket math.
"""

from __future__ import annotations

import math

from hushh_mcp.kai_import.normalize_v2 import (
    _allocation_mix_from_holdings,
    _to_num,
    build_financial_analytics_v2,
    build_financial_portfolio_canonical_v2,
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

    def test_negative_int(self) -> None:
        assert _to_num(-5) == -5.0

    def test_dollar_string(self) -> None:
        assert _to_num("$1,234.56") == 1234.56

    def test_negative_dollar_parens(self) -> None:
        assert _to_num("($1,234.56)") == -1234.56

    def test_parens_negative(self) -> None:
        assert _to_num("(100)") == -100.0

    def test_dash_negative_dollar(self) -> None:
        assert _to_num("-$500.00") == -500.0

    def test_percentage_stripped(self) -> None:
        assert _to_num("12.34%") == 12.34

    def test_plain_comma_number(self) -> None:
        assert _to_num("1,234") == 1234.0

    def test_negative_with_commas(self) -> None:
        assert _to_num("-1,234.56") == -1234.56


# ---------------------------------------------------------------------------
# _to_num: values that should return None
# ---------------------------------------------------------------------------


class TestToNumNone:
    def test_none(self) -> None:
        assert _to_num(None) is None

    def test_empty_string(self) -> None:
        assert _to_num("") is None

    def test_whitespace(self) -> None:
        assert _to_num("   ") is None

    def test_na_string(self) -> None:
        assert _to_num("N/A") is None

    def test_na_lowercase(self) -> None:
        assert _to_num("n/a") is None

    def test_double_negative(self) -> None:
        assert _to_num("--100") is None

    def test_empty_parens(self) -> None:
        assert _to_num("()") is None

    def test_just_dollar(self) -> None:
        assert _to_num("$") is None

    def test_just_commas(self) -> None:
        assert _to_num(",,,") is None

    def test_dollar_in_parens(self) -> None:
        assert _to_num("($)") is None


# ---------------------------------------------------------------------------
# _to_num: NaN, Inf, and boolean rejection (the bugs this PR fixes)
# ---------------------------------------------------------------------------


class TestToNumPoison:
    """These inputs previously passed through _to_num and corrupted
    downstream portfolio math (allocation buckets, gain/loss counters).
    """

    def test_nan_returns_none(self) -> None:
        assert _to_num(float("nan")) is None

    def test_inf_returns_none(self) -> None:
        assert _to_num(float("inf")) is None

    def test_neg_inf_returns_none(self) -> None:
        assert _to_num(float("-inf")) is None

    def test_bool_true_returns_none(self) -> None:
        # bool is a subclass of int in Python. A True from a JSON flag
        # like is_cash_equivalent would parse as 1.0 without this guard.
        assert _to_num(True) is None

    def test_bool_false_returns_none(self) -> None:
        assert _to_num(False) is None


# ---------------------------------------------------------------------------
# _allocation_mix_from_holdings
# ---------------------------------------------------------------------------


class TestAllocationMix:
    def test_single_bucket(self) -> None:
        holdings = [
            {"instrument_kind": "equity", "market_value": 1000.0},
            {"instrument_kind": "equity", "market_value": 500.0},
        ]
        result = _allocation_mix_from_holdings(holdings, 1500.0)
        equity = next(r for r in result if r["bucket"] == "equity")
        assert equity["value"] == 1500.0
        assert equity["pct"] == 100.0

    def test_unknown_bucket_falls_to_other(self) -> None:
        holdings = [{"instrument_kind": "crypto", "market_value": 100.0}]
        result = _allocation_mix_from_holdings(holdings, 100.0)
        other = next(r for r in result if r["bucket"] == "other")
        assert other["value"] == 100.0

    def test_zero_total_value_uses_sum(self) -> None:
        holdings = [{"instrument_kind": "equity", "market_value": 200.0}]
        result = _allocation_mix_from_holdings(holdings, 0.0)
        equity = next(r for r in result if r["bucket"] == "equity")
        assert equity["pct"] == 100.0

    def test_empty_holdings(self) -> None:
        result = _allocation_mix_from_holdings([], 0.0)
        assert all(r["value"] == 0.0 for r in result)

    def test_nan_market_value_does_not_corrupt_bucket(self) -> None:
        """After the _to_num fix, NaN market_value becomes 0.0 via the
        `or 0.0` fallback, so the bucket stays clean."""
        holdings = [
            {"instrument_kind": "equity", "market_value": float("nan")},
            {"instrument_kind": "equity", "market_value": 1000.0},
        ]
        result = _allocation_mix_from_holdings(holdings, 1000.0)
        equity = next(r for r in result if r["bucket"] == "equity")
        # NaN would make this nan; with the fix, _to_num(nan) = None,
        # and `None or 0.0` = 0.0, so bucket = 1000.0
        assert equity["value"] == 1000.0
        assert not math.isnan(equity["pct"])


# ---------------------------------------------------------------------------
# build_financial_portfolio_canonical_v2: smoke test
# ---------------------------------------------------------------------------


class TestCanonicalV2:
    def test_schema_version(self) -> None:
        result = build_financial_portfolio_canonical_v2(
            raw_extract_v2={},
            account_info={},
            account_summary={},
            holdings=[],
            asset_allocation=None,
            total_value=0.0,
            cash_balance=None,
            quality_report_v2={},
        )
        assert result["schema_version"] == 2
        assert result["holdings"] == []
        assert result["total_value"] == 0.0

    def test_cash_ledger_filters_cash_equivalent(self) -> None:
        holdings = [
            {"symbol": "AAPL", "market_value": 100.0, "is_cash_equivalent": False},
            {"symbol": "CASH", "market_value": 50.0, "is_cash_equivalent": True},
        ]
        result = build_financial_portfolio_canonical_v2(
            raw_extract_v2={},
            account_info={},
            account_summary={},
            holdings=holdings,
            asset_allocation=None,
            total_value=150.0,
            cash_balance=50.0,
            quality_report_v2={},
        )
        assert len(result["cash_ledger"]["rows"]) == 1
        assert result["cash_ledger"]["total_cash_equivalent_value"] == 50.0


# ---------------------------------------------------------------------------
# build_financial_analytics_v2: concentration and gain/loss
# ---------------------------------------------------------------------------


class TestAnalyticsV2:
    def _make_canonical(self, holdings, total_value=0.0):
        return {
            "schema_version": 2,
            "holdings": holdings,
            "total_value": total_value,
            "cash_balance": None,
            "quality_report_v2": {},
        }

    def test_concentration_excludes_zero_value(self) -> None:
        holdings = [
            {"symbol": "AAPL", "name": "Apple", "market_value": 1000.0, "is_investable": True},
            {"symbol": "ZERO", "name": "Zero", "market_value": 0.0, "is_investable": True},
        ]
        result = build_financial_analytics_v2(
            canonical_portfolio_v2=self._make_canonical(holdings, 1000.0),
            raw_extract_v2={},
        )
        symbols = [c["symbol"] for c in result["concentration"]]
        assert "ZERO" not in symbols
        assert "AAPL" in symbols

    def test_gain_loss_distribution(self) -> None:
        holdings = [
            {"symbol": "A", "is_investable": True, "unrealized_gain_loss": 100},
            {"symbol": "B", "is_investable": True, "unrealized_gain_loss": -50},
            {"symbol": "C", "is_investable": True, "unrealized_gain_loss": 0},
        ]
        result = build_financial_analytics_v2(
            canonical_portfolio_v2=self._make_canonical(holdings),
            raw_extract_v2={},
        )
        dist = {d["band"]: d["count"] for d in result["gain_loss_distribution"]}
        assert dist == {"gain": 1, "loss": 1, "flat": 1}
        assert result["optimize_signals"]["losers_count"] == 1
        assert result["optimize_signals"]["winners_count"] == 1
