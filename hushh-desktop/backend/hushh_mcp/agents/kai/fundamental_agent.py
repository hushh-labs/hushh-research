"""
Agent Kai — Fundamental Agent (ADK Compliant)

Analyzes 10-K/10-Q SEC filings and financial fundamentals.
Extended from HushhAgent for consent enforcement.

Key Responsibilities:
- Business fundamentals analysis (via operons)
- Financial health assessment
- Long-term viability evaluation
- Competitive positioning review

Future: Attention Marketplace integration for premium data sources.
"""

import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from hushh_mcp.agents.base_agent import HushhAgent
from hushh_mcp.constants import GEMINI_MODEL

logger = logging.getLogger(__name__)


@dataclass
class FundamentalInsight:
    """Fundamental analysis insight with sources and confidence."""

    summary: str
    key_metrics: Dict[str, Any]
    quant_metrics: Dict[str, Any]
    business_moat: str
    financial_resilience: str
    growth_efficiency: str
    bull_case: str
    bear_case: str
    sources: List[str]
    confidence: float
    recommendation: str  # "buy", "hold", "reduce"


class FundamentalAgent(HushhAgent):
    """
    Fundamental Agent - Analyzes company fundamentals.

    ADK-compliant implementation that uses tools with proper consent validation.

    All consent validation happens in the operons via tools.
    Agent simply orchestrates and formats results.
    """

    def __init__(self, processing_mode: str = "hybrid"):
        self.agent_id = "fundamental"
        self.processing_mode = processing_mode
        self.color = "#3b82f6"  # Blue

        # Initialize with proper ADK parameters
        super().__init__(
            name="Fundamental Agent",
            model=GEMINI_MODEL,  # Standardized model
            system_prompt="""
            You are a Fundamental Analyst focused on SEC filings, business moat, and cash flow.
            Your job is to analyze company financials, business models, and long-term viability.
            """,
            required_scopes=["agent.kai.fundamental"],
        )

    async def analyze(
        self,
        ticker: str,
        user_id: str,
        consent_token: str,
        context: Optional[Dict[str, Any]] = None,
    ) -> FundamentalInsight:
        """
        Perform fundamental analysis using operons.

        This agent is a LIGHTWEIGHT ORCHESTRATOR.
        All business logic and consent validation is in the operons.

        Args:
            ticker: Stock ticker symbol (e.g., "AAPL")
            user_id: User ID for audit logging
            consent_token: Consent token (validated by operons)

        Returns:
            FundamentalInsight with analysis results
        """
        logger.info(f"[Fundamental] Orchestrating analysis for {ticker}")

        # Step 1: Fetch SEC filings (operon validates consent internally)
        from hushh_mcp.operons.kai.fetchers import (
            RealtimeDataUnavailable,
            fetch_market_data,
            fetch_sec_filings,
        )

        sec_filings = None
        sec_unavailable_reason: str | None = None
        try:
            sec_filings = await fetch_sec_filings(
                ticker=ticker, user_id=user_id, consent_token=consent_token
            )
            # We also need market data for context
            market_data = await fetch_market_data(
                ticker=ticker, user_id=user_id, consent_token=consent_token
            )
        except PermissionError as e:
            logger.error(f"[Fundamental] External data access denied: {e}")
            raise
        except RealtimeDataUnavailable as e:
            logger.warning(
                "[Fundamental] Realtime dependency unavailable for %s: source=%s detail=%s",
                ticker,
                e.source,
                e.detail,
            )
            raise
        except ValueError as e:
            sec_unavailable_reason = str(e)
            logger.warning(
                "[Fundamental] SEC filing data unavailable for %s; using market-structure fallback: %s",
                ticker,
                sec_unavailable_reason,
            )
            try:
                market_data = await fetch_market_data(
                    ticker=ticker, user_id=user_id, consent_token=consent_token
                )
            except RealtimeDataUnavailable as market_error:
                logger.warning(
                    "[Fundamental] Market snapshot also unavailable for %s fallback: %s",
                    ticker,
                    market_error.detail,
                )
                market_data = {
                    "source": "Market data fallback unavailable",
                    "fallback_reason": market_error.detail,
                }

        # Step 2: Gemini Deep Analysis (HYBRID v2)
        from hushh_mcp.operons.kai.calculators import calculate_quant_metrics
        from hushh_mcp.operons.kai.llm import (
            analyze_stock_with_gemini,
            get_gemini_unavailable_reason,
            is_gemini_ready,
        )

        quant_metrics = calculate_quant_metrics(sec_filings) if sec_filings else {}

        gemini_analysis = None
        if self.processing_mode == "hybrid" and sec_filings:
            # Retry logic (Max 2 attempts)
            if not is_gemini_ready():
                logger.warning(
                    "[Fundamental] Gemini unavailable, using deterministic analysis: %s",
                    get_gemini_unavailable_reason(),
                )
            for attempt in range(2):
                try:
                    gemini_analysis = await analyze_stock_with_gemini(
                        ticker=ticker,
                        user_id=user_id,
                        consent_token=consent_token,
                        sec_data=sec_filings,
                        market_data=market_data,
                        quant_metrics=quant_metrics,
                        user_context=context,
                    )
                    break  # Success
                except Exception as e:
                    logger.warning(
                        f"[Fundamental] Gemini analysis failed (attempt {attempt + 1}/2): {e}"
                    )
                    if attempt == 1:
                        logger.warning(
                            "[Fundamental] Max retries reached. Falling back to deterministic."
                        )

        # Step 3: Traditional Analysis (Fallback or baseline metrics)
        from hushh_mcp.operons.kai.analysis import analyze_fundamentals

        if sec_filings:
            analysis = analyze_fundamentals(
                ticker=ticker,
                user_id=user_id,
                sec_filings=sec_filings,
                consent_token=consent_token,
            )
        else:
            analysis = self._build_market_only_analysis(
                ticker=ticker,
                market_data=market_data,
                sec_unavailable_reason=sec_unavailable_reason,
            )

        # Step 4: Merge results (Prefer Deep Gemini Report)
        if gemini_analysis and "error" not in gemini_analysis:
            logger.info(f"[Fundamental] Integrating Deep Gemini Report for {ticker}")
            return FundamentalInsight(
                summary=gemini_analysis.get("summary", analysis["summary"]),
                key_metrics=analysis["key_metrics"],
                quant_metrics=quant_metrics,
                business_moat=gemini_analysis.get("business_moat", "No moat analysis available."),
                financial_resilience=gemini_analysis.get(
                    "financial_resilience", "No resilience analysis available."
                ),
                growth_efficiency=gemini_analysis.get(
                    "growth_efficiency", "No efficiency analysis available."
                ),
                bull_case=gemini_analysis.get("bull_case", "No bull case provided."),
                bear_case=gemini_analysis.get("bear_case", "No bear case provided."),
                confidence=gemini_analysis.get("confidence", analysis["confidence"]),
                recommendation=gemini_analysis.get("recommendation", analysis["recommendation"]),
                sources=self._format_sources(sec_filings) + ["Gemini Senior Analyst Report"],
            )

        # Step 5: Format as FundamentalInsight (Fallback)
        return FundamentalInsight(
            summary=analysis["summary"],
            key_metrics=analysis["key_metrics"],
            quant_metrics=quant_metrics,
            business_moat=analysis.get("business_moat", "N/A (Deterministic Mode)"),
            financial_resilience=analysis.get("financial_resilience", "N/A (Deterministic Mode)"),
            growth_efficiency=analysis.get("growth_efficiency", "N/A (Deterministic Mode)"),
            bull_case=analysis.get("bull_case", "N/A"),
            bear_case=analysis.get("bear_case", "N/A"),
            confidence=analysis["confidence"],
            recommendation=analysis["recommendation"],
            sources=analysis.get("sources", self._format_sources(sec_filings)),
        )

    def _build_market_only_analysis(
        self,
        ticker: str,
        market_data: Dict[str, Any],
        sec_unavailable_reason: str | None = None,
    ) -> Dict[str, Any]:
        """Fallback for symbols that do not have usable SEC operating-company filings."""
        price = market_data.get("price") or 0
        change_percent = market_data.get("change_percent") or market_data.get("change_pct") or 0
        market_cap = market_data.get("market_cap") or 0
        pe_ratio = market_data.get("pe_ratio") or 0
        source = market_data.get("source") or market_data.get("provider") or "Market data fallback"
        reason = sec_unavailable_reason or "SEC filing data unavailable for this symbol."

        return {
            "summary": (
                f"{ticker} is being evaluated with Kai's market-structure fallback because "
                f"operating-company SEC filings were not available. {reason}"
            ),
            "key_metrics": {
                "price": price,
                "change_percent": change_percent,
                "market_cap": market_cap,
                "pe_ratio": pe_ratio,
                "fallback_reason": reason,
            },
            "confidence": 0.35,
            "recommendation": "hold",
            "business_moat": "Not assessed from SEC filings for this security type.",
            "financial_resilience": "Unavailable because SEC operating-company data is not present.",
            "growth_efficiency": "Unavailable because SEC operating-company data is not present.",
            "bull_case": (
                f"{ticker} still has live market data and can participate in portfolio construction "
                "even when filing-based analysis is limited."
            ),
            "bear_case": (
                f"{ticker} lacks the filing depth Kai expects for a full fundamental equity review, "
                "so conviction remains limited."
            ),
            "sources": [source, "PKM financial holdings context"],
        }

    def _format_sources(self, sec_filings: Dict[str, Any] | None) -> List[str]:
        """Format SEC filing sources for display."""
        if not sec_filings:
            return ["Market data fallback", "PKM financial holdings context"]
        ticker = sec_filings.get("ticker", "N/A")
        filing_date = sec_filings.get("filing_date", "N/A")

        return [
            f"{ticker} 10-K Annual Report ({filing_date})",
            "SEC EDGAR Database",
            "Financial statement analysis",
        ]


# Export singleton for use in KaiAgent orchestration
fundamental_agent = FundamentalAgent()
