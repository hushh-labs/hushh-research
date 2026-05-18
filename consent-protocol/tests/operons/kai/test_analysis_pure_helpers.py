"""Pure-helper unit tests for hushh_mcp/operons/kai/analysis.py.

All tests are hermetic: no network, no LLM, no database.
Directly exercises the eight module-level helper functions.
"""

from __future__ import annotations

import pytest

from hushh_mcp.operons.kai.analysis import (
    _calculate_sentiment_confidence,
    _calculate_valuation_confidence,
    _compare_to_peers,
    _fundamental_to_recommendation,
    _generate_fundamental_summary,
    _generate_sentiment_summary,
    _generate_valuation_summary,
    _sentiment_to_recommendation,
    _valuation_to_recommendation,
)

# ---------------------------------------------------------------------------
# _generate_fundamental_summary
# ---------------------------------------------------------------------------


class TestGenerateFundamentalSummary:
    def test_strong_tone_above_75(self):
        metrics = {"revenue_growth_yoy": 0.20, "profit_margin": 0.15}
        result = _generate_fundamental_summary("AAPL", metrics, health_score=0.80)
        assert result.startswith("Strong")

    def test_solid_tone_between_50_and_75(self):
        metrics = {"revenue_growth_yoy": 0.10, "profit_margin": 0.08}
        result = _generate_fundamental_summary("MSFT", metrics, health_score=0.60)
        assert result.startswith("Solid")

    def test_weak_tone_below_50(self):
        metrics = {"revenue_growth_yoy": -0.05, "profit_margin": 0.01}
        result = _generate_fundamental_summary("XYZ", metrics, health_score=0.30)
        assert result.startswith("Weak")

    def test_boundary_exactly_75_is_solid(self):
        # health_score > 0.75 required for "Strong"; 0.75 is not > 0.75
        result = _generate_fundamental_summary("T", {}, health_score=0.75)
        assert result.startswith("Solid")

    def test_boundary_exactly_50_is_weak(self):
        # health_score > 0.5 required for "Solid"; 0.5 is not > 0.5
        result = _generate_fundamental_summary("T", {}, health_score=0.50)
        assert result.startswith("Weak")

    def test_revenue_growth_formatted_as_percent(self):
        metrics = {"revenue_growth_yoy": 0.123}
        result = _generate_fundamental_summary("T", metrics, health_score=0.8)
        assert "12.3%" in result

    def test_profit_margin_formatted_as_percent(self):
        metrics = {"profit_margin": 0.075}
        result = _generate_fundamental_summary("T", metrics, health_score=0.8)
        assert "7.5%" in result

    def test_missing_metrics_defaults_to_zero(self):
        result = _generate_fundamental_summary("T", {}, health_score=0.9)
        assert "0.0%" in result

    def test_negative_growth_represented(self):
        metrics = {"revenue_growth_yoy": -0.10, "profit_margin": 0.05}
        result = _generate_fundamental_summary("T", metrics, health_score=0.3)
        assert "-10.0%" in result


# ---------------------------------------------------------------------------
# _generate_sentiment_summary
# ---------------------------------------------------------------------------


class TestGenerateSentimentSummary:
    def test_positive_above_03(self):
        result = _generate_sentiment_summary("AAPL", 0.5, [])
        assert result.startswith("Positive")

    def test_neutral_between_minus03_and_03(self):
        result = _generate_sentiment_summary("AAPL", 0.0, [])
        assert result.startswith("Neutral")

    def test_negative_below_minus03(self):
        result = _generate_sentiment_summary("AAPL", -0.5, [])
        assert result.startswith("Negative")

    def test_boundary_exactly_03_is_neutral(self):
        # > 0.3 required; 0.3 is not > 0.3
        result = _generate_sentiment_summary("T", 0.3, [])
        assert result.startswith("Neutral")

    def test_boundary_exactly_minus03_is_negative(self):
        # > -0.3 required; -0.3 is not > -0.3
        result = _generate_sentiment_summary("T", -0.3, [])
        assert result.startswith("Negative")

    def test_with_catalyst(self):
        result = _generate_sentiment_summary("T", 0.5, ["Earnings beat"])
        assert "Earnings beat" in result

    def test_no_catalysts_placeholder(self):
        result = _generate_sentiment_summary("T", 0.0, [])
        assert "No major catalysts" in result

    def test_only_first_catalyst_used(self):
        result = _generate_sentiment_summary("T", 0.5, ["Beat EPS", "Revenue miss"])
        assert "Beat EPS" in result
        assert "Revenue miss" not in result


# ---------------------------------------------------------------------------
# _generate_valuation_summary
# ---------------------------------------------------------------------------


class TestGenerateValuationSummary:
    def test_undervalued(self):
        peer = {"vs_peer_avg": "undervalued"}
        result = _generate_valuation_summary("T", {"pe_ratio": 10.0}, peer)
        assert "Undervalued" in result
        assert "10.0x" in result

    def test_overvalued(self):
        peer = {"vs_peer_avg": "overvalued"}
        result = _generate_valuation_summary("T", {"pe_ratio": 30.0}, peer)
        assert "Overvalued" in result
        assert "30.0x" in result

    def test_in_line(self):
        peer = {"vs_peer_avg": "in_line"}
        result = _generate_valuation_summary("T", {"pe_ratio": 20.0}, peer)
        assert "Fair valuation" in result
        assert "20.0x" in result

    def test_default_vs_peers_is_in_line(self):
        # peer_comparison with no vs_peer_avg key → default "in_line"
        result = _generate_valuation_summary("T", {"pe_ratio": 15.0}, {})
        assert "Fair valuation" in result

    def test_zero_pe_ratio(self):
        peer = {"vs_peer_avg": "in_line"}
        result = _generate_valuation_summary("T", {}, peer)
        assert "0.0x" in result


# ---------------------------------------------------------------------------
# _fundamental_to_recommendation
# ---------------------------------------------------------------------------


class TestFundamentalToRecommendation:
    def test_buy_above_07(self):
        assert _fundamental_to_recommendation(0.8, {}) == "buy"

    def test_hold_between_04_and_07(self):
        assert _fundamental_to_recommendation(0.5, {}) == "hold"

    def test_reduce_below_04(self):
        assert _fundamental_to_recommendation(0.2, {}) == "reduce"

    def test_boundary_exactly_07_is_hold(self):
        # > 0.7 required for buy; 0.7 is hold
        assert _fundamental_to_recommendation(0.7, {}) == "hold"

    def test_boundary_exactly_04_is_reduce(self):
        # > 0.4 required for hold; 0.4 is reduce
        assert _fundamental_to_recommendation(0.4, {}) == "reduce"

    def test_zero_is_reduce(self):
        assert _fundamental_to_recommendation(0.0, {}) == "reduce"

    def test_one_is_buy(self):
        assert _fundamental_to_recommendation(1.0, {}) == "buy"


# ---------------------------------------------------------------------------
# _sentiment_to_recommendation
# ---------------------------------------------------------------------------


class TestSentimentToRecommendation:
    def test_buy_above_03(self):
        assert _sentiment_to_recommendation(0.5) == "buy"

    def test_hold_between_minus03_and_03(self):
        assert _sentiment_to_recommendation(0.0) == "hold"

    def test_reduce_below_minus03(self):
        assert _sentiment_to_recommendation(-0.5) == "reduce"

    def test_boundary_exactly_03_is_hold(self):
        # > 0.3 required for buy; 0.3 is hold
        assert _sentiment_to_recommendation(0.3) == "hold"

    def test_boundary_exactly_minus03_is_reduce(self):
        # > -0.3 required for hold; -0.3 is reduce
        assert _sentiment_to_recommendation(-0.3) == "reduce"

    def test_one_is_buy(self):
        assert _sentiment_to_recommendation(1.0) == "buy"

    def test_negative_one_is_reduce(self):
        assert _sentiment_to_recommendation(-1.0) == "reduce"


# ---------------------------------------------------------------------------
# _valuation_to_recommendation
# ---------------------------------------------------------------------------


class TestValuationToRecommendation:
    def test_undervalued_is_buy(self):
        assert _valuation_to_recommendation({}, {"vs_peer_avg": "undervalued"}) == "buy"

    def test_overvalued_is_reduce(self):
        assert _valuation_to_recommendation({}, {"vs_peer_avg": "overvalued"}) == "reduce"

    def test_in_line_is_hold(self):
        assert _valuation_to_recommendation({}, {"vs_peer_avg": "in_line"}) == "hold"

    def test_default_no_vs_peer_is_hold(self):
        # Missing key → default "in_line" → hold
        assert _valuation_to_recommendation({}, {}) == "hold"

    def test_unknown_vs_peer_is_hold(self):
        assert _valuation_to_recommendation({}, {"vs_peer_avg": "unknown"}) == "hold"


# ---------------------------------------------------------------------------
# _calculate_sentiment_confidence
# ---------------------------------------------------------------------------


class TestCalculateSentimentConfidence:
    def test_few_articles_returns_05(self):
        # < 5 articles → 0.5
        assert _calculate_sentiment_confidence([], 0.8) == 0.5
        assert _calculate_sentiment_confidence([{}] * 4, 0.8) == 0.5

    def test_exactly_5_articles_not_low_confidence_floor(self):
        # 5 articles → base = min(5/20, 0.8) = 0.25; score_boost = 0.0 → result = 0.25
        result = _calculate_sentiment_confidence([{}] * 5, 0.0)
        assert result == pytest.approx(0.25)

    def test_20_articles_max_base_confidence(self):
        # 20 articles → base = min(20/20, 0.8) = 0.8; score_boost = 0
        result = _calculate_sentiment_confidence([{}] * 20, 0.0)
        assert result == pytest.approx(0.8)

    def test_extreme_score_boosts_confidence(self):
        low = _calculate_sentiment_confidence([{}] * 10, 0.0)
        high = _calculate_sentiment_confidence([{}] * 10, 1.0)
        assert high > low

    def test_max_confidence_capped_at_1(self):
        result = _calculate_sentiment_confidence([{}] * 100, 1.0)
        assert result <= 1.0

    def test_negative_score_still_boosts_via_abs(self):
        pos = _calculate_sentiment_confidence([{}] * 10, 0.5)
        neg = _calculate_sentiment_confidence([{}] * 10, -0.5)
        assert pos == pytest.approx(neg)

    def test_result_between_0_and_1(self):
        for n in [0, 3, 5, 10, 20, 50]:
            for score in [-1.0, 0.0, 0.5, 1.0]:
                result = _calculate_sentiment_confidence([{}] * n, score)
                assert 0.0 <= result <= 1.0


# ---------------------------------------------------------------------------
# _calculate_valuation_confidence
# ---------------------------------------------------------------------------


class TestCalculateValuationConfidence:
    def test_empty_metrics_is_zero(self):
        assert _calculate_valuation_confidence({}, {}) == 0.0

    def test_all_positive_metrics_capped_at_1(self):
        # 6 positive metrics → min(6/6, 1.0) = 1.0
        metrics = {k: float(i + 1) for i, k in enumerate(["a", "b", "c", "d", "e", "f"])}
        assert _calculate_valuation_confidence(metrics, {}) == pytest.approx(1.0)

    def test_partial_metrics(self):
        metrics = {"pe_ratio": 20.0, "pb_ratio": 3.0, "ps_ratio": 0.0}
        # 0.0 is not > 0, so only 2 positive → 2/6 ≈ 0.333
        result = _calculate_valuation_confidence(metrics, {})
        assert result == pytest.approx(2 / 6)

    def test_none_value_not_counted(self):
        metrics = {"pe_ratio": None, "pb_ratio": 5.0}  # type: ignore[dict-item]
        result = _calculate_valuation_confidence(metrics, {})
        assert result == pytest.approx(1 / 6)

    def test_result_between_0_and_1(self):
        for n in range(7):
            metrics = {str(i): float(i + 1) for i in range(n)}
            result = _calculate_valuation_confidence(metrics, {})
            assert 0.0 <= result <= 1.0


# ---------------------------------------------------------------------------
# _compare_to_peers
# ---------------------------------------------------------------------------


class TestCompareToPeers:
    def test_empty_peer_data_returns_in_line(self):
        result = _compare_to_peers({"pe_ratio": 20.0}, [])
        assert result["vs_peer_avg"] == "in_line"
        assert result["peer_count"] == 0

    def test_undervalued_when_pe_below_80_pct_of_avg(self):
        # peer avg P/E = 25, company = 15 → 15 < 25*0.8=20 → undervalued
        peers = [{"pe_ratio": 25.0}, {"pe_ratio": 25.0}]
        result = _compare_to_peers({"pe_ratio": 15.0}, peers)
        assert result["vs_peer_avg"] == "undervalued"

    def test_overvalued_when_pe_above_120_pct_of_avg(self):
        # peer avg = 20, company = 30 → 30 > 20*1.2=24 → overvalued
        peers = [{"pe_ratio": 20.0}, {"pe_ratio": 20.0}]
        result = _compare_to_peers({"pe_ratio": 30.0}, peers)
        assert result["vs_peer_avg"] == "overvalued"

    def test_in_line_when_pe_within_band(self):
        # peer avg = 20, company = 20 → exactly in band
        peers = [{"pe_ratio": 20.0}]
        result = _compare_to_peers({"pe_ratio": 20.0}, peers)
        assert result["vs_peer_avg"] == "in_line"

    def test_peer_count_matches_input(self):
        peers = [{"pe_ratio": 15.0}] * 5
        result = _compare_to_peers({"pe_ratio": 15.0}, peers)
        assert result["peer_count"] == 5

    def test_peer_avg_pe_in_result(self):
        peers = [{"pe_ratio": 10.0}, {"pe_ratio": 20.0}]
        result = _compare_to_peers({"pe_ratio": 15.0}, peers)
        assert result["peer_avg_pe"] == pytest.approx(15.0)

    def test_company_pe_in_result(self):
        peers = [{"pe_ratio": 20.0}]
        result = _compare_to_peers({"pe_ratio": 18.0}, peers)
        assert result["company_pe"] == pytest.approx(18.0)

    def test_peers_without_pe_ratio_excluded_from_avg(self):
        # Only one valid peer P/E = 20; 0-P/E peer excluded
        peers = [{"pe_ratio": 20.0}, {"pe_ratio": 0}]
        result = _compare_to_peers({"pe_ratio": 5.0}, peers)
        # Only pe_ratio=20 counts → peer_avg_pe=20, company=5 → 5 < 16 → undervalued
        assert result["vs_peer_avg"] == "undervalued"

    def test_peers_all_zero_pe_returns_in_line(self):
        # No valid peer P/Es → peer_pes=[] → early return in_line
        peers = [{"pe_ratio": 0}, {}]
        result = _compare_to_peers({"pe_ratio": 50.0}, peers)
        assert result["vs_peer_avg"] == "in_line"
