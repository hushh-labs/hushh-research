"""
Agent Kai — Decision Generator

Synthesizes the output of the 4 specialist agents and the debate result into
a structured decision card for the user.
"""

import logging
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Any, Dict, List, Optional

from .config import DecisionType, RiskProfile
from .debate_engine import DebateResult
from .fundamental_agent import FundamentalInsight
from .macro_agent import MacroInsight
from .sentiment_agent import SentimentInsight
from .valuation_agent import ValuationInsight

logger = logging.getLogger(__name__)


@dataclass
class DecisionCard:
    """
    Structured final output for the user.
    """

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
    macro_insight: Optional[Dict[str, Any]] = None

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


class DecisionGenerator:
    """
    Generator for the final Investment Decision Card.
    """

    LEGAL_DISCLAIMER = (
        "This analysis is provided for informational purposes only and does not constitute "
        "financial advice, investment recommendations, or an offer to buy or sell securities. "
        "Investing in financial markets involves risk. Past performance is not indicative "
        "of future results. Always consult with a qualified financial advisor before making "
        "investment decisions. By using Kai, you acknowledge that you understand these limitations."
    )

    def __init__(self, risk_profile: RiskProfile = "balanced"):
        self.risk_profile = risk_profile

    async def generate_decision(
        self,
        ticker: str,
        user_id: str,
        fundamental_insight: FundamentalInsight,
        sentiment_insight: SentimentInsight,
        valuation_insight: ValuationInsight,
        macro_insight: Optional[MacroInsight],
        debate_result: DebateResult,
        processing_mode: Optional[str] = None,
        consent_token: Optional[str] = None,
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
            macro=macro_insight,
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
        macro: Optional[MacroInsight],
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
            macro: Macro agent's insight (optional)
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
        all_sources = self._collect_sources(fundamental, sentiment, valuation, macro)

        # Aggregate key metrics
        key_metrics = self._aggregate_metrics(fundamental, sentiment, valuation, macro)

        # Generate risk persona alignment note
        risk_alignment = self._generate_risk_alignment(debate.decision, debate.confidence)

        # Determine reliability badge
        reliability_badge = self._calculate_reliability_badge(
            fundamental.confidence,
            sentiment.confidence,
            valuation.confidence,
            macro.confidence if macro else None,
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
            macro_insight=asdict(macro) if macro else None,
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
        )

    def _generate_headline(self, ticker: str, decision: DecisionType, confidence: float) -> str:
        """Generate headline summary."""
        conf_label = "High" if confidence >= 0.8 else "Moderate" if confidence >= 0.6 else "Low"
        return f"{conf_label} confidence {decision.upper()} signal for {ticker}."

    def _create_debate_digest(self, debate: DebateResult) -> str:
        """Summarize the debate process."""
        rounds = len(debate.rounds)
        consensus = "reached consensus" if debate.consensus_reached else "did not reach full consensus"
        return f"Specialist agents completed a {rounds}-round debate and {consensus}."

    def _collect_sources(
        self,
        fundamental: FundamentalInsight,
        sentiment: SentimentInsight,
        valuation: ValuationInsight,
        macro: Optional[MacroInsight] = None,
    ) -> List[str]:
        """Collect all sources."""
        sources = set()
        sources.update(fundamental.sources)
        sources.update(sentiment.sources)
        sources.update(valuation.sources)
        if macro:
            sources.update(macro.sources)
        return sorted(list(sources))

    def _aggregate_metrics(
        self,
        fundamental: FundamentalInsight,
        sentiment: SentimentInsight,
        valuation: ValuationInsight,
        macro: Optional[MacroInsight] = None,
    ) -> Dict[str, Any]:
        """Aggregate key metrics."""
        metrics = {
            "fundamental": fundamental.key_metrics,
            "sentiment": {"score": sentiment.sentiment_score},
            "valuation": valuation.valuation_metrics,
        }
        if macro:
            metrics["macro"] = macro.macro_metrics
        return metrics

    def _generate_risk_alignment(self, decision: DecisionType, confidence: float) -> str:
        """Generate alignment note."""
        if self.risk_profile == "aggressive" and decision == "buy":
            return "Highly aligned with your aggressive growth strategy."
        elif self.risk_profile == "conservative" and decision == "reduce":
            return "Aligned with your capital preservation focus."
        return f"Consistent with a {self.risk_profile} investment approach."

    def _calculate_reliability_badge(
        self,
        fund_conf: float,
        sent_conf: float,
        val_conf: float,
        macro_conf: Optional[float] = None,
    ) -> str:
        """Calculate reliability badge."""
        confs = [fund_conf, sent_conf, val_conf]
        if macro_conf is not None:
            confs.append(macro_conf)

        avg = sum(confs) / len(confs)

        if avg >= 0.8:
            return "HIGH_RELIABILITY"
        elif avg >= 0.6:
            return "MODERATE_RELIABILITY"
        return "LOW_RELIABILITY"
