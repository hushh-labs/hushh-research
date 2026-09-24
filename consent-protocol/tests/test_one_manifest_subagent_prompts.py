"""One's bounded heads consume authored instructions without broadening tools."""

from types import SimpleNamespace

import pytest
from google.adk.tools.agent_tool import AgentTool
from google.adk.tools.google_search_tool import GoogleSearchTool

from hushh_mcp.one_adk import agent_tree


def test_one_chat_receives_authored_cross_connector_semantic_policy():
    authored = str(agent_tree._ONE_MANIFEST.system_instruction)
    composed = agent_tree._one_runtime_instruction(SimpleNamespace(state={}))
    assert "When a request spans connected services" in authored
    assert authored.strip() in composed
    assert "A connection or a read grant is not permission" in composed
    assert "connecting or selecting files in Connectors does not establish that grant" in composed
    assert "Never use the broader path to bypass" in composed
    assert "share this file with Chris" in composed
    assert "This chat has no direct Google sharing action" in composed
    assert "SELECTED-FILE DRIVE READ ADMISSION: disabled" in composed
    assert "Do not claim the owner is disconnected" in composed
    assert '"do you have my Drive access?"' in composed
    assert "The owner's selection is account-level" in composed


def test_admitted_drive_instruction_checks_generic_status_and_keeps_chat_referents_local(
    monkeypatch,
):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("GOOGLE_DRIVE_CHAT_READS", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner")
    composed = agent_tree._one_runtime_instruction(
        SimpleNamespace(
            state={
                agent_tree.STATE_EXECUTION_SURFACE: "typed_chat",
                agent_tree.STATE_USER_ID: "owner",
            }
        )
    )
    assert "file_name as an empty string" in composed
    assert "without naming files" in composed
    assert "earlier in this same conversation" in composed
    assert "previous-chat references and transcript do not carry over" in composed
    assert "Never infer disconnection or zero selected files" in composed


def test_selected_drive_status_is_available_only_in_owner_chat_roster():
    tools = agent_tree._one_roster_tools(specialist_model="test-model")
    assert agent_tree.inspect_selected_drive_files in tools
    assert agent_tree.inspect_selected_drive_files not in agent_tree._one_roster_tools(
        tool_mode="proposal"
    )


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


def test_drive_read_tools_are_only_in_admitted_chat_roster(monkeypatch):
    monkeypatch.setattr(agent_tree, "pod_mode", lambda: False)
    baseline = agent_tree._one_roster_tools(specialist_model="test-model")
    admitted = agent_tree._one_roster_tools(
        specialist_model="test-model", allow_owner_drive_tools=True
    )
    for tool in (agent_tree.discover_google_drive_tools, agent_tree.read_google_drive):
        assert tool not in baseline
        assert tool in admitted
    assert agent_tree._one_roster_tools(tool_mode="proposal", allow_owner_drive_tools=True) == [
        agent_tree.list_app_actions,
        agent_tree.propose_app_action,
    ]
    monkeypatch.setattr(agent_tree, "pod_mode", lambda: True)
    assert agent_tree.read_google_drive not in agent_tree._one_roster_tools(
        specialist_model="test-model", allow_owner_drive_tools=True
    )
