"""Each Chat run owns and closes its own authenticated MCP resources."""

import asyncio
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.one_adk import mcp_turn_scope as module
from hushh_mcp.one_adk.governed_mcp_toolset import McpConnectionBinding, ResolvedMcpConnection
from hushh_mcp.services.external_mcp_client import ExternalMcpError


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
