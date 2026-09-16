"""One's bounded heads consume authored instructions without broadening tools."""

import pytest
from google.adk.tools.agent_tool import AgentTool
from google.adk.tools.google_search_tool import GoogleSearchTool

from hushh_mcp.one_adk import agent_tree


@pytest.mark.parametrize("child_id", ["one_intro", "google_search"])
def test_manifest_edits_reach_bounded_heads(monkeypatch, child_id):
    manifest = agent_tree._ONE_MANIFEST.model_copy(deep=True)
    child = next(child for child in manifest.subagents if child.id == child_id)
    child.system_instruction = "An updated authored instruction."
    child.description = "An updated authored description."
    monkeypatch.setattr(agent_tree, "_ONE_MANIFEST", manifest)

    if child_id == "one_intro":
        agent = agent_tree.build_one_intro_text_agent(model="test-model")
        assert agent.tools == [
            agent_tree.run_intro_navigation_action,
            agent_tree.list_intro_navigation_actions,
        ]
    else:
        tools = agent_tree._one_roster_tools(specialist_model="test-model")
        search = next(
            tool
            for tool in tools
            if isinstance(tool, AgentTool) and tool.agent.name == "google_search"
        )
        agent = search.agent
        assert search.propagate_grounding_metadata is True
        assert len(agent.tools) == 1
        assert isinstance(agent.tools[0], GoogleSearchTool)

    assert agent.name == child.name
    assert agent.model == "test-model"
    assert agent.instruction == child.system_instruction
    assert agent.description == child.description
    assert agent.sub_agents == []


def test_proposal_head_does_not_gain_search_or_intro_tools():
    assert agent_tree._one_roster_tools(tool_mode="proposal") == [
        agent_tree.list_app_actions,
        agent_tree.propose_app_action,
    ]
