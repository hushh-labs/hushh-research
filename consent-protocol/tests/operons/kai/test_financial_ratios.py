"""Financial-ratio measurement and missing-value contracts."""

import pytest

from hushh_mcp.operons.kai.calculators import calculate_financial_ratios
from tests.helpers.financial_filing import _make_filing


class TestCalculateFinancialRatios:
    def test_typical_filing_produces_expected_ratios(self):
        filing = _make_filing()
        r = calculate_financial_ratios(filing)

        assert r["profit_margin"] == pytest.approx(0.15)
        assert r["fcf_margin"] == pytest.approx(0.12)
        assert r["revenue_billions"] == pytest.approx(1.0)
        assert r["return_on_equity"] > 0

    def test_ticker_cik_entity_name_propagated(self):
        r = calculate_financial_ratios(_make_filing(ticker="AAPL", cik="0000320193"))
        assert r["ticker"] == "AAPL"
        assert r["cik"] == "0000320193"
        assert r["entity_name"] == "Test Corp"

    def test_zero_revenue_yields_unavailable_margin_ratios(self):
        r = calculate_financial_ratios(_make_filing(revenue=0))
        assert r["profit_margin"] is None
        assert r["fcf_margin"] is None
        assert r["rnd_intensity"] is None

    def test_zero_net_income_yields_unavailable_earnings_quality(self):
        r = calculate_financial_ratios(_make_filing(net_income=0))
        assert r["earnings_quality"] is None

    def test_explicit_equity_takes_precedence(self):
        filing = _make_filing(equity=500_000_000, net_income=50_000_000)
        r = calculate_financial_ratios(filing)
        assert r["return_on_equity"] == pytest.approx(0.1)

    def test_debt_to_equity_correct(self):
        filing = _make_filing(long_term_debt=600_000_000, equity=1_200_000_000)
        r = calculate_financial_ratios(filing)
        assert r["debt_to_equity"] == pytest.approx(0.5)

    def test_negative_fcf_propagated(self):
        r = calculate_financial_ratios(_make_filing(free_cash_flow=-50_000_000))
        assert r["fcf_billions"] == pytest.approx(-0.05)
        assert r["fcf_margin"] == pytest.approx(-0.05)

    def test_empty_filing_uses_safe_defaults(self):
        r = calculate_financial_ratios({})
        assert isinstance(r, dict)
        assert r["profit_margin"] is None
        assert r["revenue_billions"] is None


class TestFinancialRatios:
    def _minimal_filing(self, **overrides):
        base = {
            "latest_10k": {
                "revenue": 1_000_000_000,
                "net_income": 100_000_000,
                "total_assets": 500_000_000,
                "total_liabilities": 200_000_000,
                "free_cash_flow": 80_000_000,
                "long_term_debt": 50_000_000,
                "research_and_development": 30_000_000,
                "operating_cash_flow": 90_000_000,
            }
        }
        base["latest_10k"].update(overrides)
        return base

    def test_profit_margin_calculated(self):
        filing = self._minimal_filing()
        result = calculate_financial_ratios(filing)
        assert result["profit_margin"] == pytest.approx(0.1, rel=1e-6)

    def test_zero_revenue_no_division_error(self):
        filing = self._minimal_filing(revenue=0)
        result = calculate_financial_ratios(filing)
        assert result["profit_margin"] is None
        assert result["fcf_margin"] is None
        assert result["rnd_intensity"] is None

    def test_zero_net_income_no_division_error(self):
        filing = self._minimal_filing(net_income=0)
        result = calculate_financial_ratios(filing)
        assert result["earnings_quality"] is None

    def test_revenue_billions_conversion(self):
        filing = self._minimal_filing(revenue=2_000_000_000)
        result = calculate_financial_ratios(filing)
        assert result["revenue_billions"] == pytest.approx(2.0, rel=1e-6)

    def test_all_required_keys_present(self):
        result = calculate_financial_ratios(self._minimal_filing())
        for key in (
            "profit_margin",
            "fcf_margin",
            "debt_to_equity",
            "return_on_equity",
            "rnd_intensity",
            "earnings_quality",
            "revenue_billions",
            "fcf_billions",
        ):
            assert key in result, f"Missing key: {key}"

    def test_empty_filing_no_crash(self):
        result = calculate_financial_ratios({})
        assert isinstance(result, dict)
