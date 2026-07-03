"""adk_bridge package.

Importing this package registers the in-process A2A specialists so the central
chat's dispatch seam can reach them.
"""

from hushh_mcp.adk_bridge.dispatch import register_specialist
from hushh_mcp.adk_bridge.location_agent import get_location_a2a
from hushh_mcp.adk_bridge.nav_agent import get_nav_a2a


def _register_builtin_specialists() -> None:
    register_specialist("agent_location", lambda task: get_location_a2a().handle(task))
    register_specialist("agent_nav", lambda task: get_nav_a2a().handle(task))


_register_builtin_specialists()
