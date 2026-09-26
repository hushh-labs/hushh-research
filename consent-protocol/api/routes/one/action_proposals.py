"""Compatibility import for the canonical, private-runtime-gated proposal routes.

The former duplicate router was never mounted. Keep discovery compatibility
without a second proposal store or shared personal-agent implementation.
"""

# Main's ADK migration moved the canonical proposal endpoints into their own
# router. Keep this legacy import path as a compatibility alias so old callers
# do not fail at import time or create a second proposal store.
from api.routes.one.command_proposals import router

__all__ = ["router"]
