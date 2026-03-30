"""
Hushh Orchestrator Agent (ADK Port)

Central routing agent that uses LLM semantic understanding to delegate tasks.
Replaces legacy regex/classifier logic.
"""

import logging
import os
from typing import Any, Dict

from hushh_mcp.hushh_adk.core import HushhAgent
from hushh_mcp.hushh_adk.manifest import ManifestLoader

# Import tools for registration
from .tools import delegate_to_food_agent, delegate_to_kai_agent, delegate_to_professional_agent

logger = logging.getLogger(__name__)


class OrchestratorAgent(HushhAgent):
    """
    Semantic Router for Hushh Ecosystem.
    """

    def __init__(self):
        # Load manifest
        manifest_path = os.path.join(os.path.dirname(__file__), "agent.yaml")
        self.manifest = ManifestLoader.load(manifest_path)

        # Initialize ADK Agent with tools
        super().__init__(
            name=self.manifest.name,
            model=self.manifest.model,
            system_prompt=self.manifest.system_instruction,
            tools=[delegate_to_food_agent, delegate_to_professional_agent, delegate_to_kai_agent],
            required_scopes=self.manifest.required_scopes,
        )

    def handle_message(self, message: str, user_id: str, consent_token: str = "") -> Dict[str, Any]:
        """
        Main entry point for routing.

        Args:
            message: User input
            user_id: User identifier
            consent_token: (Optional) Token, though Orchestrator is often public entry

        Returns:
            Dict containing response text and optional delegation info.
        """
        # Orchestrator often runs without a strict token at entry (public gatekeeper)
        # But if we pass specific user data, we might need one.
        # For now, we allow empty token for routing only.
        token = consent_token or "public_access_token"

        try:
            # Run the agent (this invokes the LLM + Tools)
            # The tools return dicts, but the LLM output is text or tool_call
            # We need to capture if a tool was called.

            # NOTE: In a real ADK runtime, .run() returns a GenerateContentResponse
            # We simulate a simplified response here for the port.

            # Since we are wrapping Google ADK, we rely on its internal tool execution.
            # However, for this ROUTER pattern, we want to know *if* delegation happened.

            # We'll use a trick: If tool returns a delegation dict, we want that to bubble up.
            # Standard ADK loop might consume it.
            # For this Phase 2, we assume the run() returns the final response object.

            response = self.run(message, user_id=user_id, consent_token=token)

            # Parse response to check for delegation
            # (In full implementation, we'd inspect the chat history or tool usage)

            # For now, let's assume the LLM text response guides us, or we inspect
            # a side-channel if we want perfect strictness.
            # But wait! Our tools return the delegation dict.
            # If the LLM uses the tool, it sees the dict.
            # We want to return that structure to the caller (API/Frontend).

            return {
                "response": response.text if hasattr(response, "text") else str(response),
                # NOT_IN_SCOPE: Delegation extraction from tool artifacts deferred.
                # Current orchestrator routes all sub-agent work inline; delegation
                # becomes relevant only when multi-turn agent handoff is implemented.
                "delegation": None,
            }

        except Exception as e:
            logger.error(f"Orchestrator error: {e}")
            return {
                "response": "I'm having trouble connecting to the network right now. Please try again.",
                "error": str(e),
            }


# Singleton
_orchestrator = None


def get_orchestrator():
    global _orchestrator
    if not _orchestrator:
        _orchestrator = OrchestratorAgent()
    return _orchestrator
