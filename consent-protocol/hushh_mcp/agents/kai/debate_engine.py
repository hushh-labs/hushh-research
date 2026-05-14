import logging
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, AsyncGenerator, Dict, List, Set

from ...operons.kai.llm import stream_gemini_response

# Restore missing imports
from .config import AGENT_WEIGHTS, CONSENSUS_THRESHOLD, DEBATE_ROUNDS, DecisionType, RiskProfile

# Specialist types for type hinting
from .fundamental_agent import FundamentalInsight
from .sentiment_agent import SentimentInsight
from .valuation_agent import ValuationInsight


# Use a specific exception for orchestration failures
class DebateError(Exception):
    """Base class for debate engine errors."""

@dataclass(frozen=True)
class AgentInsight:
    """Standardized extracted insight from XML streams."""
    type: str
    content: str
    agent: str
    round: int
    metadata: Dict[str, Any] = field(default_factory=dict)

@dataclass
class DebateRound:
    """A single round of debate with agent statements."""
    round_number: int
    agent_statements: Dict[str, str]
    timestamp: datetime = field(default_factory=datetime.utcnow)

@dataclass
class DebateResult:
    """The final result of a multi-agent debate."""
    decision: DecisionType
    confidence: float
    consensus_reached: bool
    rounds: List[DebateRound]
    agent_votes: Dict[str, DecisionType]
    dissenting_opinions: List[str]
    final_statement: str

class DebateEngine:
    """
    Enhanced Debate Engine with Linear Stream Parsing and Bayesian Weighted Logic.
    """

    # Compiled regex for O(1) lookup speed per token chunk
    TAG_PATTERNS = {
        "claim": re.compile(r'<claim id="(?P<id>[^"]+)" type="(?P<type>[^"]+)" confidence="(?P<conf>[^"]+)">(?P<content>.*?)</claim>', re.DOTALL),
        "impact": re.compile(r'<portfolio_impact type="(?P<type>[^"]+)" magnitude="(?P<mag>[^"]+)" score="(?P<score>[^"]+)">(?P<content>.*?)</portfolio_impact>', re.DOTALL),
        "verdict": re.compile(r'<renaissance_verdict>(?P<content>.*?)</renaissance_verdict>', re.DOTALL),
    }

    def __init__(self, risk_profile: RiskProfile = "balanced", **kwargs):
        self.risk_profile = risk_profile
        self.agent_weights = AGENT_WEIGHTS[risk_profile]
        self.rounds: List[DebateRound] = []
        self.current_statements: Dict[str, str] = {}
        self.user_context = kwargs.get("user_context", {})
        self.renaissance_context = kwargs.get("renaissance_context", {})
        self._emitted_tags: Set[str] = set() # Track unique tag IDs to prevent duplicates

    async def orchestrate_debate(
        self,
        fundamental_insight: FundamentalInsight,
        sentiment_insight: SentimentInsight,
        valuation_insight: ValuationInsight,
    ) -> DebateResult:
        """
        Conduct multi-round debate between agents to reach a consensus.
        """
        logger = logging.getLogger(__name__)
        logger.info(f"[Debate] Starting orchestration for profile: {self.risk_profile}")

        # Round 1: Initial positions
        round_1 = await self._conduct_round(
            round_num=1,
            fundamental=fundamental_insight,
            sentiment=sentiment_insight,
            valuation=valuation_insight,
            context="initial_analysis",
        )
        self.rounds.append(round_1)

        # Round 2: Rebuttal / Challenge
        if DEBATE_ROUNDS >= 2:
            round_2 = await self._conduct_round(
                round_num=2,
                fundamental=fundamental_insight,
                sentiment=sentiment_insight,
                valuation=valuation_insight,
                context="challenge_positions",
            )
            self.rounds.append(round_2)

        # Build consensus and return result
        return await self._build_consensus(
            fundamental_insight,
            sentiment_insight,
            valuation_insight,
        )

    async def _conduct_round(
        self,
        round_num: int,
        fundamental: FundamentalInsight,
        sentiment: SentimentInsight,
        valuation: ValuationInsight,
        context: str,
    ) -> DebateRound:
        """Conduct a single round of debate."""
        statements = {
            "fundamental": await self._generate_statement("fundamental", fundamental, round_num, context),
            "sentiment": await self._generate_statement("sentiment", sentiment, round_num, context),
            "valuation": await self._generate_statement("valuation", valuation, round_num, context),
        }
        return DebateRound(round_number=round_num, agent_statements=statements)

    async def _generate_statement(self, agent: str, insight: Any, round_num: int, context: str) -> str:
        """Generate statement (Simplified for now, would typically use LLM)."""
        if hasattr(insight, "summary"):
            return f"[{agent.upper()} Round {round_num}] {insight.summary}"
        return f"[{agent.upper()} Round {round_num}] Analysis support: {insight.recommendation}"

    async def _build_consensus(
        self,
        fundamental: FundamentalInsight,
        sentiment: SentimentInsight,
        valuation: ValuationInsight,
    ) -> DebateResult:
        """Aggregate insights and calculate final weighted decision."""
        agent_votes = {
            "fundamental": self._recommendation_to_decision(fundamental.recommendation),
            "sentiment": self._recommendation_to_decision(sentiment.recommendation),
            "valuation": self._recommendation_to_decision(valuation.recommendation),
        }

        decision, confidence = self._calculate_weighted_decision(fundamental, sentiment, valuation)
        
        unique_votes = set(agent_votes.values())
        consensus_reached = len(unique_votes) == 1 or confidence >= CONSENSUS_THRESHOLD
        
        dissenting_opinions = [
            f"{k.capitalize()} prefers {v}" for k, v in agent_votes.items() if v != decision
        ]

        final_statement = f"The committee has reached a {decision.upper()} decision with {confidence:.0%} confidence."
        if consensus_reached and len(unique_votes) == 1:
            final_statement = f"The committee reached a UNANIMOUS {decision.upper()} decision."

        return DebateResult(
            decision=decision,
            confidence=confidence,
            consensus_reached=consensus_reached,
            rounds=self.rounds,
            agent_votes=agent_votes,
            dissenting_opinions=dissenting_opinions,
            final_statement=final_statement,
        )

    def _recommendation_to_decision(self, rec: str) -> DecisionType:
        rec = rec.lower()
        if rec in ["buy", "bullish", "undervalued"]:
            return "buy"
        if rec in ["reduce", "bearish", "overvalued"]:
            return "reduce"
        return "hold"

    def _calculate_weighted_decision(
        self, fund: FundamentalInsight, sent: SentimentInsight, val: ValuationInsight
    ) -> tuple[DecisionType, float]:
        scores = {
            "fundamental": self._rec_to_score(fund.recommendation),
            "sentiment": self._rec_to_score(sent.recommendation),
            "valuation": self._rec_to_score(val.recommendation),
        }
        
        weighted_score = sum(scores[k] * self.agent_weights[k] for k in scores)
        weighted_conf = sum(getattr(i, "confidence", 0.7) * self.agent_weights[k] for k, i in 
                            {"fundamental": fund, "sentiment": sent, "valuation": val}.items())

        if weighted_score > 0.3:
            return "buy", weighted_conf
        if weighted_score < -0.3:
            return "reduce", weighted_conf
        return "hold", weighted_conf

    def _rec_to_score(self, rec: str) -> float:
        rec = rec.lower()
        if rec in ["buy", "bullish", "undervalued"]:
            return 1.0
        if rec in ["reduce", "bearish", "overvalued"]:
            return -1.0
        return 0.0

    async def _stream_agent_turn(self, round_num: int, agent_name: str, prompt: str) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Refactored turn logic with Linear-Time XML Extraction and state safety.
        """
        full_response = ""
        # We only scan the last 1000 characters to ensure O(N) performance
        SCAN_WINDOW = 1000 

        async for chunk in stream_gemini_response(prompt, agent_name=agent_name):
            if chunk.get("type") == "token":
                token = chunk.get("text", "")
                full_response += token
                
                # Emit token
                yield self._create_sse_event("agent_token", {
                    "agent": agent_name, "text": token, "round": round_num
                })

                # Linear Scan for XML Tags
                lookback = full_response[-SCAN_WINDOW:]
                for tag_type, pattern in self.TAG_PATTERNS.items():
                    for match in pattern.finditer(lookback):
                        # Create a unique key for this insight (type + content hash)
                        content = match.group("content").strip()
                        tag_id = f"{tag_type}_{hash(content)}"
                        
                        if tag_id not in self._emitted_tags:
                            self._emitted_tags.add(tag_id)
                            yield self._create_sse_event("insight_extracted", {
                                "type": tag_type,
                                "agent": agent_name,
                                "content": content,
                                "metadata": match.groupdict()
                            })

    def _calculate_bayesian_confidence(self, insights: List[Any]) -> float:
        """
        Implements a confidence penalty for high variance between agents.
        """
        scores = [self._rec_to_score(i.recommendation) for i in insights]
        avg_conf = sum(i.confidence for i in insights) / len(insights)
        
        # Calculate variance (disagreement)
        variance = sum((s - (sum(scores)/len(scores)))**2 for s in scores) / len(scores)
        
        # Penalty: Confidence is reduced by the square of the disagreement
        return max(0.1, avg_conf * (1.0 - (variance * 1.5)))

    @staticmethod
    def _create_sse_event(event_type: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """Centralized SSE event factory to ensure consistent format."""
        return {
            "event": event_type,
            "data": data
        }

    def _context_score_shift(self, scores: Dict[str, float]) -> float:
        """
        Advanced overlay logic using the 'Kelly Criterion' mindset.
        """
        shift = 0.0
        ren = self.renaissance_context or {}
        tier = str(ren.get("tier", "")).upper()
        
        # ACE/KING Tiers act as a 'Floor' for high-conviction buys
        tier_multipliers = {"ACE": 0.3, "KING": 0.2, "QUEEN": 0.05, "JACK": -0.05}
        shift += tier_multipliers.get(tier, 0.0)

        # Portfolio Concentration Guard
        holdings_count = int(self.user_context.get("holdings_count", 0))
        if holdings_count < 5 and scores.get("fundamental", 0) < 0:
            # Aggressive penalty if the user is concentrated and the skeptic is worried
            shift -= 0.15

        return max(-0.5, min(0.5, shift))