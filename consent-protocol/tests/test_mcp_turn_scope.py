"""Each Chat run owns and closes its own authenticated MCP resources."""

import asyncio
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.one_adk import mcp_turn_scope as module
from hushh_mcp.one_adk.governed_mcp_toolset import (
    McpConnectionBinding,
    ResolvedMcpConnection,
    mcp_tool_fingerprint,
    mcp_tool_name,
)
from hushh_mcp.services.external_mcp_client import ExternalMcpError


async def test_configuration_handoff_scrubs_input_and_is_single_use():
    forwarded = {"mcpConfigurations": [], "timezone": "UTC"}
    reference = module.admit_turn_configurations(
        forwarded, owner_id="owner", conversation_id="thread"
    )
    assert forwarded == {"timezone": "UTC"}
    state = {module.STATE_MCP_CONFIGURATION: reference}
    assert (
        module.consume_turn_configurations(state, owner_id="owner", conversation_id="thread") == []
    )
    assert state == {}
    with pytest.raises(ExternalMcpError):
        module.consume_turn_configurations(
            {module.STATE_MCP_CONFIGURATION: reference}, owner_id="owner", conversation_id="thread"
        )


@pytest.mark.parametrize("owner,thread", [("other", "thread"), ("owner", "other")])
async def test_configuration_handoff_rejects_changed_identity(owner, thread):
    reference = module.admit_turn_configurations(
        {"mcpConfigurations": []}, owner_id="owner", conversation_id="thread"
    )
    with pytest.raises(ExternalMcpError):
        module.consume_turn_configurations(
            {module.STATE_MCP_CONFIGURATION: reference}, owner_id=owner, conversation_id=thread
        )


async def test_configuration_handoff_rejects_unauthenticated_and_literal_input():
    forwarded = {"mcpConfigurations": []}
    with pytest.raises(ExternalMcpError):
        module.admit_turn_configurations(forwarded, owner_id="", conversation_id="thread")
    assert forwarded == {}
    with pytest.raises(ExternalMcpError):
        module.consume_turn_configurations(
            {module.STATE_MCP_CONFIGURATION: '{"configurations":[]}'},
            owner_id="owner",
            conversation_id="thread",
        )


async def test_abandoned_handoff_schedules_active_memory_cleanup(monkeypatch):
    from hushh_mcp.one_adk import request_secrets

    scheduled = []
    monkeypatch.setattr(
        asyncio.get_running_loop(),
        "call_later",
        lambda delay, callback, *args: scheduled.append((delay, callback, args)),
    )
    reference = module.admit_turn_configurations(
        {"mcpConfigurations": []}, owner_id="owner", conversation_id="thread"
    )
    assert reference in request_secrets._values
    delay, callback, args = scheduled[0]
    assert delay == 60
    callback(*args)
    assert reference not in request_secrets._values


@pytest.fixture
def runtime(monkeypatch):
    created = []

    async def resolve(context, connector_id):
        return ResolvedMcpConnection(
            McpConnectionBinding(context.user_id, connector_id, 1, 1, "https://example.com/mcp"),
            {"Authorization": "synthetic"},
        )

    def factory(**kwargs):
        item = SimpleNamespace(**kwargs, close=AsyncMock())
        created.append(item)
        return item

    monkeypatch.setattr(module, "resolve_registered_connection", resolve)
    monkeypatch.setattr(module, "GovernedMcpToolset", factory)
    return created


def context(owner="owner", thread="thread"):
    return SimpleNamespace(user_id=owner, state={"hussh:conversation_id": thread})


async def test_scope_reuses_only_exact_authority_and_closes_once(runtime):
    authorize = AsyncMock()
    async with module.mcp_turn_scope("thread") as scope:
        first = await scope.acquire(context(), "custom", authorize_call=authorize)
        assert await scope.acquire(context(), "custom", authorize_call=authorize) is first
        assert module.current_mcp_turn() is scope
        with pytest.raises(ExternalMcpError):
            await scope.acquire(context(), "custom", authorize_call=AsyncMock())
        with pytest.raises(ExternalMcpError):
            await scope.acquire(context(owner="other"), "custom", authorize_call=authorize)
        with pytest.raises(ExternalMcpError):
            await scope.acquire(context(thread="other"), "custom", authorize_call=authorize)
    first.close.assert_awaited_once()
    await scope.close()
    first.close.assert_awaited_once()
    with pytest.raises(ExternalMcpError):
        module.current_mcp_turn()


async def test_scope_passes_provider_policies_to_native_toolset(runtime, monkeypatch):
    def catalog_policy(catalog):
        return catalog

    def result_policy(name, payload):
        return payload

    resolved = ResolvedMcpConnection(
        McpConnectionBinding("owner", "provider", 1, 1, "https://example.com/mcp"),
        {"Authorization": "synthetic"},
        catalog_policy=catalog_policy,
        result_policy=result_policy,
    )
    monkeypatch.setattr(module, "resolve_registered_connection", AsyncMock(return_value=resolved))
    async with module.mcp_turn_scope("thread") as scope:
        native = await scope.acquire(context(), "provider", authorize_call=AsyncMock())
        assert native.catalog_policy is catalog_policy
        assert native.result_policy is result_policy


async def test_parallel_runs_never_share_authenticated_toolsets(runtime):
    barrier = asyncio.Event()
    authorize = AsyncMock()

    async def run(owner):
        async with module.mcp_turn_scope(owner) as scope:
            toolset = await scope.acquire(context(owner, owner), "custom", authorize_call=authorize)
            if len(runtime) == 2:
                barrier.set()
            await barrier.wait()
            assert module.current_mcp_turn() is scope
            return toolset

    first, second = await asyncio.gather(run("a"), run("b"))
    assert first is not second
    first.close.assert_awaited_once()
    second.close.assert_awaited_once()


async def test_provider_revision_change_gets_distinct_turn_resources(runtime, monkeypatch):
    binding = McpConnectionBinding(
        "owner",
        "provider",
        1,
        1,
        "https://example.com/mcp",
        authority_revision=("subject", "connection-1", "grant-1"),
    )
    changed = replace(binding, authority_revision=("subject", "connection-1", "grant-2"))
    monkeypatch.setattr(
        module,
        "resolve_registered_connection",
        AsyncMock(
            side_effect=[
                ResolvedMcpConnection(binding, {"Authorization": "synthetic"}),
                ResolvedMcpConnection(changed, {"Authorization": "synthetic"}),
            ]
        ),
    )
    authorize = AsyncMock()
    async with module.mcp_turn_scope("thread") as scope:
        first = await scope.acquire(context(), "provider", authorize_call=authorize)
        second = await scope.acquire(context(), "provider", authorize_call=authorize)
        assert first is not second
    first.close.assert_awaited_once()
    second.close.assert_awaited_once()


async def test_cancelled_turn_closes_resources(runtime):
    started = asyncio.Event()

    async def run():
        async with module.mcp_turn_scope("thread") as scope:
            await scope.acquire(context(), "custom", authorize_call=AsyncMock())
            started.set()
            await asyncio.Event().wait()

    task = asyncio.create_task(run())
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    runtime[0].close.assert_awaited_once()


async def test_cleanup_failure_is_sanitized_without_masking_turn_failure(runtime, caplog):
    with pytest.raises(ValueError, match="turn failure"):
        async with module.mcp_turn_scope("thread") as scope:
            toolset = await scope.acquire(context(), "custom", authorize_call=AsyncMock())
            toolset.close.side_effect = RuntimeError("synthetic-private-cleanup-error")
            raise ValueError("turn failure")
    assert "mcp_turn_cleanup_incomplete" in caplog.text
    assert "synthetic-private-cleanup-error" not in caplog.text


def configuration():
    return {
        "version": 1,
        "connectorId": "custom_" + "a" * 32,
        "revision": "00000000-0000-4000-8000-000000000001",
        "displayName": "Synthetic app",
        "endpoint": "https://example.com/mcp",
        "enabled": True,
        "authentication": {"kind": "api_key", "header": "X-API-Key", "value": "synthetic-secret"},
    }


def authorized_context(owner="owner", thread="thread"):
    value = context(owner, thread)
    value.state.update(
        {
            "hussh:user_id": owner,
            "temp:one_execution_surface": "typed_chat",
            "hussh:consent_token": "synthetic-owner-token",
        }
    )
    return value


async def test_vault_config_is_request_only_and_revalidates_owner_per_call(runtime, monkeypatch):
    validate = AsyncMock(return_value=True)
    monkeypatch.setattr(module, "validate_first_party_owner_token", validate)
    registry = AsyncMock(side_effect=AssertionError("must not read private DB registration"))
    monkeypatch.setattr(module, "resolve_registered_connection", registry)
    record = configuration()
    async with module.mcp_turn_scope("thread", owner_id="owner", configurations=[record]) as scope:
        native = await scope.acquire(
            authorized_context(), record["connectorId"], authorize_call=AsyncMock()
        )
        record["authentication"]["value"] = "changed-after-admission"
        resolved = await native.resolve_connection(authorized_context())
        assert resolved.headers == {"X-API-Key": "synthetic-secret"}
        assert "synthetic-secret" not in repr(resolved)
        assert validate.await_count == 2
        validate.return_value = False
        with pytest.raises(ExternalMcpError):
            await native.resolve_connection(authorized_context())
        with pytest.raises(ExternalMcpError):
            await native.resolve_connection(authorized_context("other"))
        with pytest.raises(ExternalMcpError):
            await native.resolve_connection(authorized_context(thread="other"))
    assert scope._configurations == {}
    with pytest.raises(ExternalMcpError):
        await native.resolve_connection(authorized_context())
    registry.assert_not_awaited()


@pytest.mark.parametrize(
    "change",
    [
        {"endpoint": "https://127.0.0.1/mcp"},
        {"endpoint": "https://example.com/mcp?secret=synthetic"},
        {"connectorId": "google_drive"},
        {"revision": "invalid"},
        {"enabled": "yes"},
        {"version": True},
        {"extra": "synthetic-private"},
        {
            "authentication": {
                "kind": "oauth",
                "accessToken": "synthetic",
                "expiresAt": 123,
                "refreshToken": "never-forward",
            }
        },
        {"authentication": {"kind": "api_key", "header": "Cookie", "value": "synthetic"}},
        {"authentication": {"kind": "api_key", "header": "Authorization", "value": None}},
        {
            "authentication": {
                "kind": "api_key",
                "header": "Authorization",
                "value": "synthetic\r\nsecret",
            }
        },
    ],
)
def test_invalid_vault_projection_fails_without_echo(change):
    with pytest.raises(ExternalMcpError) as caught:
        module.McpTurnResources(
            "thread", owner_id="owner", configurations=[{**configuration(), **change}]
        )
    assert str(caught.value) == "Connector configuration unavailable."
    assert caught.value.__suppress_context__ is True


@pytest.mark.parametrize("records", [[configuration()] * 2, [configuration()] * 33, {}])
def test_vault_catalog_bounds_and_duplicates(records):
    with pytest.raises(ExternalMcpError):
        module.McpTurnResources("thread", owner_id="owner", configurations=records)


async def test_disabled_or_omitted_vault_connector_never_falls_back_to_registry(monkeypatch):
    monkeypatch.setattr(module, "validate_first_party_owner_token", AsyncMock(return_value=True))
    registry = AsyncMock()
    monkeypatch.setattr(module, "resolve_registered_connection", registry)
    record = configuration()
    record["enabled"] = False
    for configurations in ([record], []):
        async with module.mcp_turn_scope(
            "thread", owner_id="owner", configurations=configurations
        ) as scope:
            assert scope.vault_catalog("owner") == []
            with pytest.raises(ExternalMcpError):
                await scope.resolve_connection(authorized_context(), record["connectorId"])
    registry.assert_not_awaited()


async def test_vault_oauth_expiry_is_rechecked(runtime, monkeypatch):
    monkeypatch.setattr(module, "validate_first_party_owner_token", AsyncMock(return_value=True))
    monkeypatch.setattr(module.time, "time", lambda: 100)
    record = configuration()
    record["authentication"] = {"kind": "oauth", "accessToken": "synthetic", "expiresAt": 101}
    async with module.mcp_turn_scope("thread", owner_id="owner", configurations=[record]) as scope:
        resolved = await scope.resolve_connection(authorized_context(), record["connectorId"])
        assert resolved.headers == {"Authorization": "Bearer synthetic"}
        monkeypatch.setattr(module.time, "time", lambda: 101)
        with pytest.raises(ExternalMcpError) as caught:
            await scope.resolve_connection(authorized_context(), record["connectorId"])
        assert caught.value.code == "MCP_CREDENTIAL_EXPIRED"


async def test_founder_wiki_uses_generic_vault_mcp_path(runtime, monkeypatch):
    """The Wiki needs no provider-specific dispatcher or application token."""
    monkeypatch.setattr(module, "validate_first_party_owner_token", AsyncMock(return_value=True))
    record = {
        **configuration(),
        "displayName": "Hussh Wiki",
        "endpoint": "https://mcp.hushh.ai/mcp",
        "authentication": {"kind": "oauth", "accessToken": "synthetic", "expiresAt": 4102444800},
    }
    async with module.mcp_turn_scope("thread", owner_id="owner", configurations=[record]) as scope:
        assert scope.vault_catalog("owner") == [(record["connectorId"], "Hussh Wiki")]
        resolved = await scope.resolve_connection(authorized_context(), record["connectorId"])
        assert resolved.binding.endpoint == record["endpoint"]
        assert resolved.headers == {"Authorization": "Bearer synthetic"}
        assert "synthetic" not in repr(resolved)


async def test_changed_configuration_cannot_reuse_binding_with_same_revision(runtime, monkeypatch):
    monkeypatch.setattr(module, "validate_first_party_owner_token", AsyncMock(return_value=True))
    bindings = []
    for secret in ("first", "second"):
        record = configuration()
        record["authentication"]["value"] = secret
        async with module.mcp_turn_scope(
            "thread", owner_id="owner", configurations=[record]
        ) as scope:
            bindings.append(
                (
                    await scope.resolve_connection(authorized_context(), record["connectorId"])
                ).binding
            )
    assert bindings[0] != bindings[1]


async def test_vault_blocked_tool_is_filtered_from_adk_catalog(runtime, monkeypatch):
    monkeypatch.setattr(module, "validate_first_party_owner_token", AsyncMock(return_value=True))
    record = configuration()
    blocked = {"name": "read_private", "inputSchema": {"type": "object"}}
    allowed = {"name": "search_public", "inputSchema": {"type": "object"}}
    record["blockedTools"] = [
        {
            "id": mcp_tool_name(record["connectorId"], blocked["name"]),
            "fingerprint": mcp_tool_fingerprint(blocked),
        }
    ]
    async with module.mcp_turn_scope("thread", owner_id="owner", configurations=[record]) as scope:
        resolved = await scope.resolve_connection(authorized_context(), record["connectorId"])
        assert resolved.catalog_policy([blocked, allowed]) == [allowed]
        # A changed contract has no standing block; it returns to Ask first.
        changed = {**blocked, "inputSchema": {"type": "object", "required": ["id"]}}
        assert resolved.catalog_policy([changed, allowed]) == [changed, allowed]


@pytest.mark.parametrize(
    "blocked",
    [
        "not-a-list",
        [{"id": "bad", "fingerprint": "a" * 64}],
        [{"id": "mcp_" + "a" * 40, "fingerprint": "invalid"}],
        [{"id": "mcp_" + "a" * 40, "fingerprint": "a" * 64}] * 2,
    ],
)
def test_invalid_blocked_tool_configuration_fails_closed(blocked):
    with pytest.raises(ExternalMcpError) as caught:
        module.validate_mcp_turn_configurations([{**configuration(), "blockedTools": blocked}])
    assert caught.value.code == "MCP_CONFIGURATION_INVALID"
