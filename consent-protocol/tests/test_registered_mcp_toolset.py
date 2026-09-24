"""Registry admission uses ADK's native toolset without shared owner catalogs."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.one_adk import registered_mcp_toolset as module
from hushh_mcp.one_adk.mcp_call_approval import review_or_resume_call
from hushh_mcp.one_adk.mcp_turn_scope import mcp_turn_scope
from hushh_mcp.services.external_mcp_client import ExternalMcpError


def context(owner="owner"):
    return SimpleNamespace(
        user_id=owner,
        invocation_id="same-client-run-id",
        state={
            "hussh:user_id": owner,
            "hussh:conversation_id": "thread",
            "temp:one_execution_surface": "typed_chat",
        },
    )


def definition(name="custom", owner="owner"):
    return SimpleNamespace(
        connector_id=name,
        owner_user_id=owner,
        is_active=True,
        transport_kind="mcp",
        display_name="Synthetic connector",
    )


@pytest.fixture
def registry(monkeypatch):
    value = SimpleNamespace(list_active_connectors=AsyncMock(return_value=[definition()]))
    monkeypatch.setattr(module, "get_external_connector_registry_service", lambda: value)
    return value


async def test_native_view_is_owner_scoped_and_clears_sdk_retained_catalog(registry):
    view = module.RegisteredMcpToolset()
    for owner in ("owner", "other"):
        registry.list_active_connectors.return_value = [definition(owner=owner)]
        async with mcp_turn_scope("thread") as scope:
            tool = SimpleNamespace(name="mcp_" + owner, description="Find synthetic files")
            native = SimpleNamespace(get_tools=AsyncMock(return_value=[tool]))
            scope.acquire = AsyncMock(return_value=native)
            assert await view.get_tools_with_prefix(context(owner)) == [tool]
            assert tool.description.startswith('Connected app: "Synthetic connector".')
            assert scope.acquire.await_args.kwargs["authorize_call"] is review_or_resume_call
            registry.list_active_connectors.assert_awaited_with(user_id=owner)
        assert view._cached_prefixed_tools is None
        assert view._cached_invocation_id is None


@pytest.mark.parametrize("kind", ["missing", "owner", "surface", "thread"])
async def test_invalid_context_never_queries_registry(registry, kind):
    candidate = context()
    if kind == "missing":
        candidate = None
    elif kind == "owner":
        candidate.state["hussh:user_id"] = "other"
    elif kind == "surface":
        candidate.state["temp:one_execution_surface"] = "voice"
    else:
        candidate.state["hussh:conversation_id"] = "other-thread"
    async with mcp_turn_scope("thread"):
        if kind == "thread":
            with pytest.raises(ExternalMcpError):
                await module.RegisteredMcpToolset().get_tools(candidate)
        else:
            assert await module.RegisteredMcpToolset().get_tools(candidate) == []
    registry.list_active_connectors.assert_not_awaited()


async def test_curated_and_other_owner_entries_do_not_gain_private_authority(registry):
    registry.list_active_connectors.return_value = [
        definition(owner=None),
        definition(owner="other"),
    ]
    async with mcp_turn_scope("thread") as scope:
        scope.acquire = AsyncMock()
        assert await module.RegisteredMcpToolset().get_tools(context()) == []
        scope.acquire.assert_not_awaited()


async def test_disconnected_connector_does_not_hide_working_connector(registry):
    registry.list_active_connectors.return_value = [definition("revoked"), definition("working")]
    tool = SimpleNamespace(name="mcp_working", description="Read")
    async with mcp_turn_scope("thread") as scope:

        async def acquire(_context, connector_id, **_kwargs):
            if connector_id == "revoked":
                raise ExternalMcpError("Reconnect", code="MCP_CONNECTION_CHANGED")
            return SimpleNamespace(get_tools=AsyncMock(return_value=[tool]))

        scope.acquire = AsyncMock(side_effect=acquire)
        assert await module.RegisteredMcpToolset().get_tools(context()) == [tool]


async def test_connector_bound_rejects_without_partial_discovery(registry):
    registry.list_active_connectors.return_value = [definition(str(index)) for index in range(33)]
    async with mcp_turn_scope("thread") as scope:
        scope.acquire = AsyncMock()
        with pytest.raises(ExternalMcpError, match="limit"):
            await module.RegisteredMcpToolset().get_tools(context())
        scope.acquire.assert_not_awaited()


async def test_duplicate_tool_identity_is_not_silently_overwritten(registry):
    async with mcp_turn_scope("thread") as scope:
        scope.acquire = AsyncMock(
            return_value=SimpleNamespace(
                get_tools=AsyncMock(
                    return_value=[
                        SimpleNamespace(name="same", description="Read"),
                        SimpleNamespace(name="same", description="Read"),
                    ]
                )
            )
        )
        with pytest.raises(ExternalMcpError, match="catalog"):
            await module.RegisteredMcpToolset().get_tools(context())


async def test_discovery_error_does_not_expose_private_diagnostics(registry):
    registry.list_active_connectors.side_effect = RuntimeError("private SQL and provider token")
    async with mcp_turn_scope("thread"):
        with pytest.raises(ExternalMcpError) as error:
            await module.RegisteredMcpToolset().get_tools(context())
    assert str(error.value) == "Connector discovery unavailable."
    assert error.value.__suppress_context__ is True


async def test_parallel_owners_with_same_invocation_id_never_share_tools(registry):
    registry.list_active_connectors.side_effect = lambda user_id: [definition(owner=user_id)]
    view = module.RegisteredMcpToolset()

    async def run(owner):
        async with mcp_turn_scope("thread") as scope:
            scope.acquire = AsyncMock(
                return_value=SimpleNamespace(
                    get_tools=AsyncMock(
                        return_value=[SimpleNamespace(name=owner, description="Read")]
                    )
                )
            )
            await asyncio.sleep(0)
            return [tool.name for tool in await view.get_tools_with_prefix(context(owner))]

    assert await asyncio.gather(run("owner"), run("other")) == [["owner"], ["other"]]
    assert view._cached_prefixed_tools is None


async def test_discovery_siblings_are_cancelled_before_failed_turn_returns(registry):
    registry.list_active_connectors.return_value = [definition("slow"), definition("bad")]
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def acquire(_context, connector_id, **_kwargs):
        if connector_id == "bad":
            await started.wait()
            raise RuntimeError("private provider failure")
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    async with mcp_turn_scope("thread") as scope:
        scope.acquire = AsyncMock(side_effect=acquire)
        with pytest.raises(ExternalMcpError):
            await module.RegisteredMcpToolset().get_tools(context())
        assert cancelled.is_set()
