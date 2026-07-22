# hushh_mcp/agents/orchestrator/__init__.py

"""Compatibility import path for the retired legacy One orchestrator.

Semantic One routing is implemented only by ``hushh_mcp.one_adk``.  This path
is a bounded invocation-preview containment wrapper and never a router.
"""

from typing import Any, Dict

from hushh_mcp.types import UserID

from .agent import OrchestratorAgent, get_orchestrator

# Re-export for compatibility
__all__ = ["handle_user_message", "OrchestratorAgent"]


# ============================================================================
# COMPATIBILITY WRAPPERS
# ============================================================================


def handle_user_message(message: str, user_id: UserID = "user_anonymous") -> Dict[str, Any]:
    """
    Compatibility entry point. It deliberately returns the preview boundary
    unless the caller uses the canonical authenticated One transport.
    """
    agent = get_orchestrator()
    return agent.handle_message(message, user_id=user_id)
