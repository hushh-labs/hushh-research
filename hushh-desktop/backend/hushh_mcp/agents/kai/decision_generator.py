"""
Agent Kai — Decision Generator

Generates decision cards with receipts, sources, and compliance disclaimers.

Key Responsibilities:
- Decision card formatting
- Source citation
- Debate digest creation
- Legal disclaimer injection
- Encryption for storage
"""

import json
import logging
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Any, Dict, List

from .config import DecisionType, RiskProfile
from .debate_engine import DebateResult
from .fundamental_agent import FundamentalInsight
from .sentiment_agent import SentimentInsight
from .valuation_agent import ValuationInsight

logger = logging.getLogger(__name__)


@dataclass
class DecisionCard:
    """
    Complete decision card with all analysis details.

    This is what the user sees - a comprehensive breakdown
    of the investment committee's decision.
    """

    # Decision metadata
    decision_id: str
    ticker: str
    user_id: str
    timestamp: datetime

    # Headline recommendation
    decision: DecisionType
    confidence: float
    headline: str

    # Specialist insights
    fundamental_insight: Dict[str, Any]
    sentiment_insight: Dict[str, Any]
    valuation_insight: Dict[str, Any]

    # Debate details
    debate_digest: str
    debate_rounds: List[Dict[str, Any]]
    consensus_reached: bool
    dissenting_opinions: List[str]

    # Supporting data
    all_sources: List[str]
    key_metrics: Dict[str, Any]
    quant_metrics: Dict[str, Any]
    risk_persona_alignment: str

    # Compliance
    legal_disclaimer: str
    reliability_badge: str

    # Processing metadata
    processing_mode: str
    risk_profile: RiskProfile


class DecisionGenerator:
    """
    Decision Generator - Creates formatted decision cards.

    Transforms raw agent insights and debate results into
    a user-friendly decision card with full transparency.
    """

    LEGAL_DISCLAIMER = """
⚠️ IMPORTANT DISCLOSURE

This analysis is provided for EDUCATIONAL PURPOSES ONLY.

• This is NOT investment advice
• [LEGAL ENTITY NAME - TBD] is NOT a registered investment adviser
• Agent Kai is NOT part of Hushh Technology Fund L.P.'s services
• Past performance does not guarantee future results
• You may lose money; there is no assurance of profit
• Always consult a licensed financial advisor before investing

By using Kai, you acknowledge that you understand these limitations.
    """.strip()

    def __init__(self, risk_profile: RiskProfile = "balanced"):
        self.risk_profile = risk_profile

    async def generate_decision(
        self,
        ticker: str,
        fundamental_insight: FundamentalInsight,
        sentiment_insight: SentimentInsight,
        valuation_insight: ValuationInsight,
        debate_result: DebateResult,
        user_id: str,
        consent_token: str | None = None,
        processing_mode: str | None = None,
    ) -> DecisionCard:
        """
        Backward-compatible orchestrator entrypoint.

        The active orchestrator still calls ``generate_decision`` with legacy
        keyword names. Normalize them into the current ``generate`` contract so
        the runtime can stay stable while the rest of Kai is modernized.
        """
        del consent_token  # Decision generation no longer needs the raw token.

        return await self.generate(
            ticker=ticker,
            user_id=user_id,
            processing_mode=processing_mode or "hybrid",
            fundamental=fundamental_insight,
            sentiment=sentiment_insight,
            valuation=valuation_insight,
            debate=debate_result,
        )

    async def generate(
        self,
        ticker: str,
        user_id: str,
        processing_mode: str,
        fundamental: FundamentalInsight,
        sentiment: SentimentInsight,
        valuation: ValuationInsight,
        debate: DebateResult,
    ) -> DecisionCard:
        """
        Generate a complete decision card.

        Args:
            ticker: Stock ticker
            user_id: User ID
            processing_mode: "on_device" or "hybrid"
            fundamental: Fundamental agent's insight
            sentiment: Sentiment agent's insight
            valuation: Valuation agent's insight
            debate: Debate engine result

        Returns:
            Complete DecisionCard
        """
        logger.info(f"[DecisionGen] Generating decision card for {ticker}")

        decision_id = f"decision_{datetime.utcnow().timestamp()}"

        # Generate headline
        headline = self._generate_headline(ticker, debate.decision, debate.confidence)

        # Create debate digest
        debate_digest = self._create_debate_digest(debate)

        # Collect all sources
        all_sources = self._collect_sources(fundamental, sentiment, valuation)

        # Aggregate key metrics
        key_metrics = self._aggregate_metrics(fundamental, sentiment, valuation)

        # Generate risk persona alignment note
        risk_alignment = self._generate_risk_alignment(debate.decision, debate.confidence)

        # Determine reliability badge
        reliability_badge = self._calculate_reliability_badge(
            fundamental.confidence,
            sentiment.confidence,
            valuation.confidence,
        )

        return DecisionCard(
            decision_id=decision_id,
            ticker=ticker,
            user_id=user_id,
            timestamp=datetime.utcnow(),
            decision=debate.decision,
            confidence=debate.confidence,
            headline=headline,
            fundamental_insight=asdict(fundamental),
            sentiment_insight=asdict(sentiment),
            valuation_insight=asdict(valuation),
            debate_digest=debate_digest,
            debate_rounds=[asdict(r) for r in debate.rounds],
            consensus_reached=debate.consensus_reached,
            dissenting_opinions=debate.dissenting_opinions,
            all_sources=all_sources,
            key_metrics=key_metrics,
            quant_metrics=fundamental.quant_metrics,
            risk_persona_alignment=risk_alignment,
            legal_disclaimer=self.LEGAL_DISCLAIMER,
            reliability_badge=reliability_badge,
            processing_mode=processing_mode,
            risk_profile=self.risk_profile,
        )

    def _generate_headline(self, ticker: str, decision: DecisionType, confidence: float) -> str:
        """Generate decision headline."""
        action_word = {"buy": "BUY", "hold": "HOLD", "reduce": "REDUCE"}[decision]

        confidence_desc = (
            "High" if confidence > 0.75 else "Moderate" if confidence > 0.60 else "Low"
        )

        return f"{action_word} {ticker} — {confidence_desc} Confidence ({confidence:.0%})"

    def _create_debate_digest(self, debate: DebateResult) -> str:
        """Create human-readable debate summary."""

        rounds_summary = []
        for round in debate.rounds:
            round_text = f"**Round {round.round_number}:**\n"
            for agent_id, statement in round.agent_statements.items():
                round_text += f"- {agent_id.capitalize()}: {statement}\n"
            rounds_summary.append(round_text)

        digest = "\n".join(rounds_summary)
        digest += f"\n\n{debate.final_statement}"

        if debate.dissenting_opinions:
            digest += "\n\n**Dissenting Opinions:**\n"
            for dissent in debate.dissenting_opinions:
                digest += f"- {dissent}\n"

        return digest

    def _collect_sources(
        self,
        fundamental: FundamentalInsight,
        sentiment: SentimentInsight,
        valuation: ValuationInsight,
    ) -> List[str]:
        """Collect all sources from agents."""
        sources = []
        sources.extend(fundamental.sources)
        sources.extend(sentiment.sources)
        sources.extend(valuation.sources)
        return list(set(sources))  # Deduplicate

    def _aggregate_metrics(
        self,
        fundamental: FundamentalInsight,
        sentiment: SentimentInsight,
        valuation: ValuationInsight,
    ) -> Dict[str, Any]:
        """Aggregate key metrics from all agents."""
        return {
            "fundamental": fundamental.key_metrics,
            "sentiment": {
                "sentiment_score": sentiment.sentiment_score,
                "catalyst_count": len(sentiment.key_catalysts),
            },
            "valuation": valuation.valuation_metrics,
        }

    def _generate_risk_alignment(self, decision: DecisionType, confidence: float) -> str:
        """Generate risk persona alignment note."""

        alignment_notes = {
            "conservative": {
                "buy": "This BUY recommendation aligns with conservative investing if fundamentals are strong and downside is protected.",
                "hold": "HOLD is appropriate for conservative investors seeking capital preservation.",
                "reduce": "REDUCE aligns well with conservative risk management.",
            },
            "balanced": {
                "buy": "This BUY recommendation balances growth opportunity with risk considerations.",
                "hold": "HOLD provides balanced exposure while monitoring developments.",
                "reduce": "REDUCE helps rebalance portfolio while maintaining diversification.",
            },
            "aggressive": {
                "buy": "BUY recommendation offers growth potential aligned with aggressive investing.",
                "hold": "HOLD may be conservative for aggressive investors; consider context.",
                "reduce": "REDUCE may limit upside for aggressive portfolios; review rationale.",
            },
        }

        return alignment_notes[self.risk_profile][decision]

    def _calculate_reliability_badge(
        self,
        fund_conf: float,
        sent_conf: float,
        val_conf: float,
    ) -> str:
        """Calculate reliability badge based on agent confidence."""

        avg_confidence = (fund_conf + sent_conf + val_conf) / 3

        if avg_confidence >= 0.80:
            return "🟢 High Reliability"
        elif avg_confidence >= 0.65:
            return "🟡 Moderate Reliability"
        else:
            return "🔴 Low Reliability — Review Carefully"

    def to_json(self, card: DecisionCard) -> str:
        """Convert decision card to JSON for storage."""
        return json.dumps(asdict(card), default=str, indent=2)

    def from_json(self, json_str: str) -> DecisionCard:
        """Parse decision card from JSON."""
        data = json.loads(json_str)
        return DecisionCard(**data)
