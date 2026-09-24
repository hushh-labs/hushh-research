"""One's bounded heads consume authored instructions without broadening tools."""

from types import SimpleNamespace

import pytest
from google.adk.tools.agent_tool import AgentTool
from google.adk.tools.google_search_tool import GoogleSearchTool

from hushh_mcp.one_adk import agent_tree


def test_chat_connection_guidance_is_authored_and_not_limited_to_voice():
    from hushh_mcp.one_adk.agent_tree import ONE_IDENTITY_INSTRUCTION

    assert "use discover_workspace_tools for that provider" in ONE_IDENTITY_INSTRUCTION
    assert "person must tap Connect and approve access" in ONE_IDENTITY_INSTRUCTION
    assert "not a limit on typed Chat capabilities" in ONE_IDENTITY_INSTRUCTION
    assert (
        "Never promise a capability that is not in the list below" not in ONE_IDENTITY_INSTRUCTION
    )
    assert (
        "Anything else is something a person still does by tapping" not in ONE_IDENTITY_INSTRUCTION
    )


def test_consent_routing_is_not_reauthored_by_runtime_instruction():
    authored = str(agent_tree._ONE_MANIFEST.system_instruction).strip()
    composed = agent_tree.ONE_IDENTITY_INSTRUCTION
    assert authored in composed
    overlay = composed.removeprefix(authored)
    assert "withdraw that" not in overlay
    assert "Nav answers from structured lookups" not in overlay
    assert 'ask_consent_agent with target "connections"' in authored
    assert "Do not hand consent questions to a specialist" in authored
    assert 'run_app_action("consent.cancel_request", {})' in authored


def test_one_chat_receives_authored_cross_connector_semantic_policy():
    authored = str(agent_tree._ONE_MANIFEST.system_instruction)
    composed = agent_tree._one_runtime_instruction(SimpleNamespace(state={}))
    assert "When a request spans connected services" in authored
    assert authored.strip() in composed
    assert "You may combine read results with a draft or another supported action" in composed
    assert (
        "A connection or a read grant is not permission to publish, attach, send, or change sharing"
        in composed
    )
    assert (
        "Any outward mutation needs its own reviewed details and explicit app confirmation"
        in composed
    )
    assert "never call provider mutation tools directly" in composed
    assert "Selected-file Drive and account-wide Drive reading are separate permissions" in composed
    assert "Live access needs no file selection" in composed
    assert "explicit document trust rule" in composed
    assert "share this file with Chris" in composed
    assert "One can stage a document request in chat using propose_document_request" in composed
    assert "DRIVE READ ADMISSION: disabled" in composed
    assert "Do not claim Drive is disconnected" in composed


def test_admitted_drive_instruction_uses_live_reads_and_keeps_chat_referents_local(monkeypatch):
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
    assert "call ask_documents_agent" in composed
    assert "requires no selected files or index" in composed
    assert "Resolve references only from this conversation" in composed
    assert "Never infer disconnection or missing Drive files from an empty index" in composed


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
        specialist_model="test-model", allow_workspace_tools=True
    )
    for tool in (agent_tree.discover_workspace_tools, agent_tree.read_workspace_tool):
        assert tool not in baseline
        assert tool in admitted
    assert not any(isinstance(tool, agent_tree.RegisteredMcpToolset) for tool in baseline)
    assert sum(isinstance(tool, agent_tree.RegisteredMcpToolset) for tool in admitted) == 1
    assert agent_tree._one_roster_tools(tool_mode="proposal", allow_workspace_tools=True) == [
        agent_tree.list_app_actions,
        agent_tree.propose_app_action,
    ]
    monkeypatch.setattr(agent_tree, "pod_mode", lambda: True)
    assert agent_tree.read_workspace_tool not in agent_tree._one_roster_tools(
        specialist_model="test-model", allow_workspace_tools=True
    )
