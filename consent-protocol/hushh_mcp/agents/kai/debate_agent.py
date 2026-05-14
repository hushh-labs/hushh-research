"""
Debate Agent — Multi-Agent Investment Debate Engine for KAI.

This module implements the "Tournament Logic" where two specialized AI agents
(Bull and Bear) debate the merits of a given stock ticker, and a verdict is
rendered based on weighted scoring.

This is an ADDITIVE module — it does not modify the existing FundamentalAgent,
RenaissanceAgent, or any core Kai agents. It imports them as dependencies.
"""

import logging
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


class BearDebateAgent:
    """
    Bear agent for the investment debate.
    Argues against buying a stock using fundamental risk analysis.
    """

    def __init__(self):
        self.name = "Fundamental Bear Agent"

    async def analyze(self, ticker: str) -> Dict[str, Any]:
        """Generate bearish arguments for the debate."""
        return {
            "agent_name": self.name,
            "ticker": ticker,
            "sentiment": "Bearish",
            "risk_score": 75,
            "arguments": [
                f"{ticker} shares are currently trading at a premium P/E ratio compared to sector averages.",
                "High debt-to-equity levels might pressure future dividends.",
                "Recent insider selling activity suggests a lack of confidence from the board.",
            ],
            "recommendation": "Wait for a pull-back before entering.",
        }

    async def counter_analyze(
        self,
        ticker: str,
        bull_case: Dict[str, Any],
        user_context: Optional[dict] = None,
    ) -> Dict[str, Any]:
        """Bear responds to the Bull's arguments in the debate, incorporating user PKM context."""
        user_context = user_context or {}
        budget = user_context.get("available_cash")
        risk = user_context.get("risk_profile")

        bull_args = bull_case.get("arguments", [])

        bear_args = [
            f"Even though {ticker} might have strong points, it is trading at a premium P/E ratio.",
            "High debt-to-equity levels might pressure future dividends or stock buybacks.",
        ]

        if budget and isinstance(budget, (int, float)) and budget <= 500:
            bear_args.append(
                f"With only ${budget} available, buying this overvalued stock risks a large "
                "percentage loss on limited capital."
            )
        if risk == "conservative":
            bear_args.append(
                f"As a '{risk}' investor, buying {ticker} at these elevated valuation "
                "levels violates their risk boundaries."
            )
        else:
            bear_args.append(
                "Recent insider selling activity or broader sector headwinds suggest caution."
            )

        counter_points = []
        for arg in bull_args:
            if "Free Cash Flow" in arg:
                counter_points.append(
                    "Counter to FCF argument: While current cash flow is solid, "
                    "the valuation already prices this in."
                )
            elif "Sector Leader" in arg:
                counter_points.append(
                    "Counter to Sector Leadership: High market share means growth "
                    "will be harder to achieve moving forward."
                )

        if not counter_points:
            counter_points = [
                "The bullish points are overly optimistic and lack consideration of macroeconomic risks."
            ]

        return {
            "agent_name": self.name,
            "ticker": ticker,
            "sentiment": "Bearish",
            "risk_score": 75,
            "arguments": bear_args,
            "counter_points": counter_points,
            "recommendation": "Wait for a pull-back before entering.",
        }


class InvestmentDebateEngine:
    """
    Multi-agent debate engine for investment analysis.

    Orchestrates a structured debate between Bull (RenaissanceAgent) and
    Bear (BearDebateAgent) agents, optionally incorporating user PKM context.
    """

    def __init__(self):
        self.bear = BearDebateAgent()

    async def _get_bull_agent(self):
        """Lazy-load the RenaissanceAgent to avoid circular imports."""
        from hushh_mcp.agents.kai.renaissance_agent import RenaissanceAgent

        return RenaissanceAgent()

    async def run_debate(
        self,
        ticker: str,
        user_id: Optional[str] = None,
        consent_token: Optional[str] = None,
    ):
        """
        Run a structured debate between Bull and Bear agents.

        Yields SSE events as the debate progresses:
        - bull_point: A bullish argument
        - bear_point: A bearish argument
        - verdict: The final weighted verdict
        """
        user_context = {}
        if user_id:
            try:
                from hushh_mcp.services.personal_knowledge_model_service import (
                    PersonalKnowledgeModelService,
                )

                pkm = PersonalKnowledgeModelService()
                profile = await pkm.get_financial_profile(user_id)
                if profile:
                    user_context = {
                        "available_cash": profile.get("available_cash"),
                        "risk_profile": profile.get("risk_profile"),
                    }
            except Exception as e:
                logger.warning("[Debate] Could not fetch PKM context: %s", e)

        bull = await self._get_bull_agent()

        # Phase 1: Bull presents
        bull_analysis = await bull.analyze(ticker, user_context)
        for arg in bull_analysis.get("arguments", []):
            yield {"event": "bull_point", "data": {"point": arg}}

        # Phase 2: Bear presents
        bear_analysis = await self.bear.analyze(ticker)
        for arg in bear_analysis.get("arguments", []):
            yield {"event": "bear_point", "data": {"point": arg}}

        # Phase 3: Bear counters Bull
        counter = await self.bear.counter_analyze(ticker, bull_analysis, user_context)
        for point in counter.get("counter_points", []):
            yield {"event": "bear_point", "data": {"point": f"[Rebuttal] {point}"}}

        # Phase 4: Bull defense
        defense = self._generate_bull_defense(bull_analysis, bear_analysis)
        for point in defense:
            yield {"event": "bull_point", "data": {"point": f"[Defense] {point}"}}

        # Phase 5: Verdict
        verdict = self._calculate_verdict(bull_analysis, bear_analysis, counter)
        yield {"event": "verdict", "data": verdict}

    def _generate_bull_defense(
        self,
        bull_analysis: Dict[str, Any],
        bear_analysis: Dict[str, Any],
    ) -> list:
        """Generate bull rebuttals to bear arguments."""
        defense = []
        bear_args = bear_analysis.get("arguments", [])
        bull_score = bull_analysis.get("score", 50)
        bear_text = " ".join(bear_args).lower()

        if "p/e ratio" in bear_text or "premium" in bear_text:
            defense.append(
                "P/E Rebuttal: A premium P/E is justified when a company demonstrates "
                "consistent double-digit revenue growth and expanding margins."
            )
        if "debt" in bear_text:
            defense.append(
                "Debt Rebuttal: The company's robust free cash flow generation means it "
                "can service this debt comfortably. Leverage is a tool, not a weakness."
            )
        if "insider" in bear_text:
            defense.append(
                "Insider Rebuttal: Insider selling is often for personal diversification, "
                "tax planning, or scheduled trading plans, not a signal of declining confidence."
            )
        if bull_score > 70:
            defense.append(
                f"Conviction: With a Renaissance conviction score of {bull_score}, "
                "the data-driven thesis remains strong."
            )

        if not defense:
            defense.append(
                "The bear's concerns are valid surface-level risks, but the long-term "
                "thesis remains intact based on our fundamental research."
            )

        return defense

    def _calculate_verdict(
        self,
        bull_analysis: Dict[str, Any],
        bear_analysis: Dict[str, Any],
        counter: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Calculate final debate verdict with weighted scoring."""
        bull_score = bull_analysis.get("score", 50)
        bear_risk = bear_analysis.get("risk_score", 50)
        counter_strength = len(counter.get("counter_points", [])) * 5

        # Weighted formula
        final_score = (bull_score * 0.6) - (bear_risk * 0.3) - (counter_strength * 0.1)
        final_score = max(0, min(100, final_score + 50))

        if final_score >= 70:
            label = "Strong Buy"
        elif final_score >= 55:
            label = "Moderate Buy"
        elif final_score >= 45:
            label = "Hold"
        elif final_score >= 30:
            label = "Cautious"
        else:
            label = "Avoid"

        return {"final_score": round(final_score, 1), "label": label}
