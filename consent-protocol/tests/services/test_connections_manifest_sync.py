from pathlib import Path
from unittest.mock import MagicMock

import pytest
import yaml

from hushh_mcp.agents.connections.agent import build_connections_agent
from hushh_mcp.services.connections_chat_service import ConnectionsChatService, _PromptTool

_MANIFEST = (
    Path(__file__).resolve().parents[2] / "hushh_mcp" / "agents" / "connections" / "agent.yaml"
)


def test_manifest_tools_match_service_dispatch():
    manifest = yaml.safe_load(_MANIFEST.read_text())
    runtime_tools = set(ConnectionsChatService(service=MagicMock())._build_tools("u").keys())
    assert "tools" not in manifest
    assert runtime_tools


def test_manifest_identity():
    manifest = yaml.safe_load(_MANIFEST.read_text())
    assert manifest["id"] == "agent_connections"
    assert "agent.one.orchestrate" in manifest["required_scopes"]


def test_runtime_instruction_and_tool_signatures_are_authored():
    svc = ConnectionsChatService(service=MagicMock())
    tools = [_PromptTool(func, svc._prompt_from_tool) for func in svc._build_tools("u").values()]
    agent = build_connections_agent(tools=tools, model="gemini-3.7-flash")
    manifest = yaml.safe_load(_MANIFEST.read_text())
    assert agent.instruction == manifest["system_instruction"]
    assert agent.mode == manifest["runtime"]["adk_mode"] == "chat"
    expected_required = {
        "list_my_connections": set(),
        "list_pending_requests": set(),
        "find_people": {"query"},
        "request_person_choice": {"name"},
        "propose_send_request": {"addressee_user_id"},
        "propose_accept_request": {"request_id"},
        "propose_reject_request": {"request_id"},
        "propose_remove_connection": {"connection_id"},
    }
    for tool in tools:
        declaration = tool._get_declaration()
        schema = declaration.parameters_json_schema
        required = schema.get("required", []) if schema else declaration.parameters.required or []
        assert set(required) == expected_required[tool.name]


def test_factory_rejects_partial_or_mutation_tool_roster():
    with pytest.raises(ValueError, match="eight read/proposal"):
        build_connections_agent(tools=[], model="gemini-3.7-flash")
