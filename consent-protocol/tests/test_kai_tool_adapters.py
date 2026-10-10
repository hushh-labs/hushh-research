"""Kai's analyst tools must read the fields their result dataclasses define.

perform_sentiment_analysis read market_consensus and key_news, and
perform_valuation_analysis read fair_value, upside_potential and
risk_assessment -- none of which exist on SentimentInsight / ValuationInsight.
The AttributeError was caught and every successful analysis was returned to the
Kai chat / A2A agent as {"error": ...}.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from hushh_mcp.agents.kai import tools
from hushh_mcp.agents.kai.sentiment_agent import SentimentInsight
from hushh_mcp.agents.kai.valuation_agent import ValuationInsight
from hushh_mcp.hushh_adk.context import HushhContext


@pytest.mark.asyncio
async def test_sentiment_tool_returns_the_analysis_not_an_error():
    insight = SentimentInsight(
        summary="Constructive news flow.",
        sentiment_score=0.4,
        key_catalysts=["New product cycle"],
        news_highlights=[{"title": f"headline {i}"} for i in range(5)],
        sources=["news"],
        confidence=0.7,
        recommendation="bullish",
    )
    with HushhContext(user_id="owner", consent_token="token"):  # noqa: S106 - fixture
        with patch.object(tools.sentiment_engine, "analyze", AsyncMock(return_value=insight)):
            result = await tools.perform_sentiment_analysis.__wrapped__("AAPL")

    assert "error" not in result
    assert result["key_catalysts"] == ["New product cycle"]
    assert [item["title"] for item in result["news_highlights"]] == [
        "headline 0",
        "headline 1",
        "headline 2",
    ]


@pytest.mark.asyncio
async def test_valuation_tool_returns_the_analysis_not_an_error():
    insight = ValuationInsight(
        summary="Trades near peers.",
        valuation_metrics={"current_price": 230.0, "pe_ratio": 31.0},
        peer_comparison={"median_pe": 28.0},
        price_targets={"base_case": 245.0},
        sources=["filings"],
        confidence=0.6,
        recommendation="fair",
    )
    with HushhContext(user_id="owner", consent_token="token"):  # noqa: S106 - fixture
        with patch.object(tools.valuation_engine, "analyze", AsyncMock(return_value=insight)):
            result = await tools.perform_valuation_analysis.__wrapped__("AAPL")

    assert "error" not in result
    assert result["price_targets"] == {"base_case": 245.0}
    assert result["valuation_metrics"]["current_price"] == 230.0
