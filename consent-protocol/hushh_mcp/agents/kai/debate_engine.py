"""
Agent Kai — Debate Engine

Orchestrates round-robin debate between 3 specialist agents to reach consensus.

Key Responsibilities:
- Multi-agent debate orchestration
- Consensus building
- Dissent capture
- Confidence aggregation

SSE Event Format (for sse_starlette):
    yield {
        "event": "<type>",  # e.g., "agent_start", "agent_token", "debate_round"
        "data": {           # Plain dict, NOT JSON-encoded string
            "<field>": "...",
            ...
        }
    }

The sse_starlette library will automatically convert this to SSE format:
    event: agent_start
    data: {"agent": "fundamental", ...}

NOTE: The 'data' field should be a plain dict, not json.dumps()!
"""

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Any, AsyncGenerator, Dict, List, Optional

from hushh_mcp.operons.kai.llm import stream_gemini_response

from .config import (
    AGENT_WEIGHTS,
    CONSENSUS_THRESHOLD,
    DEBATE_ROUNDS,
    DecisionType,
    RiskProfile,
)
from .fundamental_agent import FundamentalInsight
from .sentiment_agent import SentimentInsight
from .valuation_agent import ValuationInsight

logger = logging.getLogger(__name__)


def _safe_float(value: Any) -> Optional[float]:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        parsed = float(value)
        if parsed != parsed:  # NaN guard
            return None
        return parsed
    try:
        text = str(value).strip().replace(",", "")
        if not text:
            return None
        parsed = float(text)
        if parsed != parsed:
            return None
        return parsed
    except Exception:
        return None


def _format_currency(value: Any) -> str:
    parsed = _safe_float(value)
    if parsed is None:
        return "n/a"
    sign = "-" if parsed < 0 else ""
    amount = abs(parsed)
    if amount >= 1_000_000_000:
        return f"{sign}${amount / 1_000_000_000:.2f}B"
    if amount >= 1_000_000:
        return f"{sign}${amount / 1_000_000:.2f}M"
    if amount >= 1_000:
        return f"{sign}${amount / 1_000:.0f}K"
    return f"{sign}${amount:.0f}"


def _format_percent(value: Any) -> str:
    parsed = _safe_float(value)
    if parsed is None:
        return "n/a"
    # Frontend sends coverage in [0,1]. Keep support for [0,100] for safety.
    pct = parsed * 100.0 if parsed <= 1.0 else parsed
    return f"{pct:.0f}%"


@dataclass
class DebateRound:
    """Single round of debate."""

    round_number: int
    agent_statements: Dict[str, str]  # agent_id -> statement
    timestamp: datetime


@dataclass
class DebateResult:
    """Result of multi-agent debate."""

    decision: DecisionType
    confidence: float
    consensus_reached: bool
    rounds: List[DebateRound]
    agent_votes: Dict[str, DecisionType]
    dissenting_opinions: List[str]
    final_statement: str


class DebateEngine:
    """
    Debate Engine - Orchestrates 3-agent discussion with Real-Time Streaming.

    Implements the AlphaAgents framework:
    - Each agent speaks at least twice (A2A Debate)
    - Real-time token streaming from Gemini 3 Flash
    - Round-robin structured debate
    - Consensus building with dissent capture
    - Weighted voting by risk profile

    Args:
        risk_profile: User's risk tolerance ("conservative", "balanced", "aggressive")
        disconnection_event: Optional asyncio.Event to signal when client disconnects
    """

    def __init__(
        self,
        risk_profile: RiskProfile = "balanced",
        disconnection_event: Optional[asyncio.Event] = None,
        user_context: Optional[Dict[str, Any]] = None,
        renaissance_context: Optional[Dict[str, Any]] = None,
    ):
        self.risk_profile = risk_profile
        self.agent_weights = AGENT_WEIGHTS[risk_profile]
        self.rounds: List[DebateRound] = []
        self.current_statements: Dict[str, str] = {}
        self._disconnection_event = disconnection_event
        self.user_context = user_context or {}
        self.renaissance_context = renaissance_context or {}

    async def orchestrate_debate_stream(
        self,
        fundamental_insight: FundamentalInsight,
        sentiment_insight: SentimentInsight,
        valuation_insight: ValuationInsight,
        user_context: Optional[Dict[str, Any]] = None,
    ) -> AsyncGenerator[Dict[str, Any], DebateResult]:
        """
        Orchestrate multi-agent debate with real-time streaming.

        Yields events:
        - round_start
        - kai_thinking
        - agent_start
        - agent_token (streaming content)
        - agent_complete
        - debate_round

        NOTE: Data is a plain dict, NOT JSON-encoded. sse_starlette handles encoding.

        Returns:
        - Final DebateResult object (only in Python 3.13+, currently None)
        """
        logger.info(
            f"[Debate Stream] Starting {DEBATE_ROUNDS}-round debate with {self.risk_profile} profile"
        )

        # Store insights and context
        self.insights = {
            "fundamental": fundamental_insight,
            "sentiment": sentiment_insight,
            "valuation": valuation_insight,
        }
        self.user_context = user_context or {}

        # Buffer for XML stream parsing
        self._xml_buffer = ""

        # =========================================================================
        # ROUND 1: Initial Presentation
        # =========================================================================
        yield {
            "event": "round_start",
            "data": {
                "round": 1,
                "description": "Round 1: Agents present their initial findings.",
                "is_final_round": False,
            },
        }

        # Round-1 is already produced by the route-level agent analysis pass.
        # Reuse those outputs directly to avoid duplicate LLM calls and 429 bursts.
        round1_statements = {
            "fundamental": self._build_deterministic_statement("fundamental", fundamental_insight),
            "sentiment": self._build_deterministic_statement("sentiment", sentiment_insight),
            "valuation": self._build_deterministic_statement("valuation", valuation_insight),
        }
        self.current_statements.update(round1_statements)
        yield {
            "event": "kai_thinking",
            "data": {
                "phase": "round1",
                "message": "Using completed specialist analyses as Round 1 baseline.",
                "tokens": ["Round", "1", "locked", "from", "agent", "analysis", "outputs."],
            },
        }

        # Record Round 1
        self.rounds.append(DebateRound(1, round1_statements, datetime.utcnow()))
        yield {
            "event": "debate_round",
            "data": {
                "round": 1,
                "statements": round1_statements,
                "context": "presenting initial findings",
                "is_final_round": False,
            },
        }

        # =========================================================================
        # ROUND 2: Rebuttal & Consensus Building
        # =========================================================================
        yield {
            "event": "round_start",
            "data": {
                "round": 2,
                "description": "Round 2: Cross-examination and position refinement.",
                "is_final_round": True,
            },
        }

        round2_statements = {}

        # Agent 1: Fundamental Rebuttal
        yield {
            "event": "kai_thinking",
            "data": {
                "phase": "round2",
                "message": "Fundamental Agent is reviewing peer arguments...",
                "tokens": ["Comparing", "intrinsic", "value", "against", "market", "sentiment."],
            },
        }
        async for event in self._stream_agent_turn(
            2, "fundamental", "challenge_positions", round2_statements
        ):
            yield event
        round2_statements["fundamental"] = self.current_statements.get(
            "fundamental",
            self._build_deterministic_statement("fundamental", fundamental_insight),
        )

        if self._disconnection_event and self._disconnection_event.is_set():
            return

        # Agent 2: Sentiment Rebuttal (Moved to 2nd position)
        yield {
            "event": "kai_thinking",
            "data": {
                "phase": "round2",
                "message": "Sentiment Agent is analyzing reaction risks...",
                "tokens": [
                    "Assessing",
                    "potential",
                    "volatility",
                    "from",
                    "conflicting",
                    "signals.",
                ],
            },
        }
        async for event in self._stream_agent_turn(
            2, "sentiment", "challenge_positions", round2_statements
        ):
            yield event
        round2_statements["sentiment"] = self.current_statements.get(
            "sentiment",
            self._build_deterministic_statement("sentiment", sentiment_insight),
        )

        if self._disconnection_event and self._disconnection_event.is_set():
            return

        # Agent 3: Valuation Rebuttal (Moved to 3rd position)
        yield {
            "event": "kai_thinking",
            "data": {
                "phase": "round2",
                "message": "Valuation Agent is stress-testing assumptions...",
                "tokens": [
                    "Checking",
                    "if",
                    "fundamentals",
                    "justify",
                    "the",
                    "current",
                    "premium.",
                ],
            },
        }
        async for event in self._stream_agent_turn(
            2, "valuation", "challenge_positions", round2_statements
        ):
            yield event
        round2_statements["valuation"] = self.current_statements.get(
            "valuation",
            self._build_deterministic_statement("valuation", valuation_insight),
        )

        # Record Round 2
        self.rounds.append(DebateRound(2, round2_statements, datetime.utcnow()))
        yield {
            "event": "debate_round",
            "data": {
                "round": 2,
                "statements": round2_statements,
                "context": "challenging and refining positions",
                "is_final_round": True,
            },
        }

        # =========================================================================
        # CONSENSUS PHASE
        # =========================================================================
        # We don't yield the result here, the caller (stream.py) handles the final decision/yield.
        # But we do return it for the caller to use.
        # UPDATE: Async generators cannot return values in Python < 3.13 (or standard usage).
        # stream.py calculates this manually, so we just finish.
        pass

    async def orchestrate_debate(
        self,
        fundamental_insight: FundamentalInsight,
        sentiment_insight: SentimentInsight,
        valuation_insight: ValuationInsight,
        user_context: Optional[Dict[str, Any]] = None,
    ) -> DebateResult:
        """
        Non-streaming compatibility wrapper for callers that need a final DebateResult.

        The debate engine's canonical implementation is streaming-first. This helper
        consumes the stream internally, then builds the same final consensus object
        used by the streaming route.
        """
        async for _event in self.orchestrate_debate_stream(
            fundamental_insight=fundamental_insight,
            sentiment_insight=sentiment_insight,
            valuation_insight=valuation_insight,
            user_context=user_context,
        ):
            pass

        return await self._build_consensus(
            fundamental=fundamental_insight,
            sentiment=sentiment_insight,
            valuation=valuation_insight,
        )

    async def _stream_agent_turn(
        self,
        round_num: int,
        agent_name: str,
        context_type: str,
        current_round_statements: Dict[str, str],
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Stream an individual agent's turn.

        1. Yields 'agent_start'
        2. Streams 'agent_token' from Gemini
        3. Yields 'agent_complete'

        Checks for client disconnection after each event to stop LLM processing
        when client disconnects abruptly.

        NOTE: Data is a plain dict, NOT JSON-encoded. sse_starlette handles encoding.
        """

        agent_display_names = {
            "fundamental": "Fundamental Agent",
            "sentiment": "Sentiment Agent",
            "valuation": "Valuation Agent",
        }
        phase = "round2" if round_num == 2 else "round1"

        yield {
            "event": "agent_start",
            "data": {
                "agent": agent_name,
                "agent_name": agent_display_names.get(agent_name, agent_name),
                "message": f"Formulating arguments for Round {round_num}...",
                "round": round_num,
                "phase": phase,
            },
        }

        # Reset emitted IDs for this turn
        self.emitted_ids = set()

        # Build prompt
        prompt = self._build_agent_prompt(
            agent_name, round_num, context_type, self.insights[agent_name], current_round_statements
        )

        full_response = ""
        used_fallback = False

        # Stream from Gemini
        stream_error_message: Optional[str] = None
        async for chunk in stream_gemini_response(prompt, agent_name=agent_name):
            if chunk.get("type") == "token":
                text = chunk.get("text", "")
                full_response += text
                yield {
                    "event": "agent_token",
                    "data": {
                        "agent": agent_name,
                        "text": text,
                        "type": "token",
                        "round": round_num,
                        "phase": phase,
                    },
                }
                # Check for disconnection after each token to stop LLM streaming
                if self._disconnection_event is not None and self._disconnection_event.is_set():
                    logger.info(f"[{agent_name}] Client disconnected during streaming, stopping...")
                    return
            elif chunk.get("type") == "error":
                stream_error_message = str(chunk.get("message") or "Unknown streaming error")
                logger.error(f"[{agent_name}] Stream error: {stream_error_message}")

            # Artificial "Thinking" Delay to prevent "Dummy" feel
            await asyncio.sleep(0.05)

            # --- REAL-TIME XML PARSING ---
            # Parse the accumulating response to find completed XML tags
            # We use a simple regex approach on the full_response to find *new* tags
            # To avoid complexity, we just scan for the closing tags and emit if we haven't seen this ID yet.
            import re

            # Pattern for Claims: <claim ...>content</claim>
            # Pattern for Impact: <portfolio_impact ...>content</portfolio_impact>

            # Note: This is a lightweight extraction.
            # Ideally we'd use lxml.etree.iterparse but that requires valid chunks.
            # For 10x implementation, we can do a robust regex scan on the *tail* or full text.

            # Let's extract 'claim' tags that have closed
            claim_iter = re.finditer(
                r'<claim id="([^"]+)" type="([^"]+)" confidence="([^"]+)">([^<]+)</claim>',
                full_response,
            )
            for match in claim_iter:
                claim_id = match.group(1)
                if claim_id not in self.emitted_ids:
                    self.emitted_ids.add(claim_id)
                    yield {
                        "event": "insight_extracted",
                        "data": {
                            "type": "claim",
                            "classification": match.group(2),  # fact/projection
                            "confidence": float(match.group(3)),
                            "content": match.group(4).strip(),
                            "agent": agent_name,
                            "round": round_num,
                            "phase": phase,
                        },
                    }

            # Extract Evidence
            evidence_iter = re.finditer(
                r'<evidence target="([^"]+)" source="([^"]+)">([^<]+)</evidence>', full_response
            )
            for match in evidence_iter:
                # Evidence doesn't have a unique ID usually, so we hash it or check strict equality
                # For simplicity, we assume unique content for now or just emit.
                evidence_content = match.group(3).strip()
                evidence_id = f"ev_{hash(evidence_content)}"
                if evidence_id not in self.emitted_ids:
                    self.emitted_ids.add(evidence_id)
                    yield {
                        "event": "insight_extracted",
                        "data": {
                            "type": "evidence",
                            "target_claim_id": match.group(1),
                            "source": match.group(2),
                            "content": evidence_content,
                            "agent": agent_name,
                            "round": round_num,
                            "phase": phase,
                        },
                    }

            # Extract Portfolio Impact
            impact_iter = re.finditer(
                r'<portfolio_impact type="([^"]+)" magnitude="([^"]+)" score="([^"]+)">([^<]+)</portfolio_impact>',
                full_response,
            )
            for match in impact_iter:
                impact_content = match.group(4).strip()
                impact_id = f"imp_{hash(impact_content)}"
                if impact_id not in self.emitted_ids:
                    self.emitted_ids.add(impact_id)
                    yield {
                        "event": "insight_extracted",
                        "data": {
                            "type": "impact",
                            "classification": match.group(1),  # risk/opportunity
                            "magnitude": match.group(2),  # high/med/low
                            "score": int(match.group(3)),  # 0-10
                            "content": impact_content,
                            "agent": agent_name,
                            "round": round_num,
                            "phase": phase,
                        },
                    }

            # --- TRINITY CARD EXTRACTION (Scientist-Level) ---

            # 1. Personalized Bull Case
            bull_match = re.search(
                r"<bull_case_personalized>(.*?)</bull_case_personalized>", full_response, re.DOTALL
            )
            if bull_match:
                bull_content = bull_match.group(1).strip()
                bull_id = f"bull_{agent_name}_{round_num}"
                if bull_id not in self.emitted_ids:
                    self.emitted_ids.add(bull_id)
                    yield {
                        "event": "insight_extracted",
                        "data": {
                            "type": "bull_case_personalized",
                            "content": bull_content,
                            "agent": agent_name,
                            "round": round_num,
                            "phase": phase,
                        },
                    }

            # 2. Personalized Bear Case
            bear_match = re.search(
                r"<bear_case_personalized>(.*?)</bear_case_personalized>", full_response, re.DOTALL
            )
            if bear_match:
                bear_content = bear_match.group(1).strip()
                bear_id = f"bear_{agent_name}_{round_num}"
                if bear_id not in self.emitted_ids:
                    self.emitted_ids.add(bear_id)
                    yield {
                        "event": "insight_extracted",
                        "data": {
                            "type": "bear_case_personalized",
                            "content": bear_content,
                            "agent": agent_name,
                            "round": round_num,
                            "phase": phase,
                        },
                    }

            # 3. Renaissance Verdict
            ren_match = re.search(
                r"<renaissance_verdict>(.*?)</renaissance_verdict>", full_response, re.DOTALL
            )
            if ren_match:
                ren_content = ren_match.group(1).strip()
                ren_id = f"ren_{agent_name}_{round_num}"
                if ren_id not in self.emitted_ids:
                    self.emitted_ids.add(ren_id)
                    yield {
                        "event": "insight_extracted",
                        "data": {
                            "type": "renaissance_verdict",
                            "content": ren_content,
                            "agent": agent_name,
                            "round": round_num,
                            "phase": phase,
                        },
                    }

        # One agent-local retry for transient provider throttling (429/resource exhausted).
        if (
            not full_response
            and stream_error_message
            and self._is_retryable_stream_error(stream_error_message)
            and not (self._disconnection_event and self._disconnection_event.is_set())
        ):
            retry_delay = 2.0
            yield {
                "event": "agent_error",
                "data": {
                    "agent": agent_name,
                    "error": stream_error_message,
                    "retryable": True,
                    "retrying": True,
                    "retry_in_seconds": retry_delay,
                    "round": round_num,
                    "phase": phase,
                },
            }
            logger.warning(
                "[%s] Stream hit retryable limit, retrying from same turn in %.1fs",
                agent_name,
                retry_delay,
            )
            await asyncio.sleep(retry_delay)
            stream_error_message = None
            async for chunk in stream_gemini_response(prompt, agent_name=agent_name):
                if chunk.get("type") == "token":
                    text = chunk.get("text", "")
                    full_response += text
                    yield {
                        "event": "agent_token",
                        "data": {
                            "agent": agent_name,
                            "text": text,
                            "type": "token",
                            "round": round_num,
                            "phase": phase,
                        },
                    }
                    if self._disconnection_event is not None and self._disconnection_event.is_set():
                        return
                elif chunk.get("type") == "error":
                    stream_error_message = str(chunk.get("message") or "Unknown streaming error")
                    logger.error(f"[{agent_name}] Retry stream error: {stream_error_message}")
                await asyncio.sleep(0.03)

        # Additional pause after full generation to let it sink in before next agent
        await asyncio.sleep(1.0)

        # Fallback if empty (Gemini error or timeout)
        if not full_response:
            used_fallback = True
            full_response = self._build_deterministic_statement(
                agent_name,
                self.insights[agent_name],
                stream_error_message,
            )
            logger.warning(
                "[%s] Falling back to deterministic debate statement: %s",
                agent_name,
                stream_error_message or "empty stream",
            )
            yield {
                "event": "agent_error",
                "data": {
                    "agent": agent_name,
                    "error": stream_error_message or "No data returned from analysis engine.",
                    "fallback_used": True,
                    "round": round_num,
                    "phase": phase,
                },
            }
            # Keep the stream visually alive even on fallback so UX does not "freeze".
            words = full_response.split()
            for idx, word in enumerate(words):
                if self._disconnection_event is not None and self._disconnection_event.is_set():
                    return
                token_text = f"{word} " if idx < len(words) - 1 else word
                yield {
                    "event": "agent_token",
                    "data": {
                        "agent": agent_name,
                        "text": token_text,
                        "type": "token",
                        "round": round_num,
                        "phase": phase,
                    },
                }
                await asyncio.sleep(0.012)

        self.current_statements[agent_name] = full_response

        yield {
            "event": "agent_complete",
            "data": {
                "agent": agent_name,
                "summary": full_response,  # The summary for the card IS the statement
                "recommendation": self.insights[agent_name].recommendation,
                "confidence": self.insights[agent_name].confidence,
                "sentiment_score": getattr(self.insights[agent_name], "sentiment_score", None),
                "fallback_used": used_fallback,
                "round": round_num,
                "phase": phase,
            },
        }

        # Final disconnection check
        if self._disconnection_event is not None and self._disconnection_event.is_set():
            logger.info(f"[{agent_name}] Client disconnected after completion, stopping...")

    def _build_agent_prompt(
        self,
        agent: str,
        round_num: int,
        context_type: str,
        insight: Any,
        current_round_statements: Dict[str, str],
    ) -> str:
        """Construct a specific prompt for the agent's turn."""

        # --- AlphaAgents Persona Injection ---

        # Check for Renaissance Tier
        is_renaissance = (
            self.user_context.get("is_renaissance", False)
            or self.user_context.get("tier") == "renaissance"
        )

        complexity_instruction = ""
        if is_renaissance:
            complexity_instruction = "User is a RENAISSANCE TIER member. Use institutional-grade terminology, reference specific Greeks or advanced ratios if applicable. Do not simplify."
        else:
            complexity_instruction = "Use clear, professional financial language accessible to a knowledgeable retail investor."

        role_desc = ""
        if agent == "fundamental":
            role_desc = (
                "You are 'The Skeptic' (Fundamental Analyst). "
                "You prioritize balance sheet strength, free cash flow, and competitive moats. "
                "You are risk-averse and critical of hype. "
                "You focus on downside protection and long-term durability metrics (ROIC, Margins)."
            )
            details = f"Your Analysis:\n- Recommendation: {insight.recommendation}\n- Moat: {insight.business_moat}\n- Bull: {insight.bull_case}\n- Bear: {insight.bear_case}"

        elif agent == "valuation":
            role_desc = (
                "You are 'The Quant' (Valuation Expert). "
                "You rely strictly on numbers—DCF, multiples (P/E, EV/EBITDA), and historical averages. "
                "You ignore narratives and focus on mispricing. "
                "You are objective, precise, and emotionally detached."
            )
            details = f"Your Analysis:\n- Recommendation: {insight.recommendation}\n- Summary: {insight.summary}"

        else:  # sentiment
            role_desc = (
                "You are 'The Trader' (Sentiment Analyst). "
                "You care about market psychology, news catalysts, and social volume. "
                "You believe price action rules all. "
                "You look for momentum, contrarian signals, and immediate catalysts."
            )
            details = f"Your Analysis:\n- Recommendation: {insight.recommendation}\n- Score: {getattr(insight, 'sentiment_score', 'N/A')}\n- Catalysts: {getattr(insight, 'key_catalysts', 'N/A')}"

        previous_context = ""
        if round_num > 1:
            previous_context = "Round 1 Statements (for context/rebuttal):\n"
            for r in self.rounds:
                for ag, stmt in r.agent_statements.items():
                    if ag != agent:
                        previous_context += f"- {ag.title()} Agent: {stmt}\n"

        task = ""
        if round_num == 1:
            task = (
                f"State your initial position clearly in 3-4 sentences. "
                f"Support it with your key metrics. Be decisive ({insight.recommendation.upper()}). "
                "Do not hedge."
            )
        else:
            task = (
                f"Critique the positions of other agents if they differ from yours. "
                f"If you agree, explain why their evidence reinforces your view from your specific lens. "
                f"Re-affirm your {insight.recommendation.upper()} stance. "
                "Keep it to 2-3 sentences. Be punchy."
            )

        # --- RENAISSANCE CONTEXT (The Truth) ---
        ren_context_str = ""
        if self.renaissance_context:
            tier = self.renaissance_context.get("tier", "Standard")
            fcf = self.renaissance_context.get("fcf_billions", "N/A")
            thesis = self.renaissance_context.get("investment_thesis", "N/A")
            screening_criteria = str(
                self.renaissance_context.get("screening_criteria")
                or self.renaissance_context.get("screening_context")
                or ""
            ).strip()
            screening_excerpt = screening_criteria[:1800] if screening_criteria else ""
            screening_line = (
                "- Screening Criteria:\n" + screening_excerpt if screening_excerpt else ""
            )
            ren_context_str = f"""
        RENAISSANCE DATA (THE MATHEMATICAL TRUTH):
        - Tier: {tier} (ACE/KING = Strong Buy, QUEEN/JACK = Watch/Hold)
        - Free Cash Flow (Billions): {fcf}
        - Thesis: {thesis}
        {screening_line}
        
        MANDATE: You MUST reference this 'Renaissance' data. 
        If Tier is ACE/KING, respect the math even if sentiment is weak.
            """

        # --- USER CONTEXT (The Person) ---
        user_context_str = ""
        if self.user_context:
            risk = self.user_context.get("risk_profile", self.risk_profile)
            holdings = self.user_context.get("holdings_summary", [])
            port_alloc = self.user_context.get("portfolio_allocation", {})
            preferences = self.user_context.get("preferences", {})
            debate_context = self.user_context.get("debate_context", {})
            investment_horizon = preferences.get("investment_horizon", "unknown")
            investment_style = preferences.get("investment_style", "unknown")
            if isinstance(debate_context, dict):
                portfolio_snapshot = debate_context.get("portfolio_snapshot", {})
                coverage = debate_context.get("coverage", {})
                statement_signals = debate_context.get("statement_signals", {})
                eligible_symbols = debate_context.get("eligible_symbols", [])
                top_positions = debate_context.get("top_positions", [])
            else:
                portfolio_snapshot = {}
                coverage = {}
                statement_signals = {}
                eligible_symbols = []
                top_positions = []

            holdings_count = int(self.user_context.get("holdings_count") or 0)
            if holdings_count <= 0 and isinstance(holdings, list):
                holdings_count = len(holdings)

            investable_count = (
                int(_safe_float(portfolio_snapshot.get("investable_holdings_count")) or 0)
                if isinstance(portfolio_snapshot, dict)
                else 0
            )
            cash_positions_count = (
                int(_safe_float(portfolio_snapshot.get("cash_positions_count")) or 0)
                if isinstance(portfolio_snapshot, dict)
                else 0
            )
            total_value = (
                portfolio_snapshot.get("total_value")
                if isinstance(portfolio_snapshot, dict)
                else self.user_context.get("total_value")
            )
            cash_balance = (
                portfolio_snapshot.get("cash_balance")
                if isinstance(portfolio_snapshot, dict)
                else self.user_context.get("cash_balance")
            )
            allocation_summary = "n/a"
            if isinstance(port_alloc, dict) and port_alloc:
                allocation_entries: list[str] = []
                preferred_keys = ("equities", "cash", "fixed_income", "other")
                for key in preferred_keys:
                    parsed = _safe_float(port_alloc.get(key))
                    if parsed is None:
                        continue
                    allocation_entries.append(f"{key}:{parsed:.1f}%")
                if not allocation_entries:
                    for key, raw_value in list(port_alloc.items())[:4]:
                        parsed = _safe_float(raw_value)
                        if parsed is None:
                            continue
                        allocation_entries.append(f"{key}:{parsed:.1f}%")
                if allocation_entries:
                    allocation_summary = ", ".join(allocation_entries)

            top_position_lines: list[str] = []
            if isinstance(top_positions, list):
                for item in top_positions[:5]:
                    if not isinstance(item, dict):
                        continue
                    symbol = str(item.get("symbol") or "").strip().upper()
                    if not symbol:
                        continue
                    mv = _format_currency(item.get("market_value"))
                    top_position_lines.append(f"{symbol} ({mv})")
            if not top_position_lines and isinstance(holdings, list):
                for item in holdings[:5]:
                    if not isinstance(item, dict):
                        continue
                    symbol = str(item.get("symbol") or "").strip().upper()
                    if not symbol:
                        continue
                    mv = _format_currency(item.get("market_value"))
                    top_position_lines.append(f"{symbol} ({mv})")

            eligible_preview: list[str] = []
            if isinstance(eligible_symbols, list):
                eligible_preview = [
                    str(symbol).strip().upper()
                    for symbol in eligible_symbols[:8]
                    if str(symbol).strip()
                ]

            user_context_str = f"""
        USER CONTEXT (THE PERSON):
        - Risk Profile: {risk}
        - Investment Horizon: {investment_horizon}
        - Investment Style: {investment_style}
        - Holdings Count: {holdings_count}
        - Investable Symbols: {investable_count or len(eligible_preview)}
        - Cash Positions: {cash_positions_count}
        - Portfolio Value: {_format_currency(total_value)} | Cash: {_format_currency(cash_balance)}
        - Coverage (Ticker / Sector / Gain-Loss): {_format_percent(coverage.get("ticker_coverage_pct") if isinstance(coverage, dict) else None)} / {_format_percent(coverage.get("sector_coverage_pct") if isinstance(coverage, dict) else None)} / {_format_percent(coverage.get("gain_loss_coverage_pct") if isinstance(coverage, dict) else None)}
        - Statement Signals: Investment Results {_format_currency(statement_signals.get("investment_gain_loss") if isinstance(statement_signals, dict) else None)}, Income {_format_currency(statement_signals.get("total_income_period") if isinstance(statement_signals, dict) else None)}, Fees {_format_currency(statement_signals.get("total_fees") if isinstance(statement_signals, dict) else None)}
        - Eligible Symbol Sample: {", ".join(eligible_preview) if eligible_preview else "n/a"}
        - Top Positions: {", ".join(top_position_lines) if top_position_lines else "n/a"}
        - Allocation Snapshot: {allocation_summary}
        
        MANDATE: You MUST personalize your argument.
        Example: "Since you own [Holding], adding [Ticker] increases/decreases risk..."
            """

        prompt = f"""
        {role_desc}
        
        DEBATE PROTOCOL (AlphaAgents 2508.11152):
        - Round-robin, adversarial collaboration.
        - Each specialist speaks at least twice and must challenge weak assumptions.
        - Prefer evidence over narrative. Convert disagreements into explicit portfolio impact.
        - Keep claims falsifiable and tied to available data.

        CONTEXT FUSION RULES (MANDATORY):
        - Reference at least one Renaissance screening signal (tier, investable/avoid, rubric criteria).
        - Reference at least one PKM portfolio fact (holdings, concentration, coverage, or statement signal).
        - Explicitly frame risk tradeoff (concentration/diversification/downside) for this user.
        - If your view conflicts with Renaissance screening, state the conflict and mitigation.
        - Avoid raw data dumps; use only the highest-signal facts.
        
        AUDIENCE CONTEXT:
        User Name: {self.user_context.get("user_name", "Value Investor")}
        {user_context_str}
        {ren_context_str}
        {complexity_instruction}
        
        YOUR DATA:
        {details}
        
        {previous_context}
        
        TASK:
        {task}
        
        STRICT OUTPUT FORMAT (XML):
        <analysis>
           <thought>Step-by-step reasoning...</thought>
           
           <claim id="c1" type="fact/projection" confidence="0.9">Key point here</claim>
           <evidence target="c1" source="SEC/News">Quote or metric</evidence>
           <portfolio_impact type="risk/opportunity" magnitude="high" score="8">Impact on user</portfolio_impact>
           
           <!-- TRINITY CARDS - MANDATORY SECTIONS -->
           <bull_case_personalized>
               [Why THIS USER specifically should be bullish. Reference their portfolio/goals.]
           </bull_case_personalized>
           
           <bear_case_personalized>
               [Why THIS USER specifically should be worried. Reference their risk profile/holdings.]
           </bear_case_personalized>
           
           <renaissance_verdict>
               [The Mathematical Truth. Cite the Tier, FCF, and Thesis explicitly.]
           </renaissance_verdict>
        </analysis>
        """
        return prompt

    def _build_deterministic_statement(
        self,
        agent_name: str,
        insight: Any,
        stream_error_message: Optional[str] = None,
    ) -> str:
        """
        Build a deterministic debate statement from already-computed agent insights.
        This prevents debate orchestration from failing when live LLM token streaming is unavailable.
        """
        recommendation = str(getattr(insight, "recommendation", "hold")).upper()
        confidence = float(getattr(insight, "confidence", 0.5) or 0.5)
        summary = str(getattr(insight, "summary", "") or "").strip()

        base = (
            summary if summary else f"{agent_name.capitalize()} analysis supports {recommendation}."
        )
        extra = ""

        if agent_name == "fundamental":
            moat = str(getattr(insight, "business_moat", "") or "").strip()
            bull = str(getattr(insight, "bull_case", "") or "").strip()
            bear = str(getattr(insight, "bear_case", "") or "").strip()
            details = [val for val in (moat, bull, bear) if val]
            if details:
                extra = " ".join(details[:2])
        elif agent_name == "sentiment":
            catalysts = getattr(insight, "key_catalysts", None)
            if isinstance(catalysts, list) and catalysts:
                extra = f"Key catalyst: {str(catalysts[0])}."
        elif agent_name == "valuation":
            price_targets = getattr(insight, "price_targets", None)
            if isinstance(price_targets, dict) and price_targets:
                target = price_targets.get("base_case") or price_targets.get("fair_value")
                if target is not None:
                    extra = f"Base valuation reference: {target}."

        reason = (
            f" Live streaming unavailable ({stream_error_message})." if stream_error_message else ""
        )
        return (
            f"{base} Recommendation: {recommendation} ({confidence:.0%} confidence)."
            f"{(' ' + extra) if extra else ''}{reason}"
        ).strip()

    def _is_retryable_stream_error(self, message: str) -> bool:
        text = str(message).lower()
        markers = (
            "429",
            "too many requests",
            "rate limit",
            "resource_exhausted",
            "quota",
        )
        return any(marker in text for marker in markers)

    async def _build_consensus(
        self,
        fundamental: FundamentalInsight,
        sentiment: SentimentInsight,
        valuation: ValuationInsight,
    ) -> DebateResult:
        """Build consensus from agent insights (Unchanged logic)."""

        # Collect agent votes
        agent_votes = {
            "fundamental": self._recommendation_to_decision(fundamental.recommendation),
            "sentiment": self._recommendation_to_decision(sentiment.recommendation),
            "valuation": self._recommendation_to_decision(valuation.recommendation),
        }

        # Calculate weighted decision
        decision, confidence = self._calculate_weighted_decision(fundamental, sentiment, valuation)

        # Check for consensus
        unique_votes = set(agent_votes.values())
        consensus_reached = len(unique_votes) == 1 or confidence >= CONSENSUS_THRESHOLD

        # Capture dissent
        dissenting_opinions = []
        majority_decision = decision
        for agent_id, vote in agent_votes.items():
            if vote != majority_decision:
                dissenting_opinions.append(
                    f"{agent_id.capitalize()} agent dissents: recommends {vote}"
                )

        # Generate final statement
        final_statement = self._generate_final_statement(
            decision, confidence, consensus_reached, dissenting_opinions
        )

        return DebateResult(
            decision=decision,
            confidence=confidence,
            consensus_reached=consensus_reached,
            rounds=self.rounds,
            agent_votes=agent_votes,
            dissenting_opinions=dissenting_opinions,
            final_statement=final_statement,
        )

    def _recommendation_to_decision(self, recommendation: str) -> DecisionType:
        """Convert agent recommendation to decision type."""
        rec = recommendation.lower()
        if any(x in rec for x in ["buy", "bullish", "undervalued"]):
            return "buy"
        elif any(x in rec for x in ["reduce", "bearish", "overvalued", "sell"]):
            return "reduce"
        else:
            return "hold"

    def _calculate_weighted_decision(
        self,
        fundamental: FundamentalInsight,
        sentiment: SentimentInsight,
        valuation: ValuationInsight,
    ) -> tuple[DecisionType, float]:
        """Calculate weighted decision based on risk profile."""

        # Convert recommendations to numeric scores
        scores = {
            "fundamental": self._rec_to_score(fundamental.recommendation),
            "sentiment": self._rec_to_score(sentiment.recommendation),
            "valuation": self._rec_to_score(valuation.recommendation),
        }

        # Calculate weighted score
        weighted_score = (
            scores["fundamental"] * self.agent_weights["fundamental"]
            + scores["sentiment"] * self.agent_weights["sentiment"]
            + scores["valuation"] * self.agent_weights["valuation"]
        )
        weighted_score += self._context_score_shift(scores)
        weighted_score = max(-1.0, min(1.0, weighted_score))

        # Calculate weighted confidence
        weighted_confidence = (
            fundamental.confidence * self.agent_weights["fundamental"]
            + sentiment.confidence * self.agent_weights["sentiment"]
            + valuation.confidence * self.agent_weights["valuation"]
        )
        weighted_confidence = max(0.0, min(1.0, weighted_confidence))

        # Convert score to decision
        if weighted_score > 0.3:
            decision = "buy"
        elif weighted_score < -0.3:
            decision = "reduce"
        else:
            decision = "hold"

        return decision, weighted_confidence

    def _context_score_shift(self, scores: Dict[str, float]) -> float:
        """
        Apply bounded score overlays from Renaissance + user preferences.
        This keeps core agent voting intact while honoring personalized context.
        """
        shift = 0.0

        # Renaissance overlays from Supabase-backed screening tables.
        tier = str((self.renaissance_context or {}).get("tier") or "").upper()
        is_investable = bool((self.renaissance_context or {}).get("is_investable"))
        is_avoid = bool((self.renaissance_context or {}).get("is_avoid"))
        conviction_raw = (self.renaissance_context or {}).get("conviction_weight")
        try:
            conviction_weight = float(conviction_raw) if conviction_raw is not None else 0.0
        except (TypeError, ValueError):
            conviction_weight = 0.0

        if is_avoid:
            shift -= 0.35
        elif is_investable and conviction_weight > 0:
            # ACE/KING amplify upside modestly; QUEEN/JACK near-neutral.
            shift += max(-0.2, min(0.2, (conviction_weight - 0.5) * 0.5))
            if tier in {"ACE", "KING"} and scores["fundamental"] > 0:
                shift += 0.05

        # User preference overlays from PKM context.
        preferences = self.user_context.get("preferences", {}) if self.user_context else {}
        style = str(preferences.get("investment_style") or "").lower()
        horizon = str(preferences.get("investment_horizon") or "").lower()

        if "growth" in style and scores["fundamental"] > 0:
            shift += 0.05
        if "value" in style and scores["valuation"] > 0:
            shift += 0.05
        if "income" in style or "preservation" in style:
            shift += -0.05 if scores["sentiment"] < 0 else 0.0

        if "short" in horizon:
            shift += 0.05 * scores["sentiment"]
        elif "long" in horizon:
            shift += 0.05 * scores["fundamental"]

        return max(-0.4, min(0.4, shift))

    def _rec_to_score(self, recommendation: str) -> float:
        """Convert recommendation to numeric score."""
        rec = recommendation.lower()
        if any(x in rec for x in ["buy", "bullish", "undervalued"]):
            return 1.0
        elif any(x in rec for x in ["reduce", "bearish", "overvalued", "sell"]):
            return -1.0
        else:
            return 0.0

    def _generate_final_statement(
        self,
        decision: DecisionType,
        confidence: float,
        consensus: bool,
        dissent: List[str],
    ) -> str:
        """Generate final consensus statement."""

        consensus_word = "unanimous" if consensus else "majority"
        dissent_note = f" (with {len(dissent)} dissenting opinion(s))" if dissent else ""

        return (
            f"After {DEBATE_ROUNDS} rounds of analysis, the committee has reached a "
            f"{consensus_word} decision to {decision.upper()} with {confidence:.0%} confidence{dissent_note}."
        )
