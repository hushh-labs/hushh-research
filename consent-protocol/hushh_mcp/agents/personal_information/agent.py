"""One Personal Information Agent ADK wrapper."""

from __future__ import annotations

import logging
import os
from typing import Any

from hushh_mcp.hushh_adk.core import HushhAgent
from hushh_mcp.hushh_adk.manifest import ManifestLoader

from .tools import PERSONAL_INFORMATION_AGENT_TOOLS, PERSONAL_INFORMATION_CHAT_TOOLS

logger = logging.getLogger(__name__)


class PersonalInformationAgent(HushhAgent):
    """Marketplace data-slice chatbot under One."""

    def __init__(self, tools: list[Any] | None = None) -> None:
        manifest_path = os.path.join(os.path.dirname(__file__), "agent.yaml")
        self.manifest = ManifestLoader.load(manifest_path)

        selected_tools = tools if tools is not None else PERSONAL_INFORMATION_AGENT_TOOLS
        self.hushh_tools = selected_tools

        super().__init__(
            name=self.manifest.name,
            model=self.manifest.model,
            system_prompt=self.manifest.system_instruction,
            tools=selected_tools,
            required_scopes=self.manifest.required_scopes,
        )

    def handle_message(
        self,
        message: str,
        user_id: str,
        consent_token: str = "",
    ) -> dict[str, Any]:
        try:
            response = self.run(message, user_id=user_id, consent_token=consent_token)
            return {
                "response": response.text if hasattr(response, "text") else str(response),
                "is_complete": True,
            }
        except Exception as exc:
            logger.error("PersonalInformationAgent error: %s", exc)
            return {
                "response": "I can't answer that about your marketplace data right now.",
                "error": str(exc),
            }


_personal_information_agent: PersonalInformationAgent | None = None


def get_personal_information_agent() -> PersonalInformationAgent:
    global _personal_information_agent
    if _personal_information_agent is None:
        _personal_information_agent = PersonalInformationAgent()
    return _personal_information_agent


_personal_information_chat_agent: PersonalInformationAgent | None = None


def get_personal_information_chat_agent() -> PersonalInformationAgent:
    """Singleton marketplace chatbot agent: query tools, propose-publish, and
    server-side list/approve/deny of durable access requests."""
    global _personal_information_chat_agent
    if _personal_information_chat_agent is None:
        _personal_information_chat_agent = PersonalInformationAgent(
            tools=PERSONAL_INFORMATION_CHAT_TOOLS
        )
    return _personal_information_chat_agent
