from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from mcp.types import TextContent

import mcp_modules.tools.agent_chat_tools as agent_chat_tools
import mcp_server
from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.developer_registry_service import (
    TOOL_GROUP_INTERNAL_ONLY,
    DeveloperPrincipal,
)
from mcp_modules.developer_context import (
    reset_current_developer_principal,
    set_current_developer_principal,
)


def _payload(result: list[TextContent]) -> dict:
    return json.loads(result[0].text)


@pytest.mark.asyncio
async def test_agent_chat_turn_requires_vault_owner_token() -> None:
    result = await agent_chat_tools.handle_agent_chat_turn({"user_id": "user-1", "message": "hi"})

    payload = _payload(result)
    assert payload["status"] == "access_denied"
    assert payload["error"] == "vault_owner_token_required"


@pytest.mark.asyncio
async def test_agent_chat_turn_rejects_token_user_mismatch(monkeypatch) -> None:
    async def _validate(token: str, expected_scope: ConsentScope):
        assert token == "vault-owner-token"
        assert expected_scope == ConsentScope.VAULT_OWNER
        return True, None, SimpleNamespace(user_id="other-user")

    monkeypatch.setattr(agent_chat_tools, "validate_token_with_db", _validate)

    result = await agent_chat_tools.handle_agent_chat_turn(
        {
            "user_id": "user-1",
            "vault_owner_token": "vault-owner-token",
            "message": "hi",
        }
    )

    payload = _payload(result)
    assert payload["status"] == "access_denied"
    assert payload["error"] == "vault_owner_token_user_mismatch"


@pytest.mark.asyncio
async def test_agent_chat_turn_rejects_overlong_message(monkeypatch) -> None:
    async def _validate(token: str, expected_scope: ConsentScope):
        return True, None, SimpleNamespace(user_id="user-1")

    monkeypatch.setattr(agent_chat_tools, "validate_token_with_db", _validate)

    result = await agent_chat_tools.handle_agent_chat_turn(
        {
            "user_id": "user-1",
            "vault_owner_token": "vault-owner-token",
            "message": "x" * 8001,
        }
    )

    payload = _payload(result)
    assert payload["status"] == "invalid_request"
    assert payload["error"] == "message_too_long"


@pytest.mark.asyncio
async def test_agent_chat_turn_rejects_invalid_screen_context(monkeypatch) -> None:
    async def _validate(token: str, expected_scope: ConsentScope):
        return True, None, SimpleNamespace(user_id="user-1")

    monkeypatch.setattr(agent_chat_tools, "validate_token_with_db", _validate)

    result = await agent_chat_tools.handle_agent_chat_turn(
        {
            "user_id": "user-1",
            "vault_owner_token": "vault-owner-token",
            "message": "hi",
            "screen_context": "not-an-object",
        }
    )

    payload = _payload(result)
    assert payload["status"] == "invalid_request"
    assert payload["error"] == "screen_context_invalid"


@pytest.mark.asyncio
async def test_agent_chat_turn_returns_non_streaming_response_shape(monkeypatch) -> None:
    captured = {}

    async def _validate(token: str, expected_scope: ConsentScope):
        return True, None, SimpleNamespace(user_id="user-1")

    async def _collect(body, *, consent_token: str):
        captured["body"] = body
        captured["consent_token"] = consent_token
        return SimpleNamespace(
            to_payload=lambda: {
                "status": "success",
                "conversation_id": "conv-1",
                "model": "delegated",
                "delegate_agent_id": "agent_connected_systems",
                "text": "Open Connected Systems to review this CRM update.",
                "events": [
                    {
                        "event": "specialist_directive",
                        "data": {"delegate_agent_id": "agent_connected_systems"},
                    }
                ],
                "specialist_directives": [{"delegate_agent_id": "agent_connected_systems"}],
                "tool_events": [],
                "error": None,
            }
        )

    monkeypatch.setattr(agent_chat_tools, "validate_token_with_db", _validate)
    monkeypatch.setattr(agent_chat_tools, "collect_agent_chat_turn", _collect)

    result = await agent_chat_tools.handle_agent_chat_turn(
        {
            "user_id": "user-1",
            "vault_owner_token": "vault-owner-token",
            "message": "update CRM city",
            "conversation_id": "conv-1",
            "screen_context": {"route": "/agent"},
        }
    )

    payload = _payload(result)
    assert payload["status"] == "success"
    assert payload["text"] == "Open Connected Systems to review this CRM update."
    assert payload["delegate_agent_id"] == "agent_connected_systems"
    assert payload["specialist_directives"][0]["delegate_agent_id"] == "agent_connected_systems"
    assert captured["body"].message == "update CRM city"
    assert captured["body"].conversation_id == "conv-1"
    assert captured["body"].screen_context == {"route": "/agent"}
    assert captured["consent_token"] == "vault-owner-token"


@pytest.mark.asyncio
async def test_agent_chat_turn_is_hidden_from_default_mcp_apps(monkeypatch) -> None:
    monkeypatch.delenv("HUSHH_DEVELOPER_TOKEN", raising=False)

    result = await mcp_server.call_tool(
        "agent_chat_turn",
        {"user_id": "user-1", "vault_owner_token": "vault-owner-token"},
    )

    payload = _payload(result)
    assert payload["error"] == "Tool not available for this developer app"
    assert payload["tool"] == "agent_chat_turn"
    assert "agent_chat_turn" not in payload["available_tools"]


@pytest.mark.asyncio
async def test_unknown_tool_response_does_not_leak_internal_tools(monkeypatch) -> None:
    monkeypatch.delenv("HUSHH_DEVELOPER_TOKEN", raising=False)

    result = await mcp_server.call_tool("missing_tool", {})

    payload = _payload(result)
    assert payload["error"] == "Unknown tool: missing_tool"
    assert "agent_chat_turn" not in payload["available_tools"]
    assert "delegate_to_agent" not in payload["available_tools"]
    assert "request_consent" in payload["available_tools"]


@pytest.mark.asyncio
async def test_agent_chat_turn_internal_principal_can_call_tool(monkeypatch) -> None:
    async def _handler(args: dict) -> list[TextContent]:
        return [TextContent(type="text", text=json.dumps({"status": "ok", "args": args}))]

    principal = DeveloperPrincipal(
        app_id="internal-app",
        agent_id="internal-agent",
        display_name="Internal Agent",
        allowed_tool_groups=(TOOL_GROUP_INTERNAL_ONLY,),
    )
    tokens = set_current_developer_principal(
        principal,
        token="developer-token",  # noqa: S106 - Test fixture developer token only.
    )
    monkeypatch.setitem(mcp_server.HANDLERS, "agent_chat_turn", _handler)
    try:
        result = await mcp_server.call_tool(
            "agent_chat_turn",
            {"user_id": "user-1", "vault_owner_token": "vault-owner-token"},
        )
    finally:
        reset_current_developer_principal(tokens)

    payload = _payload(result)
    assert payload["status"] == "ok"
    assert payload["args"]["user_id"] == "user-1"
