"""Compatibility import for the canonical, private-runtime-gated proposal routes.

The former duplicate router was never mounted. Keep discovery compatibility
without a second proposal store or shared personal-agent implementation.
"""

from api.routes.one.agent_chat import proposal_router as router

__all__ = ["router"]
