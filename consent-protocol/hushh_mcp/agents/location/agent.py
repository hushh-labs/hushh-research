"""One Location Agent ADK wrapper."""

from __future__ import annotations

import logging
import os
from typing import Any

from hushh_mcp.hushh_adk.core import HushhAgent
from hushh_mcp.hushh_adk.manifest import ManifestLoader

from .tools import CONTROL_PLANE_LOCATION_TOOLS, LOCATION_AGENT_TOOLS, V2_LOCATION_TOOLS

logger = logging.getLogger(__name__)


class LocationAgent(HushhAgent):
    """Trusted-people live-location workflow agent under One."""

    # Pydantic fields (ADK 2.x LlmAgent is a pydantic model with extra="forbid");
    # plain attribute assignment before super().__init__ raises there.
    manifest: Any = None
    hushh_tools: Any = None

    def __init__(self, tools: list[Any] | None = None) -> None:
        manifest_path = os.path.join(os.path.dirname(__file__), "agent.yaml")
        manifest = ManifestLoader.load(manifest_path)

        selected_tools = tools if tools is not None else LOCATION_AGENT_TOOLS

        super().__init__(
            name=manifest.name,
            model=manifest.model,
            system_prompt=manifest.system_instruction,
            tools=selected_tools,
            required_scopes=manifest.required_scopes,
        )
        self.manifest = manifest
        self.hushh_tools = selected_tools

    async def handle_message(
        self,
        message: str,
        user_id: str,
        consent_token: str = "",
    ) -> dict[str, Any]:
        try:
            response = await self.run_turn(
                message,
                user_id=user_id,
                consent_token=consent_token,
            )
            return {
                "response": str(response),
                "is_complete": True,
            }
        except Exception as exc:
            logger.error("LocationAgent error: %s", exc)
            return {
                "response": "I cannot complete that location workflow without the right consent and recipient encryption.",
                "error": str(exc),
            }


_location_agent: LocationAgent | None = None


def get_location_agent() -> LocationAgent:
    global _location_agent
    if _location_agent is None:
        _location_agent = LocationAgent()
    return _location_agent


_location_chat_agent: LocationAgent | None = None


def get_location_chat_agent() -> LocationAgent:
    """Singleton LocationAgent restricted to v1 control-plane tools (no crypto handoff)."""
    global _location_chat_agent
    if _location_chat_agent is None:
        _location_chat_agent = LocationAgent(tools=CONTROL_PLANE_LOCATION_TOOLS)
    return _location_chat_agent


_location_chat_agent_v2: LocationAgent | None = None


def get_location_chat_agent_v2() -> LocationAgent:
    """Singleton LocationAgent for v2 chat: control-plane + crypto-handoff prep +
    public-link tools. Excludes the raw envelope publish/view tools."""
    global _location_chat_agent_v2
    if _location_chat_agent_v2 is None:
        _location_chat_agent_v2 = LocationAgent(tools=V2_LOCATION_TOOLS)
    return _location_chat_agent_v2
