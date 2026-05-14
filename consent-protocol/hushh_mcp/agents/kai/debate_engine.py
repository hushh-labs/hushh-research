import asyncio
import re
import logging
from datetime import datetime
from typing import AsyncGenerator, Dict, List, Optional, Any, Set
from dataclasses import dataclass, field

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
        If Valuation says BUY (90%) and Fundamental says SELL (90%), 
        global confidence should collapse, not average to 90%.
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
        Advanced overlay logic using the 'Kelly Criterion' mindset:
        Adjust sizing/conviction based on Renaissance mathematical tiering.
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