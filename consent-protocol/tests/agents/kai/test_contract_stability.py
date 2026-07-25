import pytest

from hushh_mcp.agents.kai.debate_engine import DebateEngine
from hushh_mcp.agents.kai.fundamental_agent import FundamentalInsight
from hushh_mcp.agents.kai.macro_agent import MacroInsight
from hushh_mcp.agents.kai.sentiment_agent import SentimentInsight
from hushh_mcp.agents.kai.valuation_agent import ValuationInsight


def _fundamental():
    return FundamentalInsight(
        summary="Test",
        key_metrics={},
        quant_metrics={},
        business_moat="test",
        financial_resilience="test",
        growth_efficiency="test",
        bull_case="test",
        bear_case="test",
        sources=[],
        confidence=0.8,
        recommendation="buy",
    )


def _sentiment():
    return SentimentInsight(
        summary="Test",
        sentiment_score=0.5,
        key_catalysts=[],
        news_highlights=[],
        sources=[],
        confidence=0.8,
        recommendation="buy",
    )


def _valuation():
    return ValuationInsight(
        summary="Test",
        valuation_metrics={},
        peer_comparison={},
        price_targets={},
        sources=[],
        confidence=0.8,
        recommendation="buy",
    )


def _macro():
    return MacroInsight(
        summary="Test",
        interest_rate_impact="test",
        inflation_impact="test",
        sector_trend="test",
        macro_bull_case="test",
        macro_bear_case="test",
        confidence=0.8,
        recommendation="hold",
        sources=[],
    )


@pytest.mark.asyncio
async def test_debate_engine_backwards_compatibility():
    """Verify engine still works with exactly 3 agents."""
    engine = DebateEngine()
    result = await engine._build_consensus(_fundamental(), _sentiment(), _valuation())
    assert result.decision == "buy"
    assert "macro" not in result.agent_votes
    assert len(result.agent_votes) == 3


@pytest.mark.asyncio
async def test_debate_engine_with_macro():
    """Verify engine handles optional 4th agent."""
    engine = DebateEngine()
    result = await engine._build_consensus(_fundamental(), _sentiment(), _valuation(), _macro())
    assert "macro" in result.agent_votes
    assert len(result.agent_votes) == 4
