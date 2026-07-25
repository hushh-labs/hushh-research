from hushh_mcp.agents.kai.macro_agent import MacroInsight


def test_macro_insight_schema_safety():
    """Verify MacroInsight schema can hold safety-related fields."""
    insight = MacroInsight(
        summary="Market environment is risk-off.",
        interest_rate_impact="Neutral",
        inflation_impact="Stable",
        sector_trend="Neutral",
        macro_bull_case="Stability",
        macro_bear_case="Volatility",
        confidence=0.8,
        recommendation="hold",
        sources=["deterministic"],
    )
    assert "risk-off" in insight.summary
    assert insight.recommendation == "hold"
