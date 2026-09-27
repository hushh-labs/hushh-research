"""
Kai Agent Tools

ADK Tools for the Kai Financial Agent.
Wraps the specialized analysis engines (Fundamental, Sentiment, Valuation) into tools.
"""

from typing import Any, Dict

from hushh_mcp.constants import ConsentScope
from hushh_mcp.hushh_adk.context import HushhContext
from hushh_mcp.hushh_adk.tools import hushh_tool

# Import the existing "Agents" which we are now treating as "Analysis Engines"
# We backed them up, but we'll use the ones in the current directory as library code.
from .fundamental_agent import fundamental_agent as fundamental_engine
from .sentiment_agent import sentiment_agent as sentiment_engine
from .valuation_agent import valuation_agent as valuation_engine


@hushh_tool(scope=ConsentScope.AGENT_KAI_ANALYZE, name="perform_fundamental_analysis")
async def perform_fundamental_analysis(ticker: str) -> Dict[str, Any]:
    """
    Analyze business fundamentals (SEC filings, financial health, moat).
    """
    ctx = HushhContext.current()
    if not ctx:
        raise PermissionError("No active context")

    print(f"🔧 Tool invoked: perform_fundamental_analysis for {ticker}")

    # Delegate to the fundamental engine
    # Note: The engine's analyze method is async
    try:
        insight = await fundamental_engine.analyze(
            ticker=ticker, user_id=ctx.user_id, consent_token=ctx.consent_token
        )

        # Convert dataclass/result to dict
        return {
            "summary": insight.summary,
            "business_moat": insight.business_moat,
            "financial_resilience": insight.financial_resilience,
            "recommendation": insight.recommendation,
            "confidence": insight.confidence,
            "metrics": insight.quant_metrics,
        }
    except Exception as e:
        return {"error": f"Fundamental analysis failed: {str(e)}"}


@hushh_tool(scope=ConsentScope.AGENT_KAI_ANALYZE, name="perform_sentiment_analysis")
async def perform_sentiment_analysis(ticker: str) -> Dict[str, Any]:
    """
    Analyze market sentiment (News, Social Media, Analyst Ratings).
    """
    ctx = HushhContext.current()
    if not ctx:
        raise PermissionError("No active context")

    print(f"🔧 Tool invoked: perform_sentiment_analysis for {ticker}")

    try:
        insight = await sentiment_engine.analyze(
            ticker=ticker, user_id=ctx.user_id, consent_token=ctx.consent_token
        )

        # Fields of SentimentInsight. This read market_consensus and key_news,
        # which the dataclass never had, so every successful analysis came back
        # as {"error": ...}.
        return {
            "summary": insight.summary,
            "sentiment_score": insight.sentiment_score,
            "key_catalysts": insight.key_catalysts,
            "recommendation": insight.recommendation,
            "confidence": insight.confidence,
            "news_highlights": insight.news_highlights[:3],
        }
    except Exception as e:
        return {"error": f"Sentiment analysis failed: {str(e)}"}


@hushh_tool(scope=ConsentScope.AGENT_KAI_ANALYZE, name="perform_valuation_analysis")
async def perform_valuation_analysis(ticker: str) -> Dict[str, Any]:
    """
    Perform quantitative valuation (DCF, Multiples, Fair Value).
    """
    ctx = HushhContext.current()
    if not ctx:
        raise PermissionError("No active context")

    print(f"🔧 Tool invoked: perform_valuation_analysis for {ticker}")

    try:
        insight = await valuation_engine.analyze(
            ticker=ticker, user_id=ctx.user_id, consent_token=ctx.consent_token
        )

        # Fields of ValuationInsight. This read fair_value, upside_potential and
        # risk_assessment, which the dataclass never had.
        return {
            "summary": insight.summary,
            "valuation_metrics": insight.valuation_metrics,
            "price_targets": insight.price_targets,
            "peer_comparison": insight.peer_comparison,
            "recommendation": insight.recommendation,
            "confidence": insight.confidence,
        }
    except Exception as e:
        return {"error": f"Valuation analysis failed: {str(e)}"}
