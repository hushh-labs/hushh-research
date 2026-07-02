from hushh_mcp.agents.location.agent import get_location_chat_agent
from hushh_mcp.agents.location.tools import CONTROL_PLANE_LOCATION_TOOLS


def test_chat_agent_exposes_only_control_plane_tools():
    agent = get_location_chat_agent()
    assert agent.hushh_tools == CONTROL_PLANE_LOCATION_TOOLS


def test_chat_agent_is_singleton():
    assert get_location_chat_agent() is get_location_chat_agent()


def test_v2_chat_agent_uses_v2_allowlist():
    from hushh_mcp.agents.location.agent import get_location_chat_agent_v2
    from hushh_mcp.agents.location.tools import (
        V2_LOCATION_TOOLS,
        publish_location_envelope,
        view_location_envelope,
    )

    agent = get_location_chat_agent_v2()
    assert list(agent.hushh_tools) == list(V2_LOCATION_TOOLS)
    assert publish_location_envelope not in agent.hushh_tools
    assert view_location_envelope not in agent.hushh_tools
    # singleton
    assert get_location_chat_agent_v2() is agent
