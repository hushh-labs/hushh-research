"""
Agent Kai — Main Orchestrator (ADK Compliant)

Main entry point for Kai analysis. Coordinates all agents, debate, and decision generation.

This is the "conductor" that brings everything together:
1. Validate consent
2. Instantiate 3 agents
3. Run parallel analysis
4. Orchestrate debate
5. Generate decision card
6. Encrypt and store
"""

import asyncio
import logging
from datetime import datetime
from typing import Any, Dict, Optional

from hushh_mcp.agents.base_agent import HushhAgent
from hushh_mcp.consent.token import validate_token
from hushh_mcp.constants import GEMINI_MODEL, ConsentScope

from .config import ANALYSIS_TIMEOUT, ProcessingMode, RiskProfile
from .debate_engine import DebateEngine
from .decision_generator import DecisionCard, DecisionGenerator
from .fundamental_agent import FundamentalAgent
from .sentiment_agent import SentimentAgent
from .valuation_agent import ValuationAgent

logger = logging.getLogger(__name__)


class KaiOrchestrator(HushhAgent):
    """
    Main Kai Orchestrator - Coordinates entire analysis pipeline.

    ADK-compliant implementation that orchestrates the 3 specialist agents.

    Usage:
        orchestrator = KaiOrchestrator(
            user_id="firebase_uid",
            risk_profile="balanced",
            processing_mode="hybrid"
        )
        decision_card = await orchestrator.analyze(
            ticker="AAPL",
            consent_token="HCT:..."
        )
    """

    def __init__(
        self,
        user_id: str,
        risk_profile: RiskProfile = "balanced",
        processing_mode: ProcessingMode = "hybrid",
    ):
        self.user_id = user_id
        self.risk_profile = risk_profile
        self.processing_mode = processing_mode

        # Initialize with proper ADK parameters
        super().__init__(
            name="Kai Orchestrator",
            model=GEMINI_MODEL,  # Standardized model
            system_prompt="""
            You are the Kai Orchestrator, coordinating 3 specialist agents:
            - Fundamental Analyst (blue)
            - Sentiment Analyst (purple) 
            - Valuation Expert (green)
            
            Your job is to orchestrate their analysis and generate a final investment decision.
            """,
            required_scopes=["agent.kai.analyze"],
        )

        # Instantiate components
        self.fundamental_agent = FundamentalAgent(processing_mode)
        self.sentiment_agent = SentimentAgent(processing_mode)
        self.valuation_agent = ValuationAgent(processing_mode)
        self.debate_engine = DebateEngine(risk_profile)
        self.decision_generator = DecisionGenerator(risk_profile)

        # Concurrency guard — prevents duplicate state transitions.
        # _transition_lock serialises access to _in_flight so that 50
        # simultaneous requests for the same ticker coalesce into a single
        # _execute_analysis call.  Only native asyncio primitives are used;
        # no external locking library.
        # Integrated by Abdul Gaffar — canonical state-orchestrator lock.
        self._transition_lock: asyncio.Lock = asyncio.Lock()
        self._in_flight: Dict[str, asyncio.Future] = {}
        self._transition_count: int = 0  # observable: increments once per unique analysis

        logger.info(
            f"[Kai] Orchestrator initialized - "
            f"User: {user_id}, Risk: {risk_profile}, Mode: {processing_mode}"
        )

    async def analyze(
        self,
        ticker: str,
        consent_token: str,
        context: Optional[Dict[str, Any]] = None,
    ) -> DecisionCard:
        """Perform complete investment analysis on a ticker.

        Race-condition guard
        --------------------
        Concurrent callers for the same ``ticker`` coalesce into a single
        ``_execute_analysis`` call.  The first caller acquires
        ``_transition_lock``, increments ``_transition_count``, creates an
        ``asyncio.Future``, and spawns a background task to settle it.  Every
        subsequent caller for the same ticker (while work is in flight) receives
        the same Future and awaits its result — no duplicate analysis runs.

        Args:
            ticker: Stock ticker symbol (e.g., "AAPL")
            consent_token: Valid consent token for agent.kai.analyze

        Returns:
            DecisionCard with complete analysis

        Raises:
            ValueError: If consent token is invalid
            TimeoutError: If analysis exceeds timeout
        """
        logger.info("[Kai] analyze() called for %s by user %s", ticker, self.user_id)

        # Consent validation is idempotent and does not mutate state —
        # run it before the lock to avoid holding the lock during I/O.
        await self._validate_consent(consent_token)

        key = ticker.upper().strip()

        async with self._transition_lock:
            pending = self._in_flight.get(key)
            if pending is not None and not pending.done():
                # Duplicate in-flight request — coalesce; no new transition.
                logger.info(
                    "[Kai] Lock acquired — coalescing duplicate state transition for %s "
                    "(transition_count=%d)",
                    key,
                    self._transition_count,
                )
                in_flight: asyncio.Future[DecisionCard] = pending
            else:
                # First (or post-completion) request — start a new transition.
                self._transition_count += 1
                logger.info(
                    "[Kai] Lock acquired — initiating state transition #%d for %s",
                    self._transition_count,
                    key,
                )
                future: asyncio.Future[DecisionCard] = asyncio.get_event_loop().create_future()
                self._in_flight[key] = future
                asyncio.create_task(
                    self._run_and_settle(key, future, ticker, consent_token, context)
                )
                in_flight = future

        return await in_flight

    async def _run_and_settle(
        self,
        key: str,
        future: "asyncio.Future[DecisionCard]",
        ticker: str,
        consent_token: str,
        context: Optional[Dict[str, Any]],
    ) -> None:
        """Execute the analysis pipeline and settle *future* with the result.

        Cleans up ``_in_flight[key]`` under the lock once the work is done so
        the next independent request for the same ticker can start a fresh
        transition.
        Integrated by Abdul Gaffar — canonical state-orchestrator lock.
        """
        try:
            result = await self._execute_analysis(ticker, consent_token, context)
            if not future.done():
                future.set_result(result)
        except Exception as exc:
            if not future.done():
                future.set_exception(exc)
        finally:
            async with self._transition_lock:
                if self._in_flight.get(key) is future:
                    self._in_flight.pop(key, None)

    async def _execute_analysis(
        self,
        ticker: str,
        consent_token: str,
        context: Optional[Dict[str, Any]] = None,
    ) -> DecisionCard:
        """Run the full analysis pipeline for *ticker*.

        This is the sole point of actual state mutation.  Only one call per
        ticker is ever in flight at a time (enforced by ``analyze()`` via the
        transition lock).
        """
        start_time = datetime.utcnow()

        try:
            # Step 1: Run parallel agent analysis
            fundamental, sentiment, valuation = await asyncio.wait_for(
                self._run_agent_analysis(ticker, consent_token, context), timeout=ANALYSIS_TIMEOUT
            )

            # Step 2: Orchestrate debate
            debate_result = await self.debate_engine.orchestrate_debate(
                fundamental_insight=fundamental,
                sentiment_insight=sentiment,
                valuation_insight=valuation,
            )

            # Step 3: Generate final decision card
            decision_card = await self.decision_generator.generate_decision(
                ticker=ticker,
                fundamental_insight=fundamental,
                sentiment_insight=sentiment,
                valuation_insight=valuation,
                debate_result=debate_result,
                user_id=self.user_id,
                consent_token=consent_token,
            )

            duration = (datetime.utcnow() - start_time).total_seconds()
            logger.info("[Kai] Analysis complete for %s in %.1fs", ticker, duration)

            return decision_card

        except asyncio.TimeoutError:
            logger.error("[Kai] Analysis timeout for %s", ticker)
            raise TimeoutError(f"Analysis exceeded {ANALYSIS_TIMEOUT}s timeout")
        except Exception as exc:
            logger.error("[Kai] Analysis failed for %s: %s", ticker, exc)
            raise

    async def _validate_consent(self, consent_token: str):
        """Validate that the consent token allows access to Kai analysis."""
        valid, reason, payload = validate_token(
            consent_token, expected_scope=ConsentScope("agent.kai.analyze")
        )

        if not valid:
            raise ValueError(f"Invalid consent token: {reason}")

        if payload.user_id != self.user_id:
            raise ValueError("Token user mismatch")

    async def _run_agent_analysis(
        self, ticker: str, consent_token: str, context: Optional[Dict[str, Any]] = None
    ):
        """Run all 3 agents in parallel."""
        # Create tasks for parallel execution
        fundamental_task = self.fundamental_agent.analyze(
            ticker=ticker, user_id=self.user_id, consent_token=consent_token, context=context
        )

        sentiment_task = self.sentiment_agent.analyze(
            ticker=ticker, user_id=self.user_id, consent_token=consent_token, context=context
        )

        valuation_task = self.valuation_agent.analyze(
            ticker=ticker, user_id=self.user_id, consent_token=consent_token, context=context
        )

        # Execute in parallel and return results
        results = await asyncio.gather(
            fundamental_task, sentiment_task, valuation_task, return_exceptions=True
        )

        # Fix #411: collect ALL failures first so none are silently dropped.
        # The old loop raised on the first exception, making every subsequent
        # agent failure invisible in logs (e.g. auth errors behind network errors).
        exceptions = [(i, r) for i, r in enumerate(results) if isinstance(r, Exception)]
        if exceptions:
            for i, e in exceptions:
                logger.error(f"[Kai] Agent {i} failed: {e}")
            raise exceptions[0][1]  # raise first; all others are now logged

        return results


# Export singleton for convenience
kai_orchestrator = KaiOrchestrator(user_id="default", risk_profile="balanced")
