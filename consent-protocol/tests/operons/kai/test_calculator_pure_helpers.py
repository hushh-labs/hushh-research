"""Hermetic unit tests for hushh_mcp/operons/kai/calculators.py.

All seven pure calculation functions are tested with no DB, network, or LLM.
Focus areas:
- Edge cases that cause silent wrong answers (zero prices, empty lists,
  single-element series, constant prices, all-negative returns)
- Division-by-zero guards in financial ratios
- AlphaAgents formula correctness for return/volatility/Sharpe
- Sentiment keyword matching and boundary scoring
- Catalyst extraction limits
- Health score clamping
"""

from __future__ import annotations

import math

import pytest

from hushh_mcp.operons.kai.calculators import (
    TRADING_DAYS_PER_YEAR,
    assess_fundamental_health,
    calculate_annualized_return,
    calculate_annualized_volatility,
    calculate_financial_ratios,
    calculate_quant_metrics,
    calculate_return_and_risk_metrics,
    calculate_sentiment_score,
    calculate_sharpe_ratio,
    calculate_valuation_metrics,
    extract_catalysts_from_news,
)

# ---------------------------------------------------------------------------
# calculate_annualized_return
# ---------------------------------------------------------------------------


class TestAnnualizedReturn:
    def test_empty_list_returns_zero(self):
        assert calculate_annualized_return([]) == 0.0

    def test_single_price_returns_zero(self):
        assert calculate_annualized_return([100.0]) == 0.0

    def test_zero_initial_price_returns_zero(self):
        assert calculate_annualized_return([0.0, 100.0]) == 0.0

    def test_negative_initial_price_returns_zero(self):
        assert calculate_annualized_return([-10.0, 100.0]) == 0.0

    def test_constant_prices_return_zero(self):
        prices = [100.0] * 10
        assert calculate_annualized_return(prices) == pytest.approx(0.0, abs=1e-9)

    def test_doubling_over_252_days(self):
        # P_T/P_0 = 2 over exactly 252 intervals -> annualized = 100%
        prices = [100.0] + [200.0] * 252
        result = calculate_annualized_return(prices)
        assert result == pytest.approx(1.0, rel=1e-6)

    def test_halving_gives_negative_return(self):
        prices = [100.0] + [50.0] * 252
        result = calculate_annualized_return(prices)
        # (0.5)^(252/252) - 1 = -0.5
        assert result == pytest.approx(-0.5, rel=1e-6)

    def test_two_prices_only(self):
        # T=1 interval -> annualized = (P1/P0)^252 - 1
        result = calculate_annualized_return([100.0, 101.0])
        expected = (101.0 / 100.0) ** TRADING_DAYS_PER_YEAR - 1.0
        assert result == pytest.approx(expected, rel=1e-6)

    def test_large_growth_no_overflow(self):
        # Should not raise OverflowError
        result = calculate_annualized_return([0.001, 10_000.0])
        assert isinstance(result, float)

    def test_return_type_is_float(self):
        assert isinstance(calculate_annualized_return([100.0, 110.0]), float)


# ---------------------------------------------------------------------------
# calculate_annualized_volatility
# ---------------------------------------------------------------------------


class TestAnnualizedVolatility:
    def test_empty_list_returns_zero(self):
        assert calculate_annualized_volatility([]) == 0.0

    def test_single_price_returns_zero(self):
        assert calculate_annualized_volatility([100.0]) == 0.0

    def test_two_prices_returns_zero(self):
        # Need at least 3 prices (2 log-return observations for std dev)
        assert calculate_annualized_volatility([100.0, 110.0]) == 0.0

    def test_constant_prices_return_zero(self):
        # Log returns are all 0 -> std dev = 0
        prices = [100.0] * 20
        assert calculate_annualized_volatility(prices) == pytest.approx(0.0, abs=1e-9)

    def test_alternating_prices_positive_volatility(self):
        prices = [100.0, 110.0, 100.0, 110.0, 100.0]
        result = calculate_annualized_volatility(prices)
        assert result > 0

    def test_annualized_by_sqrt_252(self):
        # With exactly 2 log returns [ln(110/100), ln(100/110)], compute manually
        prices = [100.0, 110.0, 100.0]
        r1 = math.log(110.0 / 100.0)
        r2 = math.log(100.0 / 110.0)
        mean_r = (r1 + r2) / 2
        variance = ((r1 - mean_r) ** 2 + (r2 - mean_r) ** 2) / 1  # ddof=1
        expected = math.sqrt(variance) * math.sqrt(TRADING_DAYS_PER_YEAR)
        result = calculate_annualized_volatility(prices)
        assert result == pytest.approx(expected, rel=1e-9)

    def test_zero_prices_skipped(self):
        # Zero prices produce invalid log returns and should be skipped
        prices = [100.0, 0.0, 110.0, 100.0]
        result = calculate_annualized_volatility(prices)
        # Should not raise; result is based on valid pairs only
        assert isinstance(result, float)
        assert result >= 0.0

    def test_return_type_is_float(self):
        assert isinstance(calculate_annualized_volatility([100.0, 110.0, 105.0]), float)


# ---------------------------------------------------------------------------
# calculate_sharpe_ratio
# ---------------------------------------------------------------------------


class TestSharpeRatio:
    def test_empty_list_returns_zero(self):
        assert calculate_sharpe_ratio([]) == 0.0

    def test_single_price_returns_zero(self):
        assert calculate_sharpe_ratio([100.0]) == 0.0

    def test_constant_prices_return_zero(self):
        # Volatility = 0 -> Sharpe = 0 (guard against division by zero)
        prices = [100.0] * 20
        assert calculate_sharpe_ratio(prices) == 0.0

    def test_positive_return_above_risk_free(self):
        # Rising prices -> positive excess return -> positive Sharpe
        prices = [100.0 * (1.001**i) for i in range(252)]
        result = calculate_sharpe_ratio(prices, risk_free_rate=0.0)
        assert result > 0.0

    def test_negative_return_gives_negative_sharpe(self):
        # Declining prices -> negative annualized return -> negative Sharpe
        prices = [100.0 * (0.999**i) for i in range(252)]
        result = calculate_sharpe_ratio(prices, risk_free_rate=0.0)
        assert result < 0.0

    def test_formula_sharpe_equals_excess_over_vol(self):
        prices = [100.0, 105.0, 102.0, 108.0, 106.0, 110.0]
        r_ann = calculate_annualized_return(prices)
        sig_ann = calculate_annualized_volatility(prices)
        rf = 0.05
        if sig_ann > 0:
            expected = (r_ann - rf) / sig_ann
            assert calculate_sharpe_ratio(prices, risk_free_rate=rf) == pytest.approx(
                expected, rel=1e-9
            )

    def test_risk_free_rate_default_is_five_percent(self):
        prices = [100.0 * (1.001**i) for i in range(100)]
        default_result = calculate_sharpe_ratio(prices)
        explicit_result = calculate_sharpe_ratio(prices, risk_free_rate=0.05)
        assert default_result == explicit_result

    def test_return_type_is_float(self):
        assert isinstance(calculate_sharpe_ratio([100.0, 110.0, 105.0, 115.0]), float)


# ---------------------------------------------------------------------------
# calculate_return_and_risk_metrics (convenience wrapper)
# ---------------------------------------------------------------------------


class TestReturnAndRiskMetrics:
    def test_keys_present(self):
        result = calculate_return_and_risk_metrics([100.0, 105.0, 103.0, 108.0])
        assert "annualized_return" in result
        assert "annualized_volatility" in result
        assert "sharpe_ratio" in result

    def test_consistent_with_individual_functions(self):
        prices = [100.0, 102.0, 101.0, 104.0, 103.0]
        rf = 0.03
        result = calculate_return_and_risk_metrics(prices, risk_free_rate=rf)
        assert result["annualized_return"] == pytest.approx(
            calculate_annualized_return(prices), rel=1e-9
        )
        assert result["annualized_volatility"] == pytest.approx(
            calculate_annualized_volatility(prices), rel=1e-9
        )
        assert result["sharpe_ratio"] == pytest.approx(
            calculate_sharpe_ratio(prices, risk_free_rate=rf), rel=1e-9
        )

    def test_empty_prices_all_zeros(self):
        result = calculate_return_and_risk_metrics([])
        assert result["annualized_return"] == 0.0
        assert result["annualized_volatility"] == 0.0
        assert result["sharpe_ratio"] == 0.0


# ---------------------------------------------------------------------------
# calculate_sentiment_score
# ---------------------------------------------------------------------------


class TestSentimentScore:
    def test_empty_articles_returns_zero(self):
        assert calculate_sentiment_score([]) == 0.0

    def test_positive_keywords_score_positive(self):
        articles = [{"title": "Company reports strong growth", "description": "bullish outlook"}]
        result = calculate_sentiment_score(articles)
        assert result > 0.0

    def test_negative_keywords_score_negative(self):
        articles = [{"title": "Stock faces decline and concern", "description": "bearish market"}]
        result = calculate_sentiment_score(articles)
        assert result < 0.0

    def test_neutral_article_scores_zero(self):
        articles = [{"title": "Company releases annual report", "description": ""}]
        result = calculate_sentiment_score(articles)
        assert result == 0.0

    def test_score_bounded_between_neg1_and_pos1(self):
        articles = [
            {"title": "strong growth beat upgrade bullish positive", "description": ""},
            {"title": "decline miss downgrade bearish negative concern", "description": ""},
        ]
        result = calculate_sentiment_score(articles)
        assert -1.0 <= result <= 1.0

    def test_mixed_articles_average_correctly(self):
        articles = [
            {"title": "strong growth", "description": ""},  # positive -> 0.5
            {"title": "decline concern", "description": ""},  # negative -> -0.5
        ]
        result = calculate_sentiment_score(articles)
        assert result == pytest.approx(0.0, abs=1e-9)

    def test_missing_keys_handled_gracefully(self):
        # Articles without title or description should not raise
        articles = [{}, {"title": "growth"}, {"description": "decline"}]
        result = calculate_sentiment_score(articles)
        assert isinstance(result, float)

    def test_return_type_is_float(self):
        articles = [{"title": "strong growth", "description": ""}]
        assert isinstance(calculate_sentiment_score(articles), float)


# ---------------------------------------------------------------------------
# extract_catalysts_from_news
# ---------------------------------------------------------------------------


class TestExtractCatalystsFromNews:
    def test_empty_articles_returns_empty(self):
        assert extract_catalysts_from_news([]) == []

    def test_earnings_keyword_extracted(self):
        articles = [{"title": "Company beats earnings estimates for Q3"}]
        result = extract_catalysts_from_news(articles)
        assert len(result) == 1
        assert "earnings" in result[0].lower()

    def test_no_catalyst_keywords_returns_empty(self):
        articles = [{"title": "Market opens flat on Monday"}]
        assert extract_catalysts_from_news(articles) == []

    def test_max_five_catalysts_returned(self):
        articles = [{"title": f"Company {i} announces earnings surprise"} for i in range(20)]
        result = extract_catalysts_from_news(articles)
        assert len(result) <= 5

    def test_only_top_10_articles_scanned(self):
        # Only the first 10 articles are scanned even if more exist
        no_keyword_articles = [{"title": "Flat market day"} for _ in range(10)]
        keyword_article = [{"title": "Big acquisition announced"}]
        articles = no_keyword_articles + keyword_article
        result = extract_catalysts_from_news(articles)
        # The 11th article is beyond the scan window -> no catalysts
        assert result == []

    def test_title_truncated_to_100_chars(self):
        long_title = "A" * 200 + " earnings announcement"
        articles = [{"title": long_title}]
        result = extract_catalysts_from_news(articles)
        if result:
            assert len(result[0]) <= 100

    def test_missing_title_handled(self):
        articles = [{"description": "earnings news"}]
        result = extract_catalysts_from_news(articles)
        assert isinstance(result, list)


# ---------------------------------------------------------------------------
# calculate_financial_ratios
# ---------------------------------------------------------------------------


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
        assert result["profit_margin"] == 0.0
        assert result["fcf_margin"] == 0.0
        assert result["rnd_intensity"] == 0.0

    def test_zero_net_income_no_division_error(self):
        filing = self._minimal_filing(net_income=0)
        result = calculate_financial_ratios(filing)
        assert result["earnings_quality"] == 0.0

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


# ---------------------------------------------------------------------------
# assess_fundamental_health
# ---------------------------------------------------------------------------


class TestFundamentalHealth:
    def test_strong_metrics_produce_positive_score(self):
        metrics = {
            "revenue_growth_yoy": 0.2,
            "profit_margin": 0.2,
            "debt_to_equity": 0.3,
            "current_ratio": 2.0,
        }
        strengths, weaknesses, score = assess_fundamental_health(metrics)
        assert score > 0.0
        assert len(strengths) > 0

    def test_weak_metrics_produce_weaknesses(self):
        metrics = {
            "revenue_growth_yoy": -0.1,
            "profit_margin": 0.02,
            "debt_to_equity": 2.0,
            "current_ratio": 0.8,
        }
        _, weaknesses, score = assess_fundamental_health(metrics)
        assert len(weaknesses) > 0

    def test_health_score_clamped_to_zero_minimum(self):
        metrics = {
            "revenue_growth_yoy": -0.5,
            "profit_margin": -0.2,
            "debt_to_equity": 5.0,
            "current_ratio": 0.3,
        }
        _, _, score = assess_fundamental_health(metrics)
        assert score >= 0.0

    def test_health_score_max_one(self):
        metrics = {
            "revenue_growth_yoy": 0.5,
            "profit_margin": 0.5,
            "debt_to_equity": 0.1,
            "current_ratio": 3.0,
        }
        _, _, score = assess_fundamental_health(metrics)
        assert score <= 1.0

    def test_empty_metrics_no_crash(self):
        strengths, weaknesses, score = assess_fundamental_health({})
        assert isinstance(strengths, list)
        assert isinstance(weaknesses, list)
        assert isinstance(score, float)

    def test_return_tuple_structure(self):
        result = assess_fundamental_health({})
        assert len(result) == 3


# ---------------------------------------------------------------------------
# calculate_valuation_metrics
# ---------------------------------------------------------------------------


class TestValuationMetrics:
    def test_pe_ratio_passed_through(self):
        result = calculate_valuation_metrics({"pe_ratio": 25.0})
        assert result["pe_ratio"] == pytest.approx(25.0)

    def test_zero_market_cap_ev_is_zero(self):
        result = calculate_valuation_metrics({"market_cap": 0})
        assert result["enterprise_value_billions"] == 0.0

    def test_market_cap_billions_conversion(self):
        result = calculate_valuation_metrics({"market_cap": 3_000_000_000})
        assert result["enterprise_value_billions"] == pytest.approx(3.0, rel=1e-6)

    def test_missing_keys_default_to_zero(self):
        result = calculate_valuation_metrics({})
        assert result["pe_ratio"] == 0.0
        assert result["pb_ratio"] == 0.0
        assert result["dividend_yield"] == 0.0

    def test_all_keys_present(self):
        result = calculate_valuation_metrics({})
        for key in (
            "pe_ratio",
            "pb_ratio",
            "ps_ratio",
            "dividend_yield",
            "enterprise_value_billions",
        ):
            assert key in result


# ---------------------------------------------------------------------------
# calculate_quant_metrics
# ---------------------------------------------------------------------------


class TestQuantMetrics:
    def _trend(self, values):
        return [{"year": 2020 + i, "value": v} for i, v in enumerate(values)]

    def test_empty_trends_return_zero_growth(self):
        result = calculate_quant_metrics({})
        assert result["revenue_growth_yoy"] == 0.0
        assert result["net_income_growth_yoy"] == 0.0

    def test_revenue_growth_calculated(self):
        filing = {
            "latest_10k": {
                "revenue_trend": self._trend([1_000_000_000, 1_200_000_000]),
            }
        }
        result = calculate_quant_metrics(filing)
        assert result["revenue_growth_yoy"] == pytest.approx(0.2, rel=1e-6)

    def test_zero_previous_revenue_returns_zero_growth(self):
        filing = {
            "latest_10k": {
                "revenue_trend": self._trend([0, 1_000_000_000]),
            }
        }
        result = calculate_quant_metrics(filing)
        assert result["revenue_growth_yoy"] == 0.0

    def test_cagr_3y_calculated(self):
        filing = {
            "latest_10k": {
                "revenue_trend": self._trend([1_000_000_000, 1_100_000_000, 1_300_000_000]),
            }
        }
        result = calculate_quant_metrics(filing)
        expected = (1_300_000_000 / 1_000_000_000) ** (1 / 3) - 1
        assert result["revenue_cagr_3y"] == pytest.approx(expected, rel=1e-6)

    def test_fewer_than_3_years_cagr_zero(self):
        filing = {
            "latest_10k": {
                "revenue_trend": self._trend([1_000_000_000, 1_200_000_000]),
            }
        }
        result = calculate_quant_metrics(filing)
        assert result["revenue_cagr_3y"] == 0.0

    def test_trend_data_converted_to_billions(self):
        filing = {
            "latest_10k": {
                "revenue_trend": self._trend([2_000_000_000, 3_000_000_000]),
            }
        }
        result = calculate_quant_metrics(filing)
        values = [d["value"] for d in result["revenue_trend_data"]]
        assert values == [pytest.approx(2.0, rel=1e-6), pytest.approx(3.0, rel=1e-6)]
