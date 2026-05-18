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

from .errors import AgentLLMError

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

    def __init__(self):
        manifest_path = os.path.join(os.path.dirname(__file__), "agent.yaml")
        self.manifest = ManifestLoader.load(manifest_path)

        super().__init__(
            name=self.manifest.name,
            model=self.manifest.model,
            system_prompt=self.manifest.system_instruction,
            tools=[
                perform_fundamental_analysis,
                perform_sentiment_analysis,
                perform_valuation_analysis,
            ],
            required_scopes=self.manifest.required_scopes,
        )

    def handle_message(
        self, message: str, user_id: UserID, consent_token: str = ""
    ) -> Dict[str, Any]:
        """
        Agentic Entry Point.

        Raises:
            PermissionError:  Propagated unchanged from HushhAgent when the
                              consent token is missing or lacks the required scope.
            AgentLLMError:    The ADK / Gemini call failed in an unexpected way.
        """
        try:
            response = self.run(message, user_id=user_id, consent_token=consent_token)

            return {
                "response": response.text if hasattr(response, "text") else str(response),
                "is_complete": True,
            }

        except PermissionError:
            # Consent/auth failures — re-raise unchanged so the API layer can
            # map to 401/403 rather than a generic 500.
            raise

        except Exception as exc:
            # logger.exception() captures the full traceback automatically.
            # The old logger.error(f"...{e}") only logged the message string,
            # discarding the stack entirely.
            logger.exception(
                "KaiAgent ADK call failed for user=%s message=%r",
                user_id,
                message[:120],
            )
            raise AgentLLMError(f"KaiAgent run failed: {exc}") from exc


# Singleton
_kai_agent = None


def get_kai_agent():
    global _kai_agent
    if not _kai_agent:
        _kai_agent = KaiAgent()
    return _kai_agent