"""Behavioral tests for pure financial calculator functions in operons/kai/calculators.py.

These helpers are the math core of the AlphaAgents framework:
- Financial ratio calculation (calculate_financial_ratios, calculate_quant_metrics)
- Fundamental health scoring (assess_fundamental_health)
- Sentiment scoring (calculate_sentiment_score, extract_catalysts_from_news)
- Valuation metrics (calculate_valuation_metrics)
- Return/risk statistics (calculate_annualized_return, calculate_annualized_volatility,
  calculate_sharpe_ratio, calculate_return_and_risk_metrics)

All functions are pure — no network, DB, LLM, or consent layer required.
"""

from __future__ import annotations

import pytest

from hushh_mcp.operons.kai.calculators import (
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
# Helpers
# ---------------------------------------------------------------------------

_FLAT_PRICES = [100.0] * 253  # 252 intervals, flat — 0% return, 0 volatility


def _make_filing(
    *,
    revenue=1_000_000_000,
    net_income=150_000_000,
    total_assets=2_000_000_000,
    total_liabilities=800_000_000,
    free_cash_flow=120_000_000,
    long_term_debt=400_000_000,
    equity=None,
    research_and_development=50_000_000,
    operating_cash_flow=200_000_000,
    ticker="TEST",
    cik="0001234567",
) -> dict:
    latest = {
        "revenue": revenue,
        "net_income": net_income,
        "total_assets": total_assets,
        "total_liabilities": total_liabilities,
        "free_cash_flow": free_cash_flow,
        "long_term_debt": long_term_debt,
        "research_and_development": research_and_development,
        "operating_cash_flow": operating_cash_flow,
    }
    if equity is not None:
        latest["equity"] = equity
    return {"ticker": ticker, "cik": cik, "entity_name": "Test Corp", "latest_10k": latest}


# ---------------------------------------------------------------------------
# calculate_financial_ratios
# ---------------------------------------------------------------------------


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

    def test_zero_revenue_yields_zero_margin_ratios(self):
        r = calculate_financial_ratios(_make_filing(revenue=0))
        assert r["profit_margin"] == 0
        assert r["fcf_margin"] == 0
        assert r["rnd_intensity"] == 0

    def test_zero_net_income_yields_zero_earnings_quality(self):
        r = calculate_financial_ratios(_make_filing(net_income=0))
        assert r["earnings_quality"] == 0

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
        assert r["profit_margin"] == 0
        assert r["revenue_billions"] == 0


# ---------------------------------------------------------------------------
# calculate_quant_metrics
# ---------------------------------------------------------------------------


class TestCalculateQuantMetrics:
    def _filing_with_trends(self, rev_trend, ni_trend=None, ocf_trend=None, rnd_trend=None):
        return {
            "latest_10k": {
                "revenue_trend": rev_trend,
                "net_income_trend": ni_trend or [],
                "ocf_trend": ocf_trend or [],
                "rnd_trend": rnd_trend or [],
            }
        }

    def test_revenue_growth_yoy_positive(self):
        trend = [{"year": 2023, "value": 1_000_000_000}, {"year": 2024, "value": 1_200_000_000}]
        m = calculate_quant_metrics(self._filing_with_trends(trend))
        assert m["revenue_growth_yoy"] == pytest.approx(0.2)

    def test_revenue_growth_yoy_negative(self):
        trend = [{"year": 2023, "value": 1_000_000_000}, {"year": 2024, "value": 800_000_000}]
        m = calculate_quant_metrics(self._filing_with_trends(trend))
        assert m["revenue_growth_yoy"] == pytest.approx(-0.2)

    def test_single_data_point_growth_is_zero(self):
        trend = [{"year": 2024, "value": 1_000_000_000}]
        m = calculate_quant_metrics(self._filing_with_trends(trend))
        assert m["revenue_growth_yoy"] == 0.0

    def test_empty_trend_growth_is_zero(self):
        m = calculate_quant_metrics(self._filing_with_trends([]))
        assert m["revenue_growth_yoy"] == 0.0

    def test_previous_value_zero_growth_is_zero(self):
        trend = [{"year": 2023, "value": 0}, {"year": 2024, "value": 1_000_000_000}]
        m = calculate_quant_metrics(self._filing_with_trends(trend))
        assert m["revenue_growth_yoy"] == 0.0

    def test_cagr_3y_calculated_correctly(self):
        # 1B → 1.331B over 3 years == 10% CAGR
        trend = [
            {"year": 2021, "value": 1_000_000_000},
            {"year": 2022, "value": 1_100_000_000},
            {"year": 2023, "value": 1_210_000_000},
            {"year": 2024, "value": 1_331_000_000},
        ]
        m = calculate_quant_metrics(self._filing_with_trends(trend))
        assert m["revenue_cagr_3y"] == pytest.approx(0.10, rel=1e-3)

    def test_cagr_3y_zero_when_fewer_than_3_points(self):
        trend = [{"year": 2023, "value": 1e9}, {"year": 2024, "value": 1.2e9}]
        m = calculate_quant_metrics(self._filing_with_trends(trend))
        assert m["revenue_cagr_3y"] == 0

    def test_cagr_3y_zero_when_base_value_zero(self):
        trend = [
            {"year": 2021, "value": 0},
            {"year": 2022, "value": 1e9},
            {"year": 2023, "value": 2e9},
            {"year": 2024, "value": 3e9},
        ]
        m = calculate_quant_metrics(self._filing_with_trends(trend))
        assert m["revenue_cagr_3y"] == 0

    def test_trend_data_converted_to_billions(self):
        trend = [{"year": 2024, "value": 2_000_000_000}]
        m = calculate_quant_metrics(self._filing_with_trends(trend))
        assert m["revenue_trend_data"][0]["value"] == pytest.approx(2.0)

    def test_empty_filing_returns_zeros(self):
        m = calculate_quant_metrics({})
        assert m["revenue_growth_yoy"] == 0.0
        assert m["revenue_cagr_3y"] == 0


# ---------------------------------------------------------------------------
# assess_fundamental_health
# ---------------------------------------------------------------------------


class TestAssessFundamentalHealth:
    def test_all_strong_metrics_high_score(self):
        metrics = {
            "revenue_growth_yoy": 0.20,
            "profit_margin": 0.25,
            "debt_to_equity": 0.3,
            "current_ratio": 2.0,
        }
        strengths, weaknesses, score = assess_fundamental_health(metrics)
        assert len(strengths) == 4
        assert len(weaknesses) == 0
        assert score == pytest.approx(1.0)

    def test_all_weak_metrics_low_score(self):
        metrics = {
            "revenue_growth_yoy": -0.05,
            "profit_margin": 0.02,
            "debt_to_equity": 2.0,
            "current_ratio": 0.8,
        }
        strengths, weaknesses, score = assess_fundamental_health(metrics)
        assert len(weaknesses) == 4
        assert score == pytest.approx(0.0)

    def test_revenue_growth_just_above_threshold_is_strength(self):
        s, w, _ = assess_fundamental_health({"revenue_growth_yoy": 0.101})
        assert any("revenue growth" in x.lower() for x in s)

    def test_revenue_growth_exactly_at_threshold_is_not_strength(self):
        s, _, _ = assess_fundamental_health({"revenue_growth_yoy": 0.1})
        assert not any("revenue growth" in x.lower() for x in s)

    def test_negative_revenue_is_weakness(self):
        _, w, _ = assess_fundamental_health({"revenue_growth_yoy": -0.01})
        assert any("declining" in x.lower() for x in w)

    def test_score_clamps_at_zero(self):
        _, _, score = assess_fundamental_health({})
        assert score >= 0.0

    def test_empty_metrics_default_values_produce_known_classification(self):
        # All metrics default to 0 via .get(..., 0):
        #   debt_to_equity=0 < 0.5 → strength "Low debt levels"
        #   profit_margin=0 < 0.05 → weakness "Low profit margins"
        #   current_ratio=0 < 1.0 → weakness "Liquidity concerns"
        s, w, score = assess_fundamental_health({})
        assert "Low debt levels" in s
        assert any("profit margin" in x.lower() for x in w)
        assert any("liquidity" in x.lower() for x in w)
        # 1 strength, 2 weaknesses → score clamps to 0
        assert score == pytest.approx(0.0)


# ---------------------------------------------------------------------------
# calculate_sentiment_score
# ---------------------------------------------------------------------------


class TestCalculateSentimentScore:
    def test_empty_list_returns_zero(self):
        assert calculate_sentiment_score([]) == 0.0

    def test_single_positive_article(self):
        articles = [{"title": "Company shows strong growth", "description": ""}]
        assert calculate_sentiment_score(articles) == pytest.approx(0.5)

    def test_single_negative_article(self):
        articles = [{"title": "Company misses earnings, decline continues", "description": ""}]
        assert calculate_sentiment_score(articles) == pytest.approx(-0.5)

    def test_neutral_article_scores_zero(self):
        articles = [{"title": "Company announces quarterly results", "description": ""}]
        assert calculate_sentiment_score(articles) == pytest.approx(0.0)

    def test_mixed_articles_averaged(self):
        articles = [
            {"title": "strong growth beats expectations", "description": ""},
            {"title": "decline and concern in earnings", "description": ""},
        ]
        # one +0.5, one -0.5 → average 0.0
        assert calculate_sentiment_score(articles) == pytest.approx(0.0)

    def test_keyword_in_description_counted(self):
        articles = [{"title": "Quarterly update", "description": "bullish outlook ahead"}]
        assert calculate_sentiment_score(articles) == pytest.approx(0.5)

    def test_more_positive_keywords_win(self):
        articles = [{"title": "strong growth beats upgrade positive", "description": "bearish"}]
        # 4 positive, 1 negative → pos wins → 0.5
        assert calculate_sentiment_score(articles) == pytest.approx(0.5)

    def test_article_without_title_or_description(self):
        articles = [{}]
        assert calculate_sentiment_score(articles) == pytest.approx(0.0)


# ---------------------------------------------------------------------------
# extract_catalysts_from_news
# ---------------------------------------------------------------------------


class TestExtractCatalystsFromNews:
    def test_empty_list_returns_empty(self):
        assert extract_catalysts_from_news([]) == []

    def test_earnings_keyword_detected(self):
        articles = [{"title": "Apple Q3 Earnings Beat Estimates"}]
        catalysts = extract_catalysts_from_news(articles)
        assert len(catalysts) == 1
        assert "Apple Q3 Earnings" in catalysts[0]

    def test_title_truncated_to_100_chars(self):
        long_title = "A" * 150
        articles = [{"title": "earnings " + long_title}]
        catalysts = extract_catalysts_from_news(articles)
        assert len(catalysts[0]) <= 100

    def test_capped_at_five_catalysts(self):
        articles = [{"title": f"earnings report {i}"} for i in range(20)]
        catalysts = extract_catalysts_from_news(articles)
        assert len(catalysts) <= 5

    def test_only_first_matching_keyword_per_article(self):
        articles = [{"title": "earnings acquisition partnership"}]
        catalysts = extract_catalysts_from_news(articles)
        assert len(catalysts) == 1

    def test_no_matching_keyword_skipped(self):
        articles = [{"title": "Weather forecast for tomorrow"}]
        assert extract_catalysts_from_news(articles) == []

    def test_only_first_ten_articles_scanned(self):
        articles = [{"title": "no match"} for _ in range(15)]
        articles[14]["title"] = "acquisition announced"
        # article 14 is beyond the top-10 window
        assert extract_catalysts_from_news(articles) == []


# ---------------------------------------------------------------------------
# calculate_valuation_metrics
# ---------------------------------------------------------------------------


class TestCalculateValuationMetrics:
    def test_typical_market_data(self):
        data = {
            "pe_ratio": 25.0,
            "pb_ratio": 4.5,
            "dividend_yield": 0.012,
            "market_cap": 2_000_000_000_000,
        }
        m = calculate_valuation_metrics(data)
        assert m["pe_ratio"] == 25.0
        assert m["pb_ratio"] == 4.5
        assert m["enterprise_value_billions"] == pytest.approx(2000.0)

    def test_zero_market_cap_yields_zero_ev(self):
        m = calculate_valuation_metrics({"market_cap": 0})
        assert m["enterprise_value_billions"] == 0

    def test_empty_dict_returns_zero_metrics(self):
        m = calculate_valuation_metrics({})
        assert m["pe_ratio"] == 0
        assert m["enterprise_value_billions"] == 0

    def test_none_pe_ratio_coerced_to_zero(self):
        m = calculate_valuation_metrics({"pe_ratio": None})
        assert m["pe_ratio"] == 0


# ---------------------------------------------------------------------------
# calculate_annualized_return
# ---------------------------------------------------------------------------


class TestCalculateAnnualizedReturn:
    def test_empty_list_returns_zero(self):
        assert calculate_annualized_return([]) == 0.0

    def test_single_price_returns_zero(self):
        assert calculate_annualized_return([100.0]) == 0.0

    def test_flat_prices_return_zero(self):
        assert calculate_annualized_return(_FLAT_PRICES) == pytest.approx(0.0, abs=1e-10)

    def test_doubling_over_252_days_approximates_100pct(self):
        # 252 intervals (253 prices): double → annualized ≈ 100%
        prices = [100.0] + [200.0] * 252
        r = calculate_annualized_return(prices)
        assert r == pytest.approx(1.0, rel=0.01)

    def test_10pct_gain_over_252_intervals(self):
        prices = [100.0, 110.0]  # 1 interval — annualized to 252 days
        r = calculate_annualized_return(prices)
        # (1.1)^252 - 1, far above 10%, just check positive and > 0.1
        assert r > 0.10

    def test_50pct_loss_negative_return(self):
        prices = [100.0] + [50.0] * 252
        r = calculate_annualized_return(prices)
        assert r < 0

    def test_zero_starting_price_returns_zero(self):
        assert calculate_annualized_return([0.0, 100.0]) == 0.0

    def test_negative_starting_price_returns_zero(self):
        assert calculate_annualized_return([-10.0, 100.0]) == 0.0


# ---------------------------------------------------------------------------
# calculate_annualized_volatility
# ---------------------------------------------------------------------------


class TestCalculateAnnualizedVolatility:
    def test_empty_list_returns_zero(self):
        assert calculate_annualized_volatility([]) == 0.0

    def test_two_prices_returns_zero(self):
        assert calculate_annualized_volatility([100.0, 110.0]) == 0.0

    def test_flat_prices_returns_zero(self):
        assert calculate_annualized_volatility(_FLAT_PRICES) == pytest.approx(0.0, abs=1e-10)

    def test_volatile_series_positive(self):
        # Alternating prices create non-zero log returns
        prices = [100.0, 110.0, 90.0, 105.0, 95.0, 100.0]
        vol = calculate_annualized_volatility(prices)
        assert vol > 0

    def test_returns_reasonable_magnitude(self):
        # Typical equity volatility ~15-40% annualized
        import random

        random.seed(42)
        prices = [100.0]
        for _ in range(252):
            prices.append(prices[-1] * (1 + random.gauss(0, 0.01)))
        vol = calculate_annualized_volatility(prices)
        # Daily sigma 1% → annualized ≈ 16%
        assert 0.10 < vol < 0.30

    def test_series_with_zero_price_skipped(self):
        # A zero mid-series price: that pair's log return is skipped
        prices = [100.0, 0.0, 110.0, 105.0]
        vol = calculate_annualized_volatility(prices)
        assert vol >= 0.0


# ---------------------------------------------------------------------------
# calculate_sharpe_ratio
# ---------------------------------------------------------------------------


class TestCalculateSharpeRatio:
    def test_flat_prices_returns_zero(self):
        # zero volatility → Sharpe 0
        assert calculate_sharpe_ratio(_FLAT_PRICES) == 0.0

    def test_insufficient_prices_returns_zero(self):
        assert calculate_sharpe_ratio([100.0, 110.0]) == 0.0

    def test_positive_excess_return_positive_sharpe(self):
        # 10x growth over 252 intervals → very large return, any positive vol → positive Sharpe
        prices = [100.0] + [1000.0] * 252
        sharpe = calculate_sharpe_ratio(prices, risk_free_rate=0.05)
        assert sharpe > 0

    def test_negative_excess_return_negative_sharpe(self):
        prices = [100.0] + [10.0] * 252
        sharpe = calculate_sharpe_ratio(prices, risk_free_rate=0.05)
        assert sharpe < 0

    def test_custom_risk_free_rate_used(self):
        prices = [100.0] + [1000.0] * 252
        sharpe_0 = calculate_sharpe_ratio(prices, risk_free_rate=0.0)
        sharpe_5 = calculate_sharpe_ratio(prices, risk_free_rate=0.05)
        assert sharpe_0 > sharpe_5


# ---------------------------------------------------------------------------
# calculate_return_and_risk_metrics (wrapper)
# ---------------------------------------------------------------------------


class TestCalculateReturnAndRiskMetrics:
    def test_returns_all_three_keys(self):
        result = calculate_return_and_risk_metrics(_FLAT_PRICES)
        assert set(result.keys()) == {"annualized_return", "annualized_volatility", "sharpe_ratio"}

    def test_values_consistent_with_individual_functions(self):
        prices = [100.0 + i * 0.5 for i in range(100)]
        result = calculate_return_and_risk_metrics(prices, risk_free_rate=0.03)
        assert result["annualized_return"] == pytest.approx(
            calculate_annualized_return(prices), rel=1e-9
        )
        assert result["annualized_volatility"] == pytest.approx(
            calculate_annualized_volatility(prices), rel=1e-9
        )
        assert result["sharpe_ratio"] == pytest.approx(
            calculate_sharpe_ratio(prices, 0.03), rel=1e-9
        )
