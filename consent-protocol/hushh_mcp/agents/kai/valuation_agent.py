"""
Agent Kai — Valuation Agent (ADK Compliant)

Performs quantitative analysis using deterministic financial calculators.

Key Responsibilities:
- P/E ratios and multiples calculation
- Returns analysis
- Volatility measurement
- Relative valuation vs peers
"""

import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from hushh_mcp.agents.base_agent import HushhAgent
from hushh_mcp.constants import GEMINI_MODEL

from .errors import AgentDataError, AgentLLMError

logger = logging.getLogger(__name__)


@dataclass
class ValuationInsight:
    """Valuation analysis insight."""

    summary: str
    valuation_metrics: Dict[str, float]
    peer_comparison: Dict[str, Any]
    price_targets: Dict[str, float]
    sources: List[str]
    confidence: float
    recommendation: str  # "overvalued", "fair", "undervalued"


class ValuationAgent(HushhAgent):
    """
    Valuation Agent - Performs quantitative valuation analysis.

    ADK-compliant implementation that uses tools with proper consent validation.

    Calculates financial metrics, compares to peers, and determines
    whether the stock is overvalued, fairly valued, or undervalued.
    """

    def __init__(self, processing_mode: str = "hybrid"):
        self.agent_id = "valuation"
        self.processing_mode = processing_mode
        self.color = "#10b981"

        # Initialize with proper ADK parameters
        super().__init__(
            name="Valuation Agent",
            model=GEMINI_MODEL,  # Standardized model
            system_prompt="""
            You are a Valuation Expert focused on fair value, multiples, and DCF analysis.
            Your job is to calculate financial metrics, compare with peers, and determine if a stock is overvalued or undervalued.
            """,
            required_scopes=["agent.kai.valuation"],
        )

    async def analyze(
        self,
        ticker: str,
        user_id: str,
        consent_token: str,
        context: Optional[Dict[str, Any]] = None,
    ) -> ValuationInsight:
        """
        Perform valuation analysis using Gemini + operons.

        Args:
            ticker: Stock ticker symbol (e.g., "AAPL")
            user_id: User ID for audit logging
            consent_token: Consent token for market data access
            context: Optional user context for personalization

        Returns:
            ValuationInsight with analysis results

        Raises:
            PermissionError:  Token missing or insufficient scope (re-raised as-is).
            AgentDataError:   Market/peer data fetch failed unexpectedly.
            AgentLLMError:    Both Gemini and deterministic valuation paths failed.
        """
        if not consent_token:
            raise PermissionError("Valuation analysis requires a consent token")

        logger.info(f"[Valuation] Orchestrating analysis for {ticker} - user {user_id}")

        # Operon 1: Fetch market data (with consent check)
        from hushh_mcp.operons.kai.fetchers import (
            RealtimeDataUnavailable,
            fetch_market_data,
            fetch_peer_data,
        )

        try:
            market_data = await fetch_market_data(ticker, user_id, consent_token)
            peer_data = await fetch_peer_data(ticker, user_id, consent_token)
        except PermissionError:
            # Re-raise consent errors unchanged — callers must see the 403.
            raise
        except RealtimeDataUnavailable as e:
            logger.warning(
                "[Valuation] Realtime market dependency unavailable for %s; using fallback: %s",
                ticker,
                e.detail,
            )
            return self._build_market_unavailable_fallback(ticker=ticker, detail=e.detail)
        except Exception as exc:
            # Unexpected data-layer failure — log full traceback, then re-raise typed.
            logger.exception(
                "[Valuation] Market/peer data fetch failed unexpectedly for ticker=%s user=%s",
                ticker,
                user_id,
            )
            raise AgentDataError(f"Data fetch failed for {ticker}: {exc}") from exc

        # Operon 2: Gemini Deep Valuation Analysis
        from hushh_mcp.operons.kai.llm import (
            analyze_valuation_with_gemini,
            get_gemini_unavailable_reason,
            is_gemini_ready,
        )

        gemini_analysis = None
        if self.processing_mode == "hybrid" and consent_token:
            if not is_gemini_ready():
                logger.warning(
                    "[Valuation] Gemini unavailable, using deterministic analysis: %s",
                    get_gemini_unavailable_reason(),
                )
            last_exc: Exception | None = None
            for attempt in range(2):
                try:
                    gemini_analysis = await analyze_valuation_with_gemini(
                        ticker=ticker,
                        user_id=user_id,
                        consent_token=consent_token,
                        market_data=market_data,
                        peer_data=peer_data,
                        user_context=context,
                    )
                    last_exc = None
                    break
                except Exception as exc:
                    last_exc = exc
                    logger.warning(
                        "[Valuation] Gemini analysis failed (attempt %d/2) for %s: %s",
                        attempt + 1,
                        ticker,
                        exc,
                    )
            if last_exc is not None:
                logger.exception(
                    "[Valuation] Gemini analysis exhausted all retries for %s — "
                    "falling back to deterministic analysis",
                    ticker,
                    exc_info=last_exc,
                )

        # Use Gemini results if available
        if gemini_analysis and "error" not in gemini_analysis:
            logger.info(f"[Valuation] Using Gemini analysis for {ticker}")
            return ValuationInsight(
                summary=gemini_analysis.get("summary", f"Valuation analysis for {ticker}"),
                valuation_metrics=gemini_analysis.get("valuation_metrics", {}),
                peer_comparison=gemini_analysis.get("peer_comparison", {}),
                price_targets=gemini_analysis.get("price_targets", {}),
                sources=gemini_analysis.get("sources", ["Gemini Valuation Analysis"]),
                confidence=gemini_analysis.get("confidence", 0.5),
                recommendation=gemini_analysis.get("recommendation", "fair"),
            )

        # Fallback: Deterministic analysis
        logger.info(f"[Valuation] Using deterministic analysis for {ticker}")
        from hushh_mcp.operons.kai.analysis import analyze_valuation

        try:
            analysis = analyze_valuation(
                ticker=ticker,
                user_id=user_id,
                market_data=market_data,
                peer_data=peer_data,
                consent_token=consent_token,
            )

            return ValuationInsight(
                summary=analysis.get("summary", f"Valuation analysis for {ticker}"),
                valuation_metrics=analysis.get("valuation_metrics", {}),
                peer_comparison=analysis.get("peer_comparison", {}),
                price_targets=analysis.get("price_targets", {}),
                sources=analysis.get("sources", ["Deterministic Analysis"]),
                confidence=analysis.get("confidence", 0.5),
                recommendation=analysis.get("recommendation", "fair"),
            )
        except Exception as exc:
            # Both Gemini and deterministic paths failed — log full traceback.
            logger.exception(
                "[Valuation] Deterministic analysis also failed for ticker=%s user=%s",
                ticker,
                user_id,
            )
            raise AgentLLMError(
                f"All valuation analysis paths failed for {ticker}: {exc}"
            ) from exc

    def _build_market_unavailable_fallback(self, ticker: str, detail: str) -> ValuationInsight:
        """Fallback when the symbol cannot be priced reliably in realtime."""
        return ValuationInsight(
            summary=(
                f"Realtime quote coverage was unavailable for {ticker}, so Kai is returning a "
                "low-confidence valuation placeholder instead of a hard failure."
            ),
            valuation_metrics={"fallback": 1.0},
            peer_comparison={"status": "unavailable", "detail": detail},
            price_targets={},
            sources=["Valuation fallback", "Realtime quote unavailable"],
            confidence=0.2,
            recommendation="fair",
        )


# Export singleton for use in KaiAgent orchestration
valuation_agent = ValuationAgent()