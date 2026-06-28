from hushh_mcp.agents.location.agent import get_location_chat_agent
from hushh_mcp.agents.location.tools import CONTROL_PLANE_LOCATION_TOOLS


def test_chat_agent_exposes_only_control_plane_tools():
    agent = get_location_chat_agent()
    assert agent.hushh_tools == CONTROL_PLANE_LOCATION_TOOLS


def test_chat_agent_is_singleton():
    assert get_location_chat_agent() is get_location_chat_agent()
