"""One Location Agent ADK wrapper."""

from __future__ import annotations

import logging
import os
from typing import Any

from hushh_mcp.hushh_adk.core import HushhAgent
from hushh_mcp.hushh_adk.manifest import ManifestLoader

from .tools import LOCATION_AGENT_TOOLS

logger = logging.getLogger(__name__)


class LocationAgent(HushhAgent):
    """Trusted-people live-location workflow agent under One."""

    def __init__(self) -> None:
        manifest_path = os.path.join(os.path.dirname(__file__), "agent.yaml")
        self.manifest = ManifestLoader.load(manifest_path)

        super().__init__(
            name=self.manifest.name,
            model=self.manifest.model,
            system_prompt=self.manifest.system_instruction,
            tools=LOCATION_AGENT_TOOLS,
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
