from hushh_mcp.agents.location.agent import get_location_chat_agent_v2
from hushh_mcp.agents.location.tools import V2_LOCATION_TOOLS


def test_chat_agent_uses_the_location_tool_allowlist():
    agent = get_location_chat_agent_v2()
    assert list(agent.hushh_tools) == list(V2_LOCATION_TOOLS)


def test_chat_agent_is_singleton():
    assert get_location_chat_agent_v2() is get_location_chat_agent_v2()
