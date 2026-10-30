# hushh_mcp/agents/kai/__init__.py
"""
Kai Financial Agent 📈

Advanced multi-modal financial analyst.
MIGRATED TO ADK (v2.0.0)
"""

from typing import Any, Dict, Optional

from hushh_mcp.types import UserID

from .agent import KaiAgent, get_kai_agent

__all__ = ["handle_message", "KaiAgent", "get_kai_agent"]


def handle_message(
    message: str, user_id: UserID, session_state: Optional[Dict] = None
) -> Dict[str, Any]:
    """Compatibility wrapper for the new ADK agent."""
    agent = get_kai_agent()
    # Note: Kai requires consent for deep tools, but initial entry might be chat.
    # We pass empty token; agent might prompt or fail on tool use if critical.
    # In a real flow, Orchestrator would pass the token.
    return agent.handle_message(message, user_id, consent_token="")
