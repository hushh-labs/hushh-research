"""ExternalConnectorAgentA2A invariants without a real DB or MCP server."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

from hushh_mcp.adk_bridge.contract import A2AAuthorityContext, A2AAuthorityRequired, A2ATask
from hushh_mcp.adk_bridge.external_connector_agent import ExternalConnectorAgentA2A
from hushh_mcp.services.external_mcp_client import ExternalMcpError, ExternalMcpToolResult


@dataclass(frozen=True)
class _FakeConnector:
    connector_id: str = "notion"
    display_name: str = "Notion"
    auth_style: str = "oauth"
    mcp_endpoint: str = "https://mcp.notion.com/mcp"
    api_key_header_name: str | None = None


class _FakeRegistry:
    def __init__(self, connector: _FakeConnector | None = _FakeConnector()) -> None:
        self._connector = connector

    async def get_connector(self, connector_id: str) -> Any:
        if self._connector is None or self._connector.connector_id != connector_id:
            return None
        return self._connector


class _FakeCredentials:
    def __init__(self, credential: dict[str, Any] | None) -> None:
        self._credential = credential

    async def get_credential(self, *, user_id: str, connector_id: str) -> dict[str, Any] | None:
        return self._credential


def _authority() -> A2AAuthorityContext:
    return A2AAuthorityContext(
        subject_user_id="user_1",
        tenant_id="tenant_1",
        task_id="task_1",
        caller_kind="first_party",
        information_grant_refs=("grant_ref",),
        encrypted_export_refs=("export_ref",),
    )


def _task(*, planned_action: dict | None = None, delegate_result: dict | None = None) -> A2ATask:
    return A2ATask(
        user_id="user_1",
        consent_token="token",  # noqa: S106
        conversation_id="thread_1",
        authority=_authority(),
        planned_action=planned_action,
        delegate_result=delegate_result,
    )


@pytest.mark.asyncio
async def test_missing_authority_fails_closed() -> None:
    handler = ExternalConnectorAgentA2A(registry=_FakeRegistry(), credentials=_FakeCredentials(None))
    task = A2ATask(
        user_id="user_1",
        consent_token="token",  # noqa: S106
        conversation_id="thread_1",
    )

    with pytest.raises(A2AAuthorityRequired):
        await handler.handle(task)


@pytest.mark.asyncio
async def test_no_connector_id_asks_which_one() -> None:
    handler = ExternalConnectorAgentA2A(registry=_FakeRegistry(), credentials=_FakeCredentials(None))

    result = await handler.handle(_task())

    assert result.directive is None
    assert "which connected service" in result.text.lower()


@pytest.mark.asyncio
async def test_unknown_connector_id_is_reported_not_silently_ignored() -> None:
    handler = ExternalConnectorAgentA2A(
        registry=_FakeRegistry(connector=None), credentials=_FakeCredentials(None)
    )

    result = await handler.handle(_task(planned_action={"connectorId": "notion"}))

    assert result.directive is None
    assert "notion" in result.text.lower()
    assert "not a connector" in result.text.lower()


@pytest.mark.asyncio
async def test_unconnected_user_gets_a_connect_directive() -> None:
    handler = ExternalConnectorAgentA2A(registry=_FakeRegistry(), credentials=_FakeCredentials(None))

    result = await handler.handle(_task(planned_action={"connectorId": "notion"}))

    assert result.directive is not None
    assert result.directive.kind == "action"
    assert result.directive.payload["type"] == "connector.connect"
    assert result.directive.payload["connectorId"] == "notion"
    assert result.directive.payload["confirmLabel"] == "Connect Notion"


@pytest.mark.asyncio
async def test_connected_but_no_tool_asks_what_to_look_up() -> None:
    handler = ExternalConnectorAgentA2A(
        registry=_FakeRegistry(),
        credentials=_FakeCredentials({"accessToken": "tok"}),
    )

    result = await handler.handle(_task(planned_action={"connectorId": "notion"}))

    assert result.directive is None
    assert "connected" in result.text.lower()


@pytest.mark.asyncio
async def test_connected_tool_call_invokes_the_external_mcp_client(monkeypatch) -> None:  # noqa: ANN001
    captured: dict[str, Any] = {}

    async def fake_call_tool(name, arguments, *, endpoint, headers=None, timeout_seconds=None):
        captured["name"] = name
        captured["arguments"] = arguments
        captured["endpoint"] = endpoint
        captured["headers"] = headers
        return ExternalMcpToolResult(is_error=False, payload={"pages": []}, truncated=False)

    monkeypatch.setattr(
        "hushh_mcp.adk_bridge.external_connector_agent.call_tool", fake_call_tool
    )
    handler = ExternalConnectorAgentA2A(
        registry=_FakeRegistry(),
        credentials=_FakeCredentials({"accessToken": "tok"}),
    )

    result = await handler.handle(
        _task(
            planned_action={
                "connectorId": "notion",
                "toolName": "search",
                "arguments": {"query": "roadmap"},
            }
        )
    )

    assert captured["name"] == "search"
    assert captured["arguments"] == {"query": "roadmap"}
    assert captured["endpoint"] == "https://mcp.notion.com/mcp"
    assert captured["headers"] == {"Authorization": "Bearer tok"}
    assert result.directive is None
    assert "Notion" in result.text


@pytest.mark.asyncio
async def test_api_key_connector_uses_its_declared_header(monkeypatch) -> None:  # noqa: ANN001
    captured: dict[str, Any] = {}

    async def fake_call_tool(name, arguments, *, endpoint, headers=None, timeout_seconds=None):
        captured["headers"] = headers
        return ExternalMcpToolResult(is_error=False, payload={}, truncated=False)

    monkeypatch.setattr(
        "hushh_mcp.adk_bridge.external_connector_agent.call_tool", fake_call_tool
    )
    connector = _FakeConnector(
        connector_id="hubspot",
        display_name="HubSpot",
        auth_style="api_key",
        api_key_header_name="Private-App-Token",
    )
    handler = ExternalConnectorAgentA2A(
        registry=_FakeRegistry(connector=connector),
        credentials=_FakeCredentials({"apiKey": "secret-key"}),
    )

    await handler.handle(
        _task(planned_action={"connectorId": "hubspot", "toolName": "list_contacts"})
    )

    assert captured["headers"] == {"Private-App-Token": "secret-key"}


@pytest.mark.asyncio
async def test_external_mcp_error_is_reported_not_raised(monkeypatch) -> None:  # noqa: ANN001
    async def fake_call_tool(*args, **kwargs):
        raise ExternalMcpError("boom", code="EXTERNAL_MCP_CALL_FAILED")

    monkeypatch.setattr(
        "hushh_mcp.adk_bridge.external_connector_agent.call_tool", fake_call_tool
    )
    handler = ExternalConnectorAgentA2A(
        registry=_FakeRegistry(),
        credentials=_FakeCredentials({"accessToken": "tok"}),
    )

    result = await handler.handle(
        _task(planned_action={"connectorId": "notion", "toolName": "search"})
    )

    assert result.directive is None
    assert "didn't respond" in result.text


@pytest.mark.asyncio
async def test_cancel_delegate_result_is_acknowledged() -> None:
    handler = ExternalConnectorAgentA2A(registry=_FakeRegistry(), credentials=_FakeCredentials(None))

    result = await handler.handle(_task(delegate_result={"status": "cancelled"}))

    assert "won't connect" in result.text.lower()
