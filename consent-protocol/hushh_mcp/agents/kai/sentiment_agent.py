"""
Agent Kai — Sentiment Agent (ADK Compliant)

Processes news articles, earnings calls, and market sentiment using reflection summarization.

Key Responsibilities:
- Market momentum analysis
- Short-term catalyst identification
- News sentiment scoring
- Earnings call interpretation
"""

import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from hushh_mcp.agents.base_agent import HushhAgent
from hushh_mcp.constants import GEMINI_MODEL

logger = logging.getLogger(__name__)


@dataclass
class SentimentInsight:
    """Sentiment analysis insight."""

    summary: str
    sentiment_score: float  # -1.0 (very bearish) to 1.0 (very bullish)
    key_catalysts: List[str]
    news_highlights: List[Dict[str, str]]
    sources: List[str]
    confidence: float
    recommendation: str  # "bullish", "neutral", "bearish"


class SentimentAgent(HushhAgent):
    """
    Sentiment Agent - Analyzes market sentiment and news.

    ADK-compliant implementation that uses tools with proper consent validation.

    Processes news articles, social media, and earnings transcripts
    to gauge market momentum and identify short-term catalysts.
    """

    def __init__(self, processing_mode: str = "hybrid"):
        self.agent_id = "sentiment"
        self.processing_mode = processing_mode
        self.color = "#8b5cf6"

        # Initialize with proper ADK parameters
        super().__init__(
            name="Sentiment Agent",
            model=GEMINI_MODEL,  # Standardized model
            system_prompt="""
            You are a Sentiment Analyst focused on market momentum, news catalysts, and sentiment analysis.
            Your job is to evaluate recent market events, news, and social sentiment to identify short-term catalysts.
            """,
            required_scopes=["agent.kai.sentiment"],
        )

    async def analyze(
        self,
        ticker: str,
        user_id: str,
        consent_token: str,
        context: Optional[Dict[str, Any]] = None,
    ) -> SentimentInsight:
        """
        Perform sentiment analysis using Gemini + operons.

        Args:
            ticker: Stock ticker symbol (e.g., "AAPL")
            user_id: User ID for audit logging
            consent_token: Consent token for news API access
            context: Optional user context for personalization

        Returns:
            SentimentInsight with analysis results
        """
        logger.info(f"[Sentiment] Orchestrating analysis for {ticker} - user {user_id}")

        # Operon 1: Fetch news articles (with consent check)
        from hushh_mcp.operons.kai.fetchers import (
            RealtimeDataUnavailable,
            fetch_market_data,
            fetch_market_news,
        )

        news_articles = []
        realtime_news_detail: str | None = None
        try:
            news_articles = await fetch_market_news(ticker, user_id, consent_token)
        except PermissionError as e:
            logger.error(f"[Sentiment] News access denied: {e}")
            raise
        except RealtimeDataUnavailable as e:
            realtime_news_detail = e.detail
            logger.warning(f"[Sentiment] Realtime news unavailable for {ticker}: {e.detail}")
        except Exception as e:
            logger.error(f"[Sentiment] News fetch failed: {e}")
            raise

        market_data: Optional[Dict[str, Any]] = None
        try:
            # Reuse quote cache pipeline so sentiment reasoning is anchored to latest price context.
            market_data = await fetch_market_data(ticker, user_id, consent_token)
        except Exception as e:
            logger.warning(f"[Sentiment] Market snapshot unavailable for {ticker}: {e}")

        if not news_articles:
            summary = (
                f"No realtime news was available for {ticker}, so Kai is using a neutral "
                "sentiment fallback anchored to the latest market snapshot."
            )
            if realtime_news_detail:
                summary = f"{summary} {realtime_news_detail}"
            return SentimentInsight(
                summary=summary,
                sentiment_score=0.0,
                key_catalysts=[
                    "Realtime news unavailable",
                    "Sentiment held neutral until fresh catalyst coverage is available",
                ],
                news_highlights=[],
                sources=["Sentiment fallback", "Latest market snapshot"],
                confidence=0.25,
                recommendation="neutral",
            )

        # Operon 2: Gemini Deep Sentiment Analysis
        from hushh_mcp.operons.kai.llm import (
            analyze_sentiment_with_gemini,
            get_gemini_unavailable_reason,
            is_gemini_ready,
        )

        gemini_analysis = None
        if self.processing_mode == "hybrid" and consent_token:
            if not is_gemini_ready():
                logger.warning(
                    "[Sentiment] Gemini unavailable, using deterministic analysis: %s",
                    get_gemini_unavailable_reason(),
                )
            for attempt in range(2):
                try:
                    gemini_analysis = await analyze_sentiment_with_gemini(
                        ticker=ticker,
                        user_id=user_id,
                        consent_token=consent_token,
                        news_articles=news_articles,
                        market_data=market_data,
                        user_context=context,
                    )
                    break
                except Exception as e:
                    logger.warning(
                        f"[Sentiment] Gemini analysis failed (attempt {attempt + 1}/2): {e}"
                    )
                    if attempt == 1:
                        logger.warning(
                            "[Sentiment] Max retries reached. Falling back to deterministic."
                        )

        # Use Gemini results if available
        if gemini_analysis and "error" not in gemini_analysis:
            logger.info(f"[Sentiment] Using Gemini analysis for {ticker}")
            return SentimentInsight(
                summary=gemini_analysis.get("summary", f"Sentiment analysis for {ticker}"),
                sentiment_score=gemini_analysis.get("sentiment_score", 0.0),
                key_catalysts=gemini_analysis.get("key_catalysts", []),
                news_highlights=gemini_analysis.get("news_highlights", []),
                sources=gemini_analysis.get("sources", ["Gemini Sentiment Analysis"]),
                confidence=gemini_analysis.get("confidence", 0.5),
                recommendation=gemini_analysis.get("recommendation", "neutral"),
            )

        # Fallback: Deterministic analysis
        logger.info(f"[Sentiment] Using deterministic analysis for {ticker}")
        from hushh_mcp.operons.kai.analysis import analyze_sentiment

        try:
            # Call the operon directly without tools (deterministic)
            analysis = analyze_sentiment(
                ticker=ticker,
                user_id=user_id,
                news_articles=news_articles,
                consent_token=consent_token,
            )

            return SentimentInsight(
                summary=analysis.get("summary", f"Sentiment analysis for {ticker}"),
                sentiment_score=analysis.get("sentiment_score", 0.0),
                key_catalysts=analysis.get("key_catalysts", []),
                news_highlights=analysis.get("news_highlights", []),
                sources=analysis.get("sources", ["Deterministic Analysis"]),
                confidence=analysis.get("confidence", 0.5),
                recommendation=analysis.get("recommendation", "neutral"),
            )
        except Exception as e:
            logger.error(f"[Sentiment] Deterministic analysis failed: {e}")
            raise


# Export singleton for use in KaiAgent orchestration
sentiment_agent = SentimentAgent()
