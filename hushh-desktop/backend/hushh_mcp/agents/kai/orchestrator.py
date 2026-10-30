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
        """
        Perform complete investment analysis on a ticker.

        Args:
            ticker: Stock ticker symbol (e.g., "AAPL")
            consent_token: Valid consent token for agent.kai.analyze

        Returns:
            DecisionCard with complete analysis

        Raises:
            ValueError: If consent token is invalid
            TimeoutError: If analysis exceeds timeout
        """
        start_time = datetime.utcnow()
        logger.info(f"[Kai] Starting analysis for {ticker}")

        # Step 1: Validate consent
        await self._validate_consent(consent_token)

        try:
            # Step 2: Run parallel agent analysis
            fundamental, sentiment, valuation = await asyncio.wait_for(
                self._run_agent_analysis(ticker, consent_token, context), timeout=ANALYSIS_TIMEOUT
            )

            # Step 3: Orchestrate debate
            debate_result = await self.debate_engine.orchestrate_debate(
                fundamental_insight=fundamental,
                sentiment_insight=sentiment,
                valuation_insight=valuation,
            )

            # Step 4: Generate final decision card
            decision_card = await self.decision_generator.generate_decision(
                ticker=ticker,
                fundamental_insight=fundamental,
                sentiment_insight=sentiment,
                valuation_insight=valuation,
                debate_result=debate_result,
                user_id=self.user_id,
                consent_token=consent_token,
            )

            # Step 5: Log completion
            duration = (datetime.utcnow() - start_time).total_seconds()
            logger.info(f"[Kai] Analysis complete for {ticker} in {duration:.1f}s")

            return decision_card

        except asyncio.TimeoutError:
            logger.error(f"[Kai] Analysis timeout for {ticker}")
            raise TimeoutError(f"Analysis exceeded {ANALYSIS_TIMEOUT}s timeout")
        except Exception as e:
            logger.error(f"[Kai] Analysis failed for {ticker}: {e}")
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
