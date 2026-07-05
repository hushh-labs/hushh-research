"""adk_bridge package.

Importing this package registers the in-process A2A specialists so the central
chat's dispatch seam can reach them.
"""

from hushh_mcp.adk_bridge.connected_systems_agent import get_connected_systems_a2a
from hushh_mcp.adk_bridge.dispatch import register_specialist
from hushh_mcp.adk_bridge.email_agent import get_email_a2a
from hushh_mcp.adk_bridge.location_agent import get_location_a2a
from hushh_mcp.adk_bridge.nav_agent import get_nav_a2a
from hushh_mcp.adk_bridge.personal_information_agent import get_personal_information_a2a


def _register_builtin_specialists() -> None:
    register_specialist(
        "agent_connected_systems", lambda task: get_connected_systems_a2a().handle(task)
    )
    register_specialist("agent_email", lambda task: get_email_a2a().handle(task))
    register_specialist("agent_location", lambda task: get_location_a2a().handle(task))
    register_specialist("agent_nav", lambda task: get_nav_a2a().handle(task))
    register_specialist(
        "agent_personal_information",
        lambda task: get_personal_information_a2a().handle(task),
    )


_register_builtin_specialists()
