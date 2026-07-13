"""
Hushh Kai Financial Agent (ADK Port)

Advanced Financial Analyst Coordinator.
MIGRATED TO ADK (v2.0.0)
"""

import logging
import os
from typing import Any, Dict

from hushh_mcp.hushh_adk.core import HushhAgent
from hushh_mcp.hushh_adk.manifest import ManifestLoader
from hushh_mcp.types import UserID

# Import tools
from .tools import (
    perform_fundamental_analysis,
    perform_sentiment_analysis,
    perform_valuation_analysis,
)

logger = logging.getLogger(__name__)


class KaiAgent(HushhAgent):
    """
    Agentic Kai Financial Coordinator.
    """

    # Pydantic field (ADK 2.x LlmAgent is a pydantic model with extra="forbid");
    # plain attribute assignment before super().__init__ raises there.
    manifest: Any = None

    def __init__(self):
        manifest_path = os.path.join(os.path.dirname(__file__), "agent.yaml")
        manifest = ManifestLoader.load(manifest_path)

        super().__init__(
            name=manifest.name,
            model=manifest.model,
            system_prompt=manifest.system_instruction,
            tools=[
                perform_fundamental_analysis,
                perform_sentiment_analysis,
                perform_valuation_analysis,
            ],
            required_scopes=manifest.required_scopes,
        )
        self.manifest = manifest

    async def handle_message(
        self, message: str, user_id: UserID, consent_token: str = ""
    ) -> Dict[str, Any]:
        """
        Agentic Entry Point.
        """
        try:
            # Execute ADK run
            # Note: For long running analysis, we might want to stream or notify
            response = await self.run_turn(
                message,
                user_id=user_id,
                consent_token=consent_token,
            )

            return {
                "response": str(response),
                "is_complete": True,
            }

        except Exception as e:
            logger.error(f"KaiAgent error: {e}")
            return {
                "response": "I encountered an error analyzing the market data.",
                "error": str(e),
            }


# Singleton
_kai_agent = None


def get_kai_agent():
    global _kai_agent
    if not _kai_agent:
        _kai_agent = KaiAgent()
    return _kai_agent
