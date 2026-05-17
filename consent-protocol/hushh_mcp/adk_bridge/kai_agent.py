import asyncio
import logging

from python_a2a.models.content import ErrorContent, TextContent
from python_a2a.models.message import Message, MessageRole
from python_a2a.server.a2a_server import A2AServer

from hushh_mcp.adk_bridge.delegation import validate_a2a_consent_token
from hushh_mcp.agents.kai.debate_engine import DebateEngine
from hushh_mcp.agents.kai.fundamental_agent import FundamentalAgent
from hushh_mcp.agents.kai.sentiment_agent import SentimentAgent
from hushh_mcp.agents.kai.valuation_agent import ValuationAgent
from hushh_mcp.hushh_adk.context import HushhContext
from hushh_mcp.services.consent_db import ConsentDBService

logger = logging.getLogger(__name__)


class KaiA2AServer(A2AServer):
    """
    A2A Server implementation for Agent Kai.
    Strictly enforces BYOK and Consent via A2A Metadata.
    """

    def __init__(self, **kwargs):
        # Initialize Core Services
        self.debate_engine = DebateEngine()
        self.consent_db = ConsentDBService()

        # Initialize Sub-Agents
        self.fundamental_agent = FundamentalAgent(processing_mode="hybrid")
        self.sentiment_agent = SentimentAgent(processing_mode="hybrid")
        self.valuation_agent = ValuationAgent(processing_mode="hybrid")

        # Initialize Parent A2AServer
        super().__init__(**kwargs)

    def handle_message(self, message: Message) -> Message:
        """
        Main entry point for A2A messages.
        Blocks execution until debate completes (for synchronous A2A).
        """
        try:
            # 1. SECURITY: Extract Consent Token
            from flask import request

            consent_token = request.headers.get("X-Consent-Token")
            # Fallback: Check if client passed it in message content/metadata

            if not consent_token:
                logger.warning("A2A Request rejected: Missing X-Consent-Token")
                return self._create_error_response(
                    message, "Access Denied: Missing 'X-Consent-Token' header for BYOK."
                )

            # 2. VALIDATION
            # Validate token using the least-privilege Kai A2A specialist scope.
            validation = validate_a2a_consent_token("agent_kai", consent_token)

            if not validation.ok or not validation.user_id:
                logger.warning(f"A2A Request rejected: Invalid Token ({validation.reason})")
                return self._create_error_response(
                    message, f"Access Denied: Invalid Consent Token. {validation.reason}"
                )

            user_id = validation.user_id

            # 2.1 Audit Logging
            try:
                self._run_async(
                    self.consent_db.log_operation(
                        user_id=user_id,
                        operation="kai.analyze.a2a",
                        target="message",
                        metadata={"protocol": "a2a"},
                    )
                )
            except Exception as e:
                logger.error(f"Failed to log A2A access: {e}")

            # 3. PROCESSING
            input_text = message.content.text
            ticker = input_text.strip().upper()

            # Run Full Analysis Pipeline
            logger.info(f"Starting A2A Analysis for {ticker} (User: {user_id})")
            result_text = self._run_analysis_pipeline(user_id, consent_token, ticker)

            return Message(
                content=TextContent(text=result_text),
                role=MessageRole.AGENT,
                parent_message_id=message.message_id,
                conversation_id=message.conversation_id,
            )

        except Exception as e:
            logger.exception("Error in handle_message")
            return self._create_error_response(message, f"Internal Error: {str(e)}")

    def _run_async(self, coro):
        """Helper to run async code in this sync method."""
        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

        if loop.is_running():
            import concurrent.futures

            with concurrent.futures.ThreadPoolExecutor() as pool:
                return pool.submit(asyncio.run, coro).result()
        else:
            return loop.run_until_complete(coro)

    def _run_analysis_pipeline(self, user_id: str, token: str, ticker: str) -> str:
        """Runs the full agent pipeline: Fundamental -> Sentiment -> Valuation -> Debate."""

        async def _execute():
            # Set Context
            HushhContext(user_id=user_id, consent_token=token)

            # 1. Run Parallel Agent Analysis
            logger.info("Running sub-agents...")
            f_task = self.fundamental_agent.analyze(
                ticker=ticker, user_id=user_id, consent_token=token
            )
            s_task = self.sentiment_agent.analyze(
                ticker=ticker, user_id=user_id, consent_token=token
            )
            v_task = self.valuation_agent.analyze(
                ticker=ticker, user_id=user_id, consent_token=token
            )

            # Gather results
            fundamental, sentiment, valuation = await asyncio.gather(f_task, s_task, v_task)

            # 2. Run Debate Orchestration
            logger.info("Starting Debate...")
            acc_text = f"# Analysis for {ticker}\n\n"
            acc_text += (
                f"**Fundamental**: {fundamental.recommendation} ({fundamental.confidence:.0%})\n"
            )
            acc_text += f"**Sentiment**: {sentiment.recommendation} ({sentiment.confidence:.0%})\n"
            acc_text += (
                f"**Valuation**: {valuation.recommendation} ({valuation.confidence:.0%})\n\n"
            )
            acc_text += "## Debate Transcript\n\n"

            async for event in self.debate_engine.orchestrate_debate_stream(
                fundamental_insight=fundamental,
                sentiment_insight=sentiment,
                valuation_insight=valuation,
            ):
                if event["event"] == "agent_token":
                    pass
                elif event["event"] == "agent_complete":
                    data = event["data"]
                    acc_text += f"\n**{data['agent_name']}**: {data['summary']}\n"
                elif event["event"] == "decision":
                    acc_text += f"\n## Final Decision: {event['decision'].upper()}\n"
                    acc_text += event["final_statement"]

            # 3. Final Decision Logic
            result = await self.debate_engine._build_consensus(fundamental, sentiment, valuation)
            acc_text += f"\n\n## Conclusion\n{result.final_statement}"

            return acc_text

        return self._run_async(_execute())

    def _create_error_response(self, original_msg: Message, error_text: str) -> Message:
        return Message(
            content=ErrorContent(message=error_text),
            role=MessageRole.AGENT,
            parent_message_id=original_msg.message_id,
            conversation_id=original_msg.conversation_id,
        )
