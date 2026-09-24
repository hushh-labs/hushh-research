"""The shared ADK adapter never treats discovery as execution authority."""

from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from google.adk.tools.mcp_tool.mcp_tool import McpTool
from google.adk.tools.mcp_tool.mcp_toolset import McpToolset
from mcp.types import CallToolResult

from hushh_mcp.one_adk.governed_mcp_toolset import (
    GovernedMcpToolset,
    McpConnectionBinding,
    ResolvedMcpConnection,
)
from hushh_mcp.services.external_mcp_client import ExternalMcpError

_NATIVE_RUN = McpTool._run_async_impl


@pytest.fixture
def harness(monkeypatch):
    binding = McpConnectionBinding("owner", "custom_one", 1, 1, "https://example.com/mcp")
    connection = ResolvedMcpConnection(binding, {"Authorization": "Bearer synthetic"})
    resolve = AsyncMock(return_value=connection)
    approve = AsyncMock(return_value={"status": "approval_required"})
    toolset = GovernedMcpToolset(
        binding=binding, resolve_connection=resolve, authorize_call=approve
    )
    schema = {"type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]}
    session = SimpleNamespace(
        list_tools=AsyncMock(
            return_value=SimpleNamespace(
                tools=[SimpleNamespace(name="search", inputSchema=schema)], nextCursor=None
            )
        )
    )
    toolset._mcp_session_manager = SimpleNamespace(
        create_session=AsyncMock(return_value=session),
        _begin_session_use=Mock(),
        _end_session_use=Mock(),
    )
    native_call = AsyncMock(return_value={"content": [], "structuredContent": {"count": 1}})
    monkeypatch.setattr(McpTool, "_run_async_impl", native_call)
    return SimpleNamespace(
        toolset=toolset,
        context=SimpleNamespace(user_id="owner"),
        resolve=resolve,
        approve=approve,
        native=native_call,
        connection=connection,
        session=session,
    )


async def test_native_adk_toolset_defaults_to_app_review(harness):
    h = harness
    tools = await h.toolset.get_tools(h.context)
    assert isinstance(h.toolset, McpToolset)
    assert isinstance(tools[0], McpTool)
    assert tools[0].name.startswith("mcp_")
    assert await tools[0].run_async(args={"q": "fixture"}, tool_context=h.context) == {
        "status": "approval_required"
    }
    h.native.assert_not_called()
    assert h.approve.await_args.args[1] == h.connection.binding
    assert h.approve.await_args.args[2] == "search"
    assert len(h.approve.await_args.args[3]) == 64
    assert h.approve.await_args.args[4] == {"q": "fixture"}


async def test_approved_call_uses_native_implementation_once(harness):
    h = harness
    h.approve.return_value = None
    tool = (await h.toolset.get_tools(h.context))[0]
    result = await tool.run_async(args={"q": "fixture"}, tool_context=h.context)
    assert result == {"isError": False, "result": {"count": 1}, "truncated": False}
    h.native.assert_awaited_once()
    assert h.resolve.await_count >= 5  # discovery, admission, dispatch, publication


async def test_installed_adk_invokes_wire_name_with_call_time_headers(harness, monkeypatch):
    h = harness
    h.approve.return_value = None
    h.context._invocation_context = SimpleNamespace(user_id="owner")
    h.session.call_tool = AsyncMock(
        return_value=CallToolResult(content=[], structuredContent={"count": 2})
    )
    h.toolset._mcp_session_manager._get_session_context = Mock(return_value=None)
    monkeypatch.setattr(McpTool, "_run_async_impl", _NATIVE_RUN)
    tool = (await h.toolset.get_tools(h.context))[0]
    assert tool._get_declaration().name == tool.name
    result = await tool.run_async(args={"q": "fixture"}, tool_context=h.context)
    assert result["result"] == {"count": 2}
    h.session.call_tool.assert_awaited_once()
    assert h.session.call_tool.await_args.args == ("search",)
    assert h.session.call_tool.await_args.kwargs["arguments"] == {"q": "fixture"}
    assert h.toolset._mcp_session_manager.create_session.await_args.kwargs == {
        "headers": {"Authorization": "Bearer synthetic"}
    }


async def test_invalid_arguments_never_reach_approval(harness):
    h = harness
    tool = (await h.toolset.get_tools(h.context))[0]
    assert await tool.run_async(args={}, tool_context=h.context) == {
        "error": "MCP_ARGUMENTS_INVALID"
    }
    h.approve.assert_not_called()
    h.native.assert_not_called()


@pytest.mark.parametrize("boundary", ["owner", "generation", "refresh"])
async def test_stale_tool_objects_cannot_execute(harness, boundary):
    h = harness
    tool = (await h.toolset.get_tools(h.context))[0]
    if boundary == "owner":
        h.context.user_id = "other"
    elif boundary == "generation":
        h.resolve.return_value = replace(
            h.connection, binding=replace(h.connection.binding, generation=2)
        )
    else:
        h.toolset.refresh()
    result = await tool.run_async(args={"q": "fixture"}, tool_context=h.context)
    assert result["error"] in {
        "MCP_OWNER_MISMATCH",
        "MCP_CONNECTION_CHANGED",
        "MCP_CATALOG_CHANGED",
    }
    h.approve.assert_not_called()
    h.native.assert_not_called()


async def test_changed_authority_during_review_prevents_dispatch(harness):
    h = harness
    tool = (await h.toolset.get_tools(h.context))[0]

    async def approve(*_):
        h.toolset.refresh()
        return None

    h.approve.side_effect = approve
    assert await tool.run_async(args={"q": "fixture"}, tool_context=h.context) == {
        "error": "MCP_CATALOG_CHANGED"
    }
    h.native.assert_not_called()


async def test_external_failure_is_sanitized_and_never_retried(harness, caplog):
    h = harness
    h.approve.return_value = None
    h.native.side_effect = RuntimeError("synthetic-secret-provider-error")
    tool = (await h.toolset.get_tools(h.context))[0]
    result = await tool.run_async(args={"q": "fixture"}, tool_context=h.context)
    assert result == {"error": "MCP_CALL_UNAVAILABLE", "outcome": "unknown", "retryable": False}
    h.native.assert_awaited_once()
    assert "synthetic-secret-provider-error" not in caplog.text


async def test_rediscovery_invalidates_previous_tool_schema(harness):
    h = harness
    old = (await h.toolset.get_tools(h.context))[0]
    h.session.list_tools.return_value.tools[0].inputSchema = {
        "type": "object",
        "properties": {"id": {"type": "string"}},
        "required": ["id"],
    }
    fresh = (await h.toolset.get_tools(h.context))[0]
    assert old.revision != fresh.revision
    assert await old.run_async(args={"q": "fixture"}, tool_context=h.context) == {
        "error": "MCP_CATALOG_CHANGED"
    }
    h.approve.assert_not_called()
    h.native.assert_not_called()


async def test_late_result_is_discarded_after_disconnect(harness):
    h = harness
    h.approve.return_value = None
    tool = (await h.toolset.get_tools(h.context))[0]

    async def native(**_):
        h.resolve.return_value = replace(
            h.connection, binding=replace(h.connection.binding, generation=2)
        )
        return {"content": [], "structuredContent": {"private": "must-not-publish"}}

    h.native.side_effect = native
    result = await tool.run_async(args={"q": "fixture"}, tool_context=h.context)
    assert result == {"error": "MCP_CONNECTION_CHANGED", "outcome": "unknown", "retryable": False}
    assert "must-not-publish" not in str(result)


async def test_catalog_uses_all_pages_and_rejects_cross_owner_discovery(harness):
    h = harness
    with pytest.raises(ExternalMcpError):
        await h.toolset.get_tools(SimpleNamespace(user_id="other"))
    h.session.list_tools.assert_not_called()
    first = h.session.list_tools.return_value
    first.nextCursor = "page-two"
    second = SimpleNamespace(
        tools=[SimpleNamespace(name="read", inputSchema={"type": "object"})], nextCursor=None
    )
    h.session.list_tools.side_effect = [first, second]
    tools = await h.toolset.get_tools(h.context)
    assert len(tools) == 2 and len({tool.name for tool in tools}) == 2
    assert h.session.list_tools.await_count == 2
