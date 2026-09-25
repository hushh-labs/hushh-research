"""The shared ADK adapter never treats discovery as execution authority."""

import asyncio
from dataclasses import replace
from datetime import UTC, datetime, timedelta
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
    native_registration_admitted,
    resolve_registered_connection,
)
from hushh_mcp.services.external_mcp_client import ExternalMcpError
from hushh_mcp.services.mcp_public_http import create_bounded_mcp_http_client

_NATIVE_RUN = McpTool._run_async_impl


@pytest.mark.parametrize("revision", [["revision"], ("",), (None,), (1,)])
def test_binding_rejects_mutable_or_malformed_authority_revision(revision):
    with pytest.raises(ValueError, match="Invalid MCP authority revision"):
        McpConnectionBinding("owner", "provider", 1, 1, "https://example.com/mcp", revision)


@pytest.mark.parametrize("index", [0, 1, 2])
async def test_provider_authority_change_rejects_call_headers(index):
    snapshot = ("subject", "connection-1", "grant-1")
    binding = McpConnectionBinding("owner", "provider", 1, 1, "https://example.com/mcp", snapshot)
    changed = list(snapshot)
    changed[index] = "changed"
    resolver = AsyncMock(
        return_value=ResolvedMcpConnection(
            replace(binding, authority_revision=tuple(changed)), {"Authorization": "synthetic"}
        )
    )
    toolset = GovernedMcpToolset(
        binding=binding, resolve_connection=resolver, authorize_call=AsyncMock()
    )
    try:
        with pytest.raises(ExternalMcpError) as error:
            await toolset._current_headers(SimpleNamespace(user_id="owner"))
        assert error.value.code == "MCP_CONNECTION_CHANGED"
        toolset.authorize_call.assert_not_called()
        assert "subject" not in repr(binding)
    finally:
        await toolset.close()


@pytest.fixture
def registry_harness(monkeypatch):
    from hushh_mcp.one_adk import governed_mcp_toolset as module

    context = SimpleNamespace(
        user_id="owner",
        state={
            "hussh:user_id": "owner",
            "temp:one_execution_surface": "typed_chat",
            "hussh:consent_token": "synthetic-reference",
        },
    )
    definition = SimpleNamespace(
        owner_user_id="owner",
        connector_id="custom_one",
        is_active=True,
        transport_kind="mcp",
        mcp_endpoint="https://example.com/mcp",
        auth_style="api_key",
        api_key_header_name="Authorization",
    )
    registry = SimpleNamespace(get_connector=AsyncMock(return_value=definition))
    row = dict(
        status="connected",
        credential_ciphertext="synthetic-ciphertext",
        connection_generation=3,
        credential_version=4,
        credential_expires_at=None,
    )
    lifecycle = SimpleNamespace(read=AsyncMock(return_value=row))
    credentials = SimpleNamespace(open_credential=Mock(return_value={"apiKey": "synthetic-key"}))
    authenticate = AsyncMock(return_value=True)
    monkeypatch.setattr(module, "validate_first_party_owner_token", authenticate)
    monkeypatch.setattr(module, "resolve_request_secret", lambda _: "synthetic-owner-token")
    monkeypatch.setattr(module, "get_external_connector_registry_service", lambda: registry)
    monkeypatch.setattr(module, "ExternalConnectorLifecycleStore", lambda: lifecycle)
    monkeypatch.setattr(module, "get_external_connector_credentials_service", lambda: credentials)
    return SimpleNamespace(
        context=context,
        registry=registry,
        row=row,
        lifecycle=lifecycle,
        credentials=credentials,
        authenticate=authenticate,
    )


async def test_registered_resolver_uses_authenticated_owner_and_same_credential_snapshot(
    registry_harness,
):
    h = registry_harness
    result = await resolve_registered_connection(h.context, "custom_one")
    h.authenticate.assert_awaited_once_with("owner", "synthetic-owner-token")
    h.registry.get_connector.assert_awaited_once_with("custom_one", user_id="owner")
    h.lifecycle.read.assert_awaited_once_with(user_id="owner", connector_id="custom_one")
    h.credentials.open_credential.assert_called_once_with(
        user_id="owner", connector_id="custom_one", row=h.row
    )
    assert result.binding.generation == 3 and result.binding.credential_version == 4
    assert result.headers == {"Authorization": "synthetic-key"}
    assert "synthetic-key" not in repr(result)


async def test_curated_drive_resolver_uses_live_adapter_not_generic_credential(
    registry_harness, monkeypatch
):
    from hushh_mcp.one_adk import workspace_mcp_tools

    h = registry_harness
    definition = h.registry.get_connector.return_value
    definition.owner_user_id = None
    definition.connector_id = "google_drive"
    definition.transport_kind = "google_drive_rest"
    resolved = ResolvedMcpConnection(
        McpConnectionBinding(
            "owner", "google_drive", 3, 4, "https://drivemcp.googleapis.com/mcp/v1"
        ),
        {"Authorization": "Bearer synthetic"},
    )
    adapter = AsyncMock(return_value=resolved)
    monkeypatch.setattr(workspace_mcp_tools, "resolve_native_drive_connection", adapter)
    assert await resolve_registered_connection(h.context, "google_drive") is resolved
    adapter.assert_awaited_once_with(h.context)
    h.credentials.open_credential.assert_not_called()
    h.lifecycle.read.assert_not_called()


@pytest.mark.parametrize(
    "connector_id,provider",
    [("google_gmail", "gmail"), ("google_calendar", "calendar")],
)
async def test_curated_workspace_resolves_through_existing_grant_owner(
    registry_harness, monkeypatch, connector_id, provider
):
    from hushh_mcp.one_adk import workspace_mcp_tools

    h = registry_harness
    definition = h.registry.get_connector.return_value
    definition.owner_user_id = None
    definition.connector_id = connector_id
    definition.auth_style = "oauth"
    definition.mcp_endpoint = (
        "https://gmailmcp.googleapis.com/mcp/v1"
        if provider == "gmail"
        else "https://calendarmcp.googleapis.com/mcp/v1"
    )
    resolved = ResolvedMcpConnection(
        McpConnectionBinding("owner", connector_id, 1, 1, definition.mcp_endpoint),
        {"Authorization": "Bearer synthetic"},
    )
    adapter = AsyncMock(return_value=resolved)
    monkeypatch.setattr(workspace_mcp_tools, "resolve_native_workspace_connection", adapter)
    assert native_registration_admitted(definition, "owner")
    assert await resolve_registered_connection(h.context, connector_id) is resolved
    adapter.assert_awaited_once_with(h.context, provider)
    h.credentials.open_credential.assert_not_called()
    h.lifecycle.read.assert_not_called()


def test_curated_workspace_requires_exact_mcp_transport(registry_harness):
    definition = registry_harness.registry.get_connector.return_value
    definition.owner_user_id = None
    definition.connector_id = "google_gmail"
    definition.transport_kind = "google_drive_rest"
    assert not native_registration_admitted(definition, "owner")


@pytest.mark.parametrize("failure", ["endpoint", "auth_style"])
async def test_curated_workspace_rejects_registry_policy_drift(
    registry_harness, monkeypatch, failure
):
    from hushh_mcp.one_adk import workspace_mcp_tools

    h = registry_harness
    definition = h.registry.get_connector.return_value
    definition.owner_user_id = None
    definition.connector_id = "google_calendar"
    definition.mcp_endpoint = "https://calendarmcp.googleapis.com/mcp/v1"
    definition.auth_style = "oauth"
    resolved = ResolvedMcpConnection(
        McpConnectionBinding(
            "owner", "google_calendar", 1, 1, "https://calendarmcp.googleapis.com/mcp/v1"
        ),
        {"Authorization": "Bearer synthetic"},
    )
    adapter = AsyncMock(return_value=resolved)
    monkeypatch.setattr(workspace_mcp_tools, "resolve_native_workspace_connection", adapter)
    if failure == "endpoint":
        definition.mcp_endpoint = "https://example.com/mcp"
    else:
        definition.auth_style = "api_key"
    with pytest.raises(ExternalMcpError) as error:
        await resolve_registered_connection(h.context, "google_calendar")
    assert error.value.code == "MCP_CONNECTION_CHANGED"
    h.credentials.open_credential.assert_not_called()


@pytest.mark.parametrize("failure", ["owner", "token", "hidden", "revoked", "expired"])
async def test_registered_resolver_rejects_invalid_authority_before_decryption(
    registry_harness, failure
):
    h = registry_harness
    if failure == "owner":
        h.context.user_id = "another"
    elif failure == "token":
        h.authenticate.return_value = False
    elif failure == "hidden":
        h.registry.get_connector.return_value = None
    elif failure == "revoked":
        h.row["status"] = "revoked"
    else:
        h.row["credential_expires_at"] = datetime.now(UTC) - timedelta(seconds=1)
    with pytest.raises(ExternalMcpError):
        await resolve_registered_connection(h.context, "custom_one")
    h.credentials.open_credential.assert_not_called()


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


async def test_native_adk_toolset_uses_bounded_transport():
    binding = McpConnectionBinding("owner", "provider", 1, 1, "https://example.com/mcp")
    toolset = GovernedMcpToolset(
        binding=binding,
        resolve_connection=AsyncMock(
            return_value=ResolvedMcpConnection(binding, {"Authorization": "synthetic"})
        ),
        authorize_call=AsyncMock(),
    )
    try:
        assert (
            toolset._mcp_session_manager._connection_params.httpx_client_factory
            is create_bounded_mcp_http_client
        )
    finally:
        await toolset.close()


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


async def test_catalog_policy_cannot_invent_provider_tool(harness):
    h = harness
    h.toolset.catalog_policy = lambda catalog: [{**catalog[0], "name": "invented"}]
    with pytest.raises(ExternalMcpError, match="Invalid connector policy"):
        await h.toolset.get_tools(h.context)
    h.native.assert_not_called()


async def test_catalog_policy_cannot_erase_provider_schema_constraints(harness):
    h = harness
    h.toolset.catalog_policy = lambda catalog: [{**catalog[0], "inputSchema": {"type": "object"}}]
    tool = (await h.toolset.get_tools(h.context))[0]
    assert (await tool.run_async(args={}, tool_context=h.context))[
        "error"
    ] == "MCP_ARGUMENTS_INVALID"
    h.approve.assert_not_called()
    h.native.assert_not_called()


async def test_provider_result_policy_uses_native_call_without_second_dispatch(harness):
    h = harness
    h.approve.return_value = None
    h.native.return_value = {
        "content": [],
        "structuredContent": {"count": 1, "excluded": "synthetic"},
    }
    h.toolset.result_policy = lambda name, payload: {"count": payload["count"]}
    tool = (await h.toolset.get_tools(h.context))[0]
    result = await tool.run_async(args={"q": "fixture"}, tool_context=h.context)
    assert result["result"] == {"count": 1}
    h.native.assert_awaited_once()


async def test_policy_narrowing_keeps_local_provider_refs_and_revision_binding(harness):
    h = harness
    descriptor = h.session.list_tools.return_value.tools[0]
    descriptor.inputSchema = {
        "type": "object",
        "$defs": {"query": {"type": "string", "minLength": 2}},
        "properties": {"q": {"$ref": "#/$defs/query"}},
        "required": ["q"],
    }
    h.toolset.catalog_policy = lambda catalog: [
        {
            **catalog[0],
            "inputSchema": {
                "type": "object",
                "properties": {"q": {"type": "string", "enum": ["a", "allowed"]}},
                "required": ["q"],
            },
        }
    ]
    tool = (await h.toolset.get_tools(h.context))[0]
    assert (await tool.run_async(args={"q": "a"}, tool_context=h.context))[
        "error"
    ] == "MCP_ARGUMENTS_INVALID"
    assert (await tool.run_async(args={"q": "other"}, tool_context=h.context))[
        "error"
    ] == "MCP_ARGUMENTS_INVALID"
    assert await tool.run_async(args={"q": "allowed"}, tool_context=h.context) == {
        "status": "approval_required"
    }
    descriptor.inputSchema["$defs"]["query"]["minLength"] = 3
    assert (await tool.run_async(args={"q": "allowed"}, tool_context=h.context))[
        "error"
    ] == "MCP_CATALOG_CHANGED"
    h.native.assert_not_called()


async def test_approved_call_uses_native_implementation_once(harness):
    h = harness
    h.approve.return_value = None
    tool = (await h.toolset.get_tools(h.context))[0]
    result = await tool.run_async(args={"q": "fixture"}, tool_context=h.context)
    assert result == {"status": "ok", "isError": False, "result": {"count": 1}, "truncated": False}
    h.native.assert_awaited_once()
    assert h.resolve.await_count >= 5  # discovery, admission, dispatch, publication


async def test_native_denial_needs_no_private_arguments_or_provider_access(harness):
    h = harness
    tool = (await h.toolset.get_tools(h.context))[0]
    h.resolve.reset_mock()
    h.context.tool_confirmation = SimpleNamespace(confirmed=False)
    result = await tool.run_async(args={}, tool_context=h.context)
    assert result == {"status": "blocked", "error": "MCP_REVIEW_DECLINED", "retryable": False}
    h.resolve.assert_not_awaited()
    h.approve.assert_not_awaited()
    h.native.assert_not_awaited()


async def test_rejected_app_receipt_never_dispatches_or_claims_uncertain_write(harness):
    from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError

    h = harness
    h.approve.side_effect = ActionDirectiveAuthorityError("private-ledger-diagnostic")
    tool = (await h.toolset.get_tools(h.context))[0]
    result = await tool.run_async(args={"q": "fixture"}, tool_context=h.context)
    assert result == {"status": "blocked", "error": "MCP_APPROVAL_INVALID", "retryable": False}
    h.native.assert_not_called()


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


async def test_older_overlapping_discovery_cannot_replace_fresh_catalog(harness):
    h = harness
    started, release = asyncio.Event(), asyncio.Event()
    old_page = h.session.list_tools.return_value

    async def discover():
        if not started.is_set():
            started.set()
            await release.wait()
            return old_page
        return SimpleNamespace(tools=[], nextCursor=None)

    h.session.list_tools.side_effect = discover
    old = asyncio.create_task(h.toolset.get_tools(h.context))
    await started.wait()
    try:
        assert await h.toolset.get_tools(h.context) == []
        fresh_digest = h.toolset._catalog_digest
    finally:
        release.set()
    with pytest.raises(ExternalMcpError) as error:
        await old
    assert error.value.code == "MCP_CATALOG_CHANGED"
    assert h.toolset._catalog_digest == fresh_digest


async def test_provider_error_payload_is_not_published(harness):
    h = harness
    h.approve.return_value = None
    h.native.return_value = {
        "isError": True,
        "content": [],
        "structuredContent": {"token": "synthetic-secret"},
    }
    tool = (await h.toolset.get_tools(h.context))[0]
    result = await tool.run_async(args={"q": "fixture"}, tool_context=h.context)
    assert result == {"error": "MCP_PROVIDER_ERROR", "outcome": "unknown", "retryable": False}


async def test_native_session_failure_does_not_log_or_retry(harness, monkeypatch, caplog):
    h = harness
    h.approve.return_value = None
    h.context._invocation_context = SimpleNamespace(user_id="owner")
    monkeypatch.setattr(McpTool, "_run_async_impl", _NATIVE_RUN)
    tool = (await h.toolset.get_tools(h.context))[0]
    h.toolset._mcp_session_manager.create_session.reset_mock()
    h.toolset._mcp_session_manager.create_session.side_effect = [
        h.session,
        h.session,
        ConnectionError("synthetic-private-session-error"),
    ]
    result = await tool.run_async(args={"q": "fixture"}, tool_context=h.context)
    assert result["outcome"] == "unknown" and result["retryable"] is False
    assert h.toolset._mcp_session_manager.create_session.await_count == 3
    assert "synthetic-private-session-error" not in caplog.text


async def test_reserved_tool_does_not_hide_other_tools(harness):
    from google.adk.tools.mcp_tool.mcp_tool import _RESERVED_TOOL_NAMES

    h = harness
    h.session.list_tools.return_value.tools.append(
        SimpleNamespace(name=next(iter(_RESERVED_TOOL_NAMES)), inputSchema={"type": "object"})
    )
    tools = await h.toolset.get_tools(h.context)
    assert len(tools) == 1 and tools[0].descriptor["name"] == "search"


async def test_real_sdk_protocol_paginates_reviews_invokes_and_rejects_changed_tools(
    harness, monkeypatch
):
    """Real MCP messages and native ADK invocation, with in-memory transport only.

    This is not HTTPS/OAuth proof: the session acquisition seam supplies the
    SDK's connected client/server session instead of an external connection.
    """
    from mcp.server import Server
    from mcp.shared.memory import create_connected_server_and_client_session
    from mcp.types import ListToolsRequest, ListToolsResult, Tool

    h = harness
    server = Server("synthetic-connector")
    calls = []
    cursors = []
    changed = False

    @server.list_tools()
    async def list_tools(request: ListToolsRequest):
        cursor = request.params.cursor if request.params else None
        cursors.append(cursor)
        if cursor == "page-2":
            return ListToolsResult(tools=[Tool(name="other", inputSchema={"type": "object"})])
        return ListToolsResult(
            tools=[
                Tool(
                    name="search",
                    inputSchema={
                        "type": "object",
                        "properties": {"q": {"type": "string"}},
                        "required": ["q"],
                        "additionalProperties": False,
                    },
                    description="Changed" if changed else "Synthetic search",
                )
            ],
            nextCursor="page-2",
        )

    @server.call_tool()
    async def call_tool(name, arguments):
        calls.append((name, arguments))
        return CallToolResult(content=[], structuredContent={"count": 1})

    async with create_connected_server_and_client_session(server) as session:
        h.toolset._mcp_session_manager.create_session = AsyncMock(return_value=session)
        h.toolset._mcp_session_manager._get_session_context = Mock(return_value=None)
        h.context._invocation_context = SimpleNamespace(user_id="owner")
        monkeypatch.setattr(McpTool, "_run_async_impl", _NATIVE_RUN)
        tools = await h.toolset.get_tools(h.context)
        assert len(tools) == 2 and cursors == [None, "page-2"]
        selected = next(tool for tool in tools if tool.descriptor["name"] == "search")
        assert calls == []
        h.approve.return_value = {"status": "permission_required"}
        assert await selected.run_async(args={"q": "synthetic"}, tool_context=h.context) == {
            "status": "permission_required"
        }
        assert calls == []
        h.approve.return_value = None
        result = await selected.run_async(args={"q": "synthetic"}, tool_context=h.context)
        assert result["status"] == "ok" and result["result"] == {"count": 1}
        assert calls == [("search", {"q": "synthetic"})]
        changed = True
        stale = await selected.run_async(args={"q": "synthetic"}, tool_context=h.context)
        assert stale["error"] == "MCP_CATALOG_CHANGED"
        assert len(calls) == 1


async def test_http_body_diagnostics_block_before_credentials(harness, monkeypatch):
    h = harness
    monkeypatch.setattr(
        "hushh_mcp.one_adk.governed_mcp_toolset._should_report_mcp_http_exchanges", lambda: True
    )
    with pytest.raises(ExternalMcpError) as error:
        await h.toolset.get_tools(h.context)
    assert error.value.code == "MCP_UNSAFE_TELEMETRY"
    h.resolve.assert_not_called()
    h.session.list_tools.assert_not_called()
