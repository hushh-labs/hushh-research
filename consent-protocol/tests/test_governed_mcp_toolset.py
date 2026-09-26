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


@pytest.fixture(autouse=True)
def _hosted_workspace_mcp_enrolled(monkeypatch):
    """These cases pin the hosted Workspace MCP path, which stays intact behind
    the enrollment switch (off by default: founder decision 2026-09-25)."""
    from hushh_mcp.one_adk import governed_mcp_toolset

    monkeypatch.setattr(governed_mcp_toolset, "HOSTED_WORKSPACE_MCP_ENROLLED", True)


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
    definition.transport_kind = "mcp"  # a REST row is never dialed as MCP
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
        "connectorId": "custom_one",
        "status": "approval_required",
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


async def test_catalog_policy_omits_blocked_tool_before_adk_sees_it(harness):
    h = harness
    h.toolset.catalog_policy = lambda catalog: []
    assert await h.toolset.get_tools(h.context) == []
    h.approve.assert_not_called()
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
        "connectorId": "custom_one",
        "status": "approval_required",
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
    assert result == {
        "connectorId": "custom_one",
        "review": "approved",
        "status": "ok",
        "isError": False,
        "result": {"count": 1},
        "truncated": False,
    }
    h.native.assert_awaited_once()
    assert h.resolve.await_count >= 5  # discovery, admission, dispatch, publication


async def test_native_denial_needs_no_private_arguments_or_provider_access(harness):
    h = harness
    tool = (await h.toolset.get_tools(h.context))[0]
    h.resolve.reset_mock()
    h.context.tool_confirmation = SimpleNamespace(confirmed=False)
    result = await tool.run_async(args={}, tool_context=h.context)
    assert result == {
        "connectorId": "custom_one",
        "status": "blocked",
        "error": "MCP_REVIEW_DECLINED",
        "retryable": False,
    }
    h.resolve.assert_not_awaited()
    h.approve.assert_not_awaited()
    h.native.assert_not_awaited()


async def test_rejected_app_receipt_never_dispatches_or_claims_uncertain_write(harness):
    from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError

    h = harness
    h.approve.side_effect = ActionDirectiveAuthorityError("private-ledger-diagnostic")
    tool = (await h.toolset.get_tools(h.context))[0]
    result = await tool.run_async(args={"q": "fixture"}, tool_context=h.context)
    assert result == {
        "connectorId": "custom_one",
        "status": "blocked",
        "error": "MCP_APPROVAL_INVALID",
        "retryable": False,
    }
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
        "connectorId": "custom_one",
        "error": "MCP_ARGUMENTS_INVALID",
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
        "connectorId": "custom_one",
        "error": "MCP_CATALOG_CHANGED",
    }
    h.native.assert_not_called()


async def test_external_failure_is_sanitized_and_never_retried(harness, caplog):
    h = harness
    h.approve.return_value = None
    h.native.side_effect = RuntimeError("synthetic-secret-provider-error")
    tool = (await h.toolset.get_tools(h.context))[0]
    result = await tool.run_async(args={"q": "fixture"}, tool_context=h.context)
    assert result == {
        "connectorId": "custom_one",
        "error": "MCP_CALL_UNAVAILABLE",
        "outcome": "unknown",
        "retryable": False,
    }
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
        "connectorId": "custom_one",
        "error": "MCP_CATALOG_CHANGED",
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
    assert result == {
        "connectorId": "custom_one",
        "error": "MCP_CONNECTION_CHANGED",
        "outcome": "unknown",
        "retryable": False,
    }
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


async def test_identical_overlapping_discoveries_keep_both_callers(harness):
    h = harness
    started, release = asyncio.Event(), asyncio.Event()
    catalog = h.session.list_tools.return_value
    calls = 0

    async def discover():
        nonlocal calls
        calls += 1
        if calls == 1:
            started.set()
            await release.wait()
        return catalog

    h.session.list_tools.side_effect = discover
    first = asyncio.create_task(h.toolset.get_tools(h.context))
    await started.wait()
    try:
        second = await h.toolset.get_tools(h.context)
    finally:
        release.set()
    original = await first
    assert [tool.name for tool in original] == [tool.name for tool in second]
    assert original[0].epoch == second[0].epoch == h.toolset.catalog_epoch


async def test_parallel_reviewed_calls_do_not_invalidate_same_catalog(harness):
    h = harness
    h.approve.return_value = None
    tool = (await h.toolset.get_tools(h.context))[0]
    catalog = h.session.list_tools.return_value

    async def discover():
        await asyncio.sleep(0)
        return catalog

    h.session.list_tools.side_effect = discover
    results = await asyncio.gather(
        tool.run_async(args={"q": "first"}, tool_context=h.context),
        tool.run_async(args={"q": "second"}, tool_context=h.context),
    )
    assert all(result["status"] == "ok" for result in results)
    assert h.native.await_count == 2


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
    assert result == {
        "connectorId": "custom_one",
        "error": "MCP_PROVIDER_ERROR",
        "outcome": "unknown",
        "retryable": False,
    }


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
            "connectorId": "custom_one",
            "status": "permission_required",
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


# --- Founder decision 2026-09-25: reads free, writes reviewed -----------------

READ_ONLY = {"readOnlyHint": True}


@pytest.mark.parametrize(
    ("policy", "descriptor", "reviewed"),
    [
        ("credentialless", {"name": "write"}, False),
        ("credentialless", {"name": "read", "annotations": READ_ONLY}, False),
        ("credentialed", {"name": "read", "annotations": READ_ONLY}, False),
        (
            "credentialed",
            {"annotations": {"readOnlyHint": True, "destructiveHint": False}},
            False,
        ),
        # Everything below is missing, garbled, contradictory or unknown.
        ("credentialed", {"name": "unannotated"}, True),
        ("credentialed", {"annotations": {"readOnlyHint": False}}, True),
        ("credentialed", {"annotations": {"readOnlyHint": True, "destructiveHint": True}}, True),
        ("credentialed", {"annotations": {"readOnlyHint": "true"}}, True),
        ("credentialed", {"annotations": {"readOnlyHint": 1}}, True),
        ("credentialed", {"annotations": {"readOnlyHint": None}}, True),
        ("credentialed", {"annotations": "readOnly"}, True),
        ("credentialed", {"annotations": [READ_ONLY]}, True),
        ("credentialed", None, True),
        ("always", {"annotations": READ_ONLY}, True),
        ("CREDENTIALLESS", {"annotations": READ_ONLY}, True),
        (None, {"annotations": READ_ONLY}, True),
        ("", {"annotations": READ_ONLY}, True),
    ],
)
def test_review_policy_relaxes_only_exact_known_cases(policy, descriptor, reviewed):
    from hushh_mcp.one_adk.governed_mcp_toolset import mcp_call_requires_review

    assert mcp_call_requires_review(policy, descriptor) is reviewed


@pytest.mark.parametrize(
    ("annotations", "expected"),
    [
        (None, {}),
        (SimpleNamespace(), {}),
        (SimpleNamespace(readOnlyHint=True), {"readOnlyHint": True}),
        (
            SimpleNamespace(readOnlyHint=True, destructiveHint=False, openWorldHint=True),
            {"readOnlyHint": True, "destructiveHint": False},
        ),
        (SimpleNamespace(readOnlyHint="true"), {}),
        (SimpleNamespace(readOnlyHint=1), {}),
        ("readOnly", {}),
    ],
)
def test_catalog_keeps_only_strictly_boolean_review_hints(annotations, expected):
    from hushh_mcp.services.external_mcp_client import _review_hints

    assert _review_hints(SimpleNamespace(annotations=annotations)) == expected


def test_review_hints_never_rekey_owner_block_preferences():
    from hushh_mcp.one_adk.governed_mcp_toolset import mcp_tool_fingerprint

    descriptor = {"name": "search", "description": "", "inputSchema": {"type": "object"}}
    assert mcp_tool_fingerprint(descriptor) == mcp_tool_fingerprint(
        {**descriptor, "annotations": READ_ONLY}
    )
    assert mcp_tool_fingerprint(descriptor) != mcp_tool_fingerprint(
        {**descriptor, "description": "changed"}
    )


def test_unknown_review_policy_is_rejected_at_construction():
    binding = McpConnectionBinding("owner", "custom_one", 1, 1, "https://example.com/mcp")
    with pytest.raises(ValueError, match="Invalid MCP review policy"):
        GovernedMcpToolset(
            binding=binding,
            resolve_connection=AsyncMock(),
            authorize_call=AsyncMock(),
            review_policy="reads_free",  # type: ignore[arg-type]
        )


def _policy_toolset(policy, tools, *, headers=None, forced=frozenset(), catalog_policy=None):
    binding = McpConnectionBinding("owner", "custom_one", 1, 1, "https://example.com/mcp")
    connection = ResolvedMcpConnection(
        binding,
        headers or {"Authorization": "Bearer synthetic"},
        review_policy=policy,
        forced_review_tool_ids=forced,
    )
    approve = AsyncMock(return_value={"status": "review_required"})
    toolset = GovernedMcpToolset(
        binding=binding,
        resolve_connection=AsyncMock(return_value=connection),
        authorize_call=approve,
        review_policy=policy,
        forced_review_tool_ids=forced,
        catalog_policy=catalog_policy,
    )
    session = SimpleNamespace(
        list_tools=AsyncMock(return_value=SimpleNamespace(tools=tools, nextCursor=None))
    )
    toolset._mcp_session_manager = SimpleNamespace(
        create_session=AsyncMock(return_value=session),
        _begin_session_use=Mock(),
        _end_session_use=Mock(),
    )
    return toolset, approve, session


def _tool(name, annotations=None):
    return SimpleNamespace(name=name, inputSchema={"type": "object"}, annotations=annotations)


@pytest.fixture
def native_ok(monkeypatch):
    native = AsyncMock(return_value={"content": [], "structuredContent": {"count": 1}})
    monkeypatch.setattr(McpTool, "_run_async_impl", native)
    return native


async def test_credentialed_read_only_tool_runs_without_review(native_ok):
    toolset, approve, _ = _policy_toolset(
        "credentialed", [_tool("search", SimpleNamespace(readOnlyHint=True))]
    )
    try:
        tool = (await toolset.get_tools(SimpleNamespace(user_id="owner")))[0]
        assert tool.descriptor["annotations"] == READ_ONLY
        result = await tool.run_async(args={}, tool_context=SimpleNamespace(user_id="owner"))
        assert result == {
            "status": "ok",
            "isError": False,
            "result": {"count": 1},
            "truncated": False,
            "review": "read_only",
            "connectorId": "custom_one",
        }
        approve.assert_not_awaited()
        native_ok.assert_awaited_once()
    finally:
        await toolset.close()


@pytest.mark.parametrize(
    "annotations",
    [
        None,
        SimpleNamespace(readOnlyHint=False),
        SimpleNamespace(readOnlyHint=True, destructiveHint=True),
        SimpleNamespace(readOnlyHint="yes"),
    ],
)
async def test_credentialed_non_read_tool_keeps_exact_call_review(native_ok, annotations):
    toolset, approve, _ = _policy_toolset("credentialed", [_tool("write", annotations)])
    try:
        tool = (await toolset.get_tools(SimpleNamespace(user_id="owner")))[0]
        result = await tool.run_async(args={}, tool_context=SimpleNamespace(user_id="owner"))
        assert result == {"status": "review_required", "connectorId": "custom_one"}
        approve.assert_awaited_once()
        native_ok.assert_not_awaited()
    finally:
        await toolset.close()


async def test_credentialless_connector_runs_unannotated_tool_without_review(native_ok):
    toolset, approve, _ = _policy_toolset("credentialless", [_tool("write")], headers={})
    try:
        tool = (await toolset.get_tools(SimpleNamespace(user_id="owner")))[0]
        result = await tool.run_async(args={}, tool_context=SimpleNamespace(user_id="owner"))
        # Not claimed as a read: an unannotated public tool may change things.
        assert result["status"] == "ok" and result["review"] == "no_credential"
        approve.assert_not_awaited()
        native_ok.assert_awaited_once()
    finally:
        await toolset.close()


async def test_default_policy_reviews_even_a_read_only_tool(native_ok):
    toolset, approve, _ = _policy_toolset(
        "always", [_tool("search", SimpleNamespace(readOnlyHint=True))]
    )
    try:
        tool = (await toolset.get_tools(SimpleNamespace(user_id="owner")))[0]
        await tool.run_async(args={}, tool_context=SimpleNamespace(user_id="owner"))
        approve.assert_awaited_once()
        native_ok.assert_not_awaited()
    finally:
        await toolset.close()


async def test_unreviewed_read_never_touches_the_action_directive_ledger(native_ok, monkeypatch):
    """Reads must work on a database without migration 248; writes still need it."""
    from hushh_mcp.one_adk import mcp_call_approval

    def ledger_unavailable(*_args, **_kwargs):
        raise AssertionError("ledger touched")

    monkeypatch.setattr(mcp_call_approval, "ActionDirectiveStore", ledger_unavailable)
    toolset, _, _ = _policy_toolset(
        "credentialed",
        [_tool("search", SimpleNamespace(readOnlyHint=True)), _tool("write")],
    )
    toolset.authorize_call = mcp_call_approval.review_or_resume_call
    context = SimpleNamespace(
        user_id="owner",
        state={
            "hussh:user_id": "owner",
            "hussh:conversation_id": "thread",
            "temp:one_execution_surface": "typed_chat",
        },
    )
    try:
        tools = {tool.descriptor["name"]: tool for tool in await toolset.get_tools(context)}
        read = await tools["search"].run_async(args={}, tool_context=context)
        assert read["status"] == "ok" and read["review"] == "read_only"
        # Negative control: the reviewed path does reach the ledger.
        write = await tools["write"].run_async(args={}, tool_context=context)
        assert write == {
            "error": "MCP_CALL_UNAVAILABLE",
            "outcome": "unknown",
            "retryable": False,
            "connectorId": "custom_one",
        }
        native_ok.assert_awaited_once()
    finally:
        await toolset.close()


async def test_hint_flip_after_discovery_invalidates_the_unreviewed_tool(native_ok):
    tool_descriptor = _tool("search", SimpleNamespace(readOnlyHint=True))
    toolset, approve, _ = _policy_toolset("credentialed", [tool_descriptor])
    try:
        tool = (await toolset.get_tools(SimpleNamespace(user_id="owner")))[0]
        tool_descriptor.annotations = SimpleNamespace(readOnlyHint=False)
        result = await tool.run_async(args={}, tool_context=SimpleNamespace(user_id="owner"))
        assert result["error"] == "MCP_CATALOG_CHANGED"
        approve.assert_not_awaited()
        native_ok.assert_not_awaited()
        fresh = (await toolset.get_tools(SimpleNamespace(user_id="owner")))[0]
        assert (await fresh.run_async(args={}, tool_context=SimpleNamespace(user_id="owner")))[
            "status"
        ] == "review_required"
        native_ok.assert_not_awaited()
    finally:
        await toolset.close()


async def test_review_policy_change_is_a_connection_change(native_ok):
    toolset, approve, _ = _policy_toolset(
        "credentialed", [_tool("search", SimpleNamespace(readOnlyHint=True))]
    )
    try:
        tool = (await toolset.get_tools(SimpleNamespace(user_id="owner")))[0]
        current = toolset.resolve_connection.return_value
        toolset.resolve_connection.return_value = replace(current, review_policy="credentialless")
        result = await tool.run_async(args={}, tool_context=SimpleNamespace(user_id="owner"))
        assert result["error"] == "MCP_CONNECTION_CHANGED"
        approve.assert_not_awaited()
        native_ok.assert_not_awaited()
    finally:
        await toolset.close()


async def test_provider_echo_of_the_credential_never_reaches_the_model(monkeypatch):
    bearer = "synthetic-bearer-value-0123456789"
    native = AsyncMock(
        return_value={
            "content": [],
            "structuredContent": {
                "echo": f"Authorization: Bearer {bearer}",
                bearer: [f"token={bearer}"],
                "short": "abc",
            },
        }
    )
    monkeypatch.setattr(McpTool, "_run_async_impl", native)
    toolset, _, _ = _policy_toolset(
        "credentialed",
        [_tool("search", SimpleNamespace(readOnlyHint=True))],
        headers={"Authorization": f"Bearer {bearer}"},
    )
    try:
        tool = (await toolset.get_tools(SimpleNamespace(user_id="owner")))[0]
        result = await tool.run_async(args={}, tool_context=SimpleNamespace(user_id="owner"))
        assert result["status"] == "ok"
        assert bearer not in repr(result)
        assert result["result"]["echo"] == "Authorization: [redacted]"
        assert result["result"]["[redacted]"] == ["token=[redacted]"]
        assert result["result"]["short"] == "abc"
    finally:
        await toolset.close()


@pytest.mark.parametrize(
    ("policy", "annotations"),
    [("credentialless", None), ("credentialed", SimpleNamespace(readOnlyHint=True))],
)
async def test_changed_contract_of_a_blocked_tool_always_needs_review(
    native_ok, policy, annotations
):
    """Editing a blocked tool's description must not turn the block into execution."""
    from hushh_mcp.one_adk.governed_mcp_toolset import mcp_tool_name

    toolset, approve, _ = _policy_toolset(
        policy,
        [_tool("search", annotations)],
        forced=frozenset({mcp_tool_name("custom_one", "search")}),
    )
    try:
        tool = (await toolset.get_tools(SimpleNamespace(user_id="owner")))[0]
        result = await tool.run_async(args={}, tool_context=SimpleNamespace(user_id="owner"))
        assert result == {"status": "review_required", "connectorId": "custom_one"}
        approve.assert_awaited_once()
        native_ok.assert_not_awaited()
    finally:
        await toolset.close()


async def test_forced_review_set_change_is_a_connection_change(native_ok):
    toolset, approve, _ = _policy_toolset("credentialless", [_tool("search")])
    try:
        tool = (await toolset.get_tools(SimpleNamespace(user_id="owner")))[0]
        current = toolset.resolve_connection.return_value
        toolset.resolve_connection.return_value = replace(
            current, forced_review_tool_ids=frozenset({tool.name})
        )
        result = await tool.run_async(args={}, tool_context=SimpleNamespace(user_id="owner"))
        assert result["error"] == "MCP_CONNECTION_CHANGED"
        native_ok.assert_not_awaited()
    finally:
        await toolset.close()


async def test_catalog_policy_cannot_invent_or_strip_review_hints(native_ok):
    def forge(catalog):
        return [
            {**item, "annotations": {"readOnlyHint": True}}
            if item["name"] == "write"
            else {key: value for key, value in item.items() if key != "annotations"}
            for item in catalog
        ]

    toolset, approve, _ = _policy_toolset(
        "credentialed",
        [_tool("search", SimpleNamespace(readOnlyHint=True)), _tool("write")],
        catalog_policy=forge,
    )
    try:
        tools = {
            tool.descriptor["name"]: tool
            for tool in await toolset.get_tools(SimpleNamespace(user_id="owner"))
        }
        assert tools["search"].descriptor["annotations"] == READ_ONLY
        assert "annotations" not in tools["write"].descriptor
        write = await tools["write"].run_async(
            args={}, tool_context=SimpleNamespace(user_id="owner")
        )
        assert write["status"] == "review_required"
        native_ok.assert_not_awaited()
    finally:
        await toolset.close()


async def test_credential_is_redacted_before_a_large_result_is_capped(monkeypatch):
    from hushh_mcp.services import external_mcp_client

    bearer = "synthetic-bearer-straddles-the-cap-0123456789abcdef"
    cap = external_mcp_client._MAX_RESULT_BYTES
    # Place the credential across the half-cap cut used for the preview.
    lead = "x" * (cap // 2 - len('{"text": "') - len(bearer) // 2)
    native = AsyncMock(
        return_value={
            "content": [{"type": "text", "text": lead + bearer + "y" * cap}],
        }
    )
    monkeypatch.setattr(McpTool, "_run_async_impl", native)
    toolset, _, _ = _policy_toolset(
        "credentialed",
        [_tool("search", SimpleNamespace(readOnlyHint=True))],
        headers={"Authorization": f"Bearer {bearer}"},
    )
    try:
        tool = (await toolset.get_tools(SimpleNamespace(user_id="owner")))[0]
        result = await tool.run_async(args={}, tool_context=SimpleNamespace(user_id="owner"))
        assert result["truncated"] is True
        preview = result["result"]["preview"]
        assert not any(bearer[:size] in preview for size in range(12, len(bearer) + 1))
    finally:
        await toolset.close()


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (401, "EXTERNAL_MCP_AUTH_FAILED"),
        (403, "EXTERNAL_MCP_AUTH_FAILED"),
        (500, "MCP_DISCOVERY_FAILED"),
    ],
)
async def test_discovery_distinguishes_a_refused_credential(harness, status, code):
    """Settings needs "sign in / token rejected", not "unreachable", for a 401."""
    h = harness
    failure = RuntimeError("PRIVATE provider body with Authorization: Bearer synthetic")
    failure.__cause__ = type("HttpFailure", (Exception,), {})()
    failure.__cause__.response = SimpleNamespace(status_code=status)
    h.toolset._mcp_session_manager.create_session = AsyncMock(side_effect=failure)
    with pytest.raises(ExternalMcpError) as caught:
        await h.toolset.get_tools(h.context)
    assert caught.value.code == code
    assert "PRIVATE" not in str(caught.value) and "synthetic" not in str(caught.value)
    assert caught.value.__cause__ is None
