"""Registry admission uses ADK's native toolset without shared owner catalogs."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from google.adk.tools.mcp_tool.mcp_tool import McpTool

from hushh_mcp.one_adk import mcp_turn_scope as turn_module
from hushh_mcp.one_adk import registered_mcp_toolset as module
from hushh_mcp.one_adk.mcp_call_approval import review_or_resume_call
from hushh_mcp.one_adk.mcp_turn_scope import mcp_turn_scope
from hushh_mcp.services.external_mcp_client import ExternalMcpError


@pytest.fixture(autouse=True)
def _hosted_workspace_mcp_enrolled(monkeypatch):
    """These cases pin the hosted Workspace MCP path, which stays intact behind
    the enrollment switch (off by default: founder decision 2026-09-25)."""
    from hushh_mcp.one_adk import governed_mcp_toolset

    monkeypatch.setattr(governed_mcp_toolset, "HOSTED_WORKSPACE_MCP_ENROLLED", True)


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
            discovered = await view.get_tools_with_prefix(context(owner))
            assert [item.name for item in discovered] == [tool.name]
            assert discovered[0].description.startswith('Connected app: "Synthetic connector".')
            assert tool.description == "Find synthetic files"
            assert scope.acquire.await_args.kwargs["authorize_call"] is review_or_resume_call
            registry.list_active_connectors.assert_awaited_with(user_id=owner)
        assert view._cached_prefixed_tools is None
        assert view._cached_invocation_id is None


async def test_discovery_does_not_mutate_or_repeat_labels_on_sdk_tools(registry):
    view = module.RegisteredMcpToolset()
    shared_tool = SimpleNamespace(name="mcp_shared", description="Find files")
    native = SimpleNamespace(get_tools=AsyncMock(return_value=[shared_tool]))

    for owner in ("owner", "other"):
        candidate = definition(owner=owner)
        candidate.display_name = f"{owner} app"
        registry.list_active_connectors.return_value = [candidate]
        async with mcp_turn_scope("thread") as scope:
            scope.acquire = AsyncMock(return_value=native)
            first = await view.get_tools(context(owner))
            second = await view.get_tools(context(owner))
            assert first[0] is not shared_tool
            assert second[0] is not shared_tool
            assert first[0].description == second[0].description
            assert first[0].description == f'Connected app: "{owner} app". Find files'

    assert shared_tool.description == "Find files"


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


async def test_curated_drive_uses_same_native_discovery_and_approval(registry):
    drive = definition("google_drive", owner=None)
    drive.transport_kind = "mcp"  # a REST row is never dialed as MCP
    registry.list_active_connectors.return_value = [drive]
    async with mcp_turn_scope("thread") as scope:
        tool = SimpleNamespace(name="mcp_drive", description="Read Drive")
        scope.acquire = AsyncMock(
            return_value=SimpleNamespace(get_tools=AsyncMock(return_value=[tool]))
        )
        discovered = await module.RegisteredMcpToolset().get_tools(context())
        assert [item.name for item in discovered] == [tool.name]
        assert discovered[0].description.endswith("Read Drive")
        assert scope.acquire.await_count == 1
        assert scope.acquire.await_args.args[1] == "google_drive"
        assert scope.acquire.await_args.kwargs["authorize_call"] is review_or_resume_call


@pytest.mark.parametrize("connector_id", ["google_gmail", "google_calendar"])
async def test_curated_workspace_uses_same_native_discovery_and_approval(registry, connector_id):
    registration = definition(connector_id, owner=None)
    registry.list_active_connectors.return_value = [registration]
    async with mcp_turn_scope("thread") as scope:
        tool = SimpleNamespace(name=f"mcp_{connector_id}", description="Read")
        scope.acquire = AsyncMock(
            return_value=SimpleNamespace(get_tools=AsyncMock(return_value=[tool]))
        )
        discovered = await module.RegisteredMcpToolset().get_tools(context())
        assert [item.name for item in discovered] == [tool.name]
        assert scope.acquire.await_args.args[1] == connector_id
        assert scope.acquire.await_args.kwargs["authorize_call"] is review_or_resume_call


async def test_one_connector_discovery_failure_does_not_abort_other_connectors(registry):
    registry.list_active_connectors.return_value = [
        definition("broken"),
        definition("healthy"),
    ]
    async with mcp_turn_scope("thread") as scope:
        tool = SimpleNamespace(name="mcp_healthy", description="Read")

        async def acquire(_context, connector_id, **_kwargs):
            if connector_id == "broken":
                raise RuntimeError("private provider diagnostic")
            return SimpleNamespace(get_tools=AsyncMock(return_value=[tool]))

        scope.acquire = AsyncMock(side_effect=acquire)
        discovered = await module.RegisteredMcpToolset().get_tools(context())
        names = [item.name for item in discovered]
        # The broken app is not hidden: a stand-in says so, and the healthy one works.
        assert names[0].startswith("connector_unavailable_")
        assert names[1:] == ["mcp_healthy"]
        assert "private provider diagnostic" not in repr(discovered)


async def test_vault_catalog_replaces_private_db_definitions(registry):
    registry.list_active_connectors.return_value = [definition("legacy_private")]
    record = {
        "version": 1,
        "connectorId": "custom_" + "a" * 32,
        "revision": "00000000-0000-4000-8000-000000000001",
        "displayName": "Vault app",
        "endpoint": "https://example.com/mcp",
        "enabled": True,
        "authentication": {"kind": "none"},
    }
    async with mcp_turn_scope("thread", owner_id="owner", configurations=[record]) as scope:
        tool = SimpleNamespace(name="mcp_vault", description="Read")
        scope.acquire = AsyncMock(
            return_value=SimpleNamespace(get_tools=AsyncMock(return_value=[tool]))
        )
        discovered = await module.RegisteredMcpToolset().get_tools(context())
        assert [item.name for item in discovered] == [tool.name]
        assert discovered[0].description.startswith('Connected app: "Vault app".')
        registry.list_active_connectors.assert_awaited_with(user_id=None)
        assert scope.acquire.await_args.args[1] == record["connectorId"]
        assert scope.acquire.await_count == 1
    async with mcp_turn_scope("thread", owner_id="owner", configurations=[]) as scope:
        scope.acquire = AsyncMock()
        assert await module.RegisteredMcpToolset().get_tools(context()) == []
        scope.acquire.assert_not_awaited()


async def test_private_connector_setup_is_owner_bound_and_exposes_only_safe_metadata(monkeypatch):
    record = {
        "version": 1,
        "connectorId": "custom_" + "a" * 32,
        "revision": "00000000-0000-4000-8000-000000000001",
        "displayName": "Synthetic app",
        "endpoint": "https://private.example/mcp",
        "enabled": True,
        "authentication": {
            "kind": "oauth",
            "accessToken": "synthetic-private-token",
            "expiresAt": 1,
        },
    }
    authority = AsyncMock(return_value=True)
    monkeypatch.setattr(module, "validate_first_party_owner_token", authority)
    candidate = context()
    candidate.state["hussh:consent_token"] = "synthetic-owner-token"
    async with mcp_turn_scope("thread", owner_id="owner", configurations=[record]):
        result = await module.inspect_private_connectors(candidate)
        assert result == {
            "status": "setup_available",
            "provider": "custom",
            "saved": [
                {"id": record["connectorId"], "name": "Synthetic app", "status": "reconnect_needed"}
            ],
        }
        assert "private.example" not in str(result)
        assert "synthetic-private-token" not in str(result)
        authority.assert_awaited_once_with("owner", "synthetic-owner-token")
        candidate.state["hussh:conversation_id"] = "other-thread"
        assert (await module.inspect_private_connectors(candidate))["status"] == "blocked"
        candidate.state["hussh:conversation_id"] = "thread"
        candidate.user_id = "other"
        assert (await module.inspect_private_connectors(candidate))["status"] == "blocked"
    assert (await module.inspect_private_connectors(context()))["status"] == "unavailable"


async def test_probe_is_owner_bound_and_never_sends_the_owner_token(monkeypatch):
    authority = AsyncMock(return_value=True)
    probe = AsyncMock(
        return_value=SimpleNamespace(to_dict=lambda: {"status": "ready", "tools": []})
    )
    monkeypatch.setattr(module, "validate_first_party_owner_token", authority)
    monkeypatch.setattr(module, "probe_mcp_server", probe)
    candidate = context()
    candidate.state["hussh:consent_token"] = "synthetic-owner-token"
    result = await module.probe_private_connector("https://mcp.example.com/mcp", candidate)
    assert result["status"] == "ok" and result["probe"] == {"status": "ready", "tools": []}
    # The probe receives the address only: no owner token, header or vault record.
    probe.assert_awaited_once_with("https://mcp.example.com/mcp")
    assert "synthetic-owner-token" not in str(result)
    for mutate in (
        lambda c: setattr(c, "user_id", "other"),
        lambda c: c.state.__setitem__("temp:one_execution_surface", "voice"),
    ):
        blocked = context()
        blocked.state["hussh:consent_token"] = "synthetic-owner-token"
        mutate(blocked)
        assert (await module.probe_private_connector("https://x.example/mcp", blocked))[
            "status"
        ] == "blocked"
    authority.return_value = False
    assert (await module.probe_private_connector("https://x.example/mcp", candidate))[
        "status"
    ] == "blocked"
    assert probe.await_count == 1


async def test_private_connector_setup_does_not_claim_an_unavailable_vault_catalog(monkeypatch):
    monkeypatch.setattr(module, "validate_first_party_owner_token", AsyncMock(return_value=False))
    candidate = context()
    candidate.state["hussh:consent_token"] = "synthetic-owner-token"
    async with mcp_turn_scope("thread", owner_id="owner", configurations=[]):
        assert (await module.inspect_private_connectors(candidate))["status"] == "blocked"
    async with mcp_turn_scope("thread"):
        assert (await module.inspect_private_connectors(candidate))["status"] == "unavailable"


async def test_vault_connector_joins_native_discovery_review_refresh_and_disable(
    registry, monkeypatch
):
    """No provider dispatcher or private DB registration participates in this path."""
    record = {
        "version": 1,
        "connectorId": "custom_" + "a" * 32,
        "revision": "00000000-0000-4000-8000-000000000001",
        "displayName": "Synthetic app",
        "endpoint": "https://example.com/mcp",
        "enabled": True,
        "authentication": {
            "kind": "api_key",
            "header": "X-API-Key",
            "value": "synthetic-secret",
        },
    }
    registry.list_active_connectors.return_value = []
    monkeypatch.setattr(
        turn_module, "validate_first_party_owner_token", AsyncMock(return_value=True)
    )
    authorize = AsyncMock(return_value={"status": "review_required"})
    monkeypatch.setattr(module, "review_or_resume_call", authorize)
    native_call = AsyncMock(return_value={"content": [], "structuredContent": {"count": 1}})
    monkeypatch.setattr(McpTool, "_run_async_impl", native_call)

    first_page = SimpleNamespace(
        tools=[SimpleNamespace(name="search", inputSchema={"type": "object"})],
        nextCursor="second",
    )
    second_page = SimpleNamespace(
        tools=[SimpleNamespace(name="summarize", inputSchema={"type": "object"})],
        nextCursor=None,
    )
    session = SimpleNamespace(
        list_tools=AsyncMock(side_effect=lambda **kwargs: second_page if kwargs else first_page)
    )
    manager = SimpleNamespace(
        create_session=AsyncMock(return_value=session),
        _begin_session_use=Mock(),
        _end_session_use=Mock(),
        close=AsyncMock(),
    )
    original_acquire = turn_module.McpTurnResources.acquire
    acquired = []

    async def acquire(self, *args, **kwargs):
        toolset = await original_acquire(self, *args, **kwargs)
        toolset._mcp_session_manager = manager
        acquired.append(toolset)
        return toolset

    monkeypatch.setattr(turn_module.McpTurnResources, "acquire", acquire)
    candidate = context()
    candidate.state["hussh:consent_token"] = "synthetic-owner-token"
    async with mcp_turn_scope("thread", owner_id="owner", configurations=[record]):
        tools = await module.RegisteredMcpToolset().get_tools(candidate)
        assert len(tools) == 2
        assert {tool.descriptor["name"] for tool in tools} == {"search", "summarize"}
        assert all(tool.name.startswith("mcp_") for tool in tools)
        # Founder, 2026-09-27: the person's own connector runs without review.
        first = await tools[0].run_async(args={}, tool_context=candidate)
        assert first["status"] == "ok" and first["review"] == "own_connector"
        assert "synthetic-secret" not in repr(first)
        second = await tools[1].run_async(args={}, tool_context=candidate)
        assert second["status"] == "ok"
        authorize.assert_not_awaited()
        assert native_call.await_count == 2
        # Negative control: another owner's turn cannot use this connector.
        intruder = context()
        intruder.user_id = "intruder"
        intruder.state["hussh:consent_token"] = "synthetic-owner-token"
        assert (await tools[0].run_async(args={}, tool_context=intruder))["error"] == (
            "MCP_OWNER_MISMATCH"
        )
        assert native_call.await_count == 2
        acquired[0].refresh()
        assert (await tools[0].run_async(args={}, tool_context=candidate))["error"] == (
            "MCP_CATALOG_CHANGED"
        )
    assert registry.list_active_connectors.await_args.kwargs == {"user_id": None}

    async with mcp_turn_scope(
        "thread", owner_id="owner", configurations=[{**record, "enabled": False}]
    ):
        assert await module.RegisteredMcpToolset().get_tools(candidate) == []


async def test_disconnected_connector_does_not_hide_working_connector(registry):
    registry.list_active_connectors.return_value = [definition("revoked"), definition("working")]
    tool = SimpleNamespace(name="mcp_working", description="Read")
    async with mcp_turn_scope("thread") as scope:

        async def acquire(_context, connector_id, **_kwargs):
            if connector_id == "revoked":
                raise ExternalMcpError("Reconnect", code="MCP_CONNECTION_CHANGED")
            return SimpleNamespace(get_tools=AsyncMock(return_value=[tool]))

        scope.acquire = AsyncMock(side_effect=acquire)
        discovered = await module.RegisteredMcpToolset().get_tools(context())
        assert [item.name for item in discovered][1:] == [tool.name]
        assert discovered[0].name.startswith("connector_unavailable_")
        assert discovered[1].description.endswith("Read")


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


async def test_registry_failure_degrades_without_exposing_diagnostics(registry, caplog):
    registry.list_active_connectors.side_effect = RuntimeError("private SQL and provider token")
    async with mcp_turn_scope("thread"):
        discovered = await module.RegisteredMcpToolset().get_tools(context())
    # The turn still runs, without connector tools, rather than failing outright.
    assert discovered == []
    assert "private SQL" not in caplog.text
    assert "provider token" not in caplog.text


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


async def test_slow_connector_is_cancelled_and_does_not_hold_up_the_others(registry, monkeypatch):
    monkeypatch.setenv("MCP_DISCOVERY_TIMEOUT_SECONDS", "0.2")
    registry.list_active_connectors.return_value = [definition("slow"), definition("fast")]
    cancelled = asyncio.Event()
    tool = SimpleNamespace(name="mcp_fast", description="Read")

    async def acquire(_context, connector_id, **_kwargs):
        if connector_id == "fast":
            return SimpleNamespace(get_tools=AsyncMock(return_value=[tool]))
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    async with mcp_turn_scope("thread") as scope:
        scope.acquire = AsyncMock(side_effect=acquire)
        started = asyncio.get_running_loop().time()
        discovered = await module.RegisteredMcpToolset().get_tools(context())
        assert asyncio.get_running_loop().time() - started < 2
    assert cancelled.is_set()
    assert [item.name for item in discovered][1:] == ["mcp_fast"]
    assert discovered[0].name.startswith("connector_unavailable_")
    result = await discovered[0].run_async(args={}, tool_context=Mock())
    assert result["reason"] == "unavailable"
    assert result["status"] == "unavailable"
    assert "Nothing was sent" in result["message"]


async def test_never_connected_service_is_not_reported_as_a_problem(registry):
    registry.list_active_connectors.return_value = [definition("hubspot")]
    async with mcp_turn_scope("thread") as scope:
        scope.acquire = AsyncMock(
            side_effect=ExternalMcpError("Connect first", code="MCP_NOT_CONNECTED")
        )
        discovered = await module.RegisteredMcpToolset().get_tools(context())
    assert discovered == []


async def test_expired_connection_is_reported_as_needing_reconnect(registry):
    registry.list_active_connectors.return_value = [definition("hubspot")]
    async with mcp_turn_scope("thread") as scope:
        scope.acquire = AsyncMock(
            side_effect=ExternalMcpError("Reconnect", code="MCP_CREDENTIAL_EXPIRED")
        )
        discovered = await module.RegisteredMcpToolset().get_tools(context())
        (stand_in,) = discovered
        result = await stand_in.run_async(args={}, tool_context=Mock())
    assert result["reason"] == "reconnect"
    assert "reconnect" in result["message"]
    assert "Synthetic connector" in stand_in.description
    assert "Never use a different app" in stand_in.description


async def test_failed_connector_is_not_waited_on_again_in_the_same_turn(registry):
    registry.list_active_connectors.return_value = [definition("hubspot")]
    async with mcp_turn_scope("thread") as scope:
        scope.acquire = AsyncMock(side_effect=RuntimeError("down"))
        view = module.RegisteredMcpToolset()
        first = await view.get_tools(context())
        second = await view.get_tools(context())
        assert scope.acquire.await_count == 1
    assert [item.name for item in first] == [item.name for item in second]


async def test_stand_in_name_is_stable_unique_and_never_a_provider_tool_name(registry):
    registry.list_active_connectors.return_value = [definition("a"), definition("b")]
    async with mcp_turn_scope("thread") as scope:
        scope.acquire = AsyncMock(side_effect=RuntimeError("down"))
        discovered = await module.RegisteredMcpToolset().get_tools(context())
    names = [item.name for item in discovered]
    assert len(set(names)) == 2
    assert all(name.startswith("connector_unavailable_") for name in names)
    assert not any(name.startswith("mcp_") for name in names)


# --- listing is reused across the model steps of one turn --------------------------


def epoch_toolset(tools, epoch=3):
    return SimpleNamespace(catalog_epoch=epoch, get_tools=AsyncMock(return_value=tools))


async def test_a_connector_is_listed_once_per_turn_not_once_per_model_step(registry):
    tool = SimpleNamespace(name="mcp_one", description="Read", epoch=3)
    toolset = epoch_toolset([tool])
    async with mcp_turn_scope("thread") as scope:
        scope.acquire = AsyncMock(return_value=toolset)
        view = module.RegisteredMcpToolset()
        first = await view.get_tools(context())
        second = await view.get_tools(context())
        third = await view.get_tools(context())
        assert toolset.get_tools.await_count == 1
        assert scope.acquire.await_count == 1
    assert [t.name for t in first] == [t.name for t in second] == [t.name for t in third]
    # Each step still gets its own labelled copy; labels never accumulate on the original.
    assert second[0] is not first[0]
    assert second[0].description.count("Connected app:") == 1
    assert tool.description == "Read"


async def test_a_refreshed_catalog_is_listed_again(registry):
    tool = SimpleNamespace(name="mcp_one", description="Read", epoch=3)
    toolset = epoch_toolset([tool])
    async with mcp_turn_scope("thread") as scope:
        scope.acquire = AsyncMock(return_value=toolset)
        view = module.RegisteredMcpToolset()
        await view.get_tools(context())
        # A refresh bumps the epoch, which invalidates every tool listed before it.
        toolset.catalog_epoch = 4
        toolset.get_tools.return_value = [SimpleNamespace(name="mcp_two", description="", epoch=4)]
        refreshed = await view.get_tools(context())
        assert toolset.get_tools.await_count == 2
    assert [t.name for t in refreshed] == ["mcp_two"]


async def test_tools_that_carry_no_epoch_are_never_reused(registry):
    toolset = SimpleNamespace(
        catalog_epoch=3,
        get_tools=AsyncMock(return_value=[SimpleNamespace(name="mcp_one", description="Read")]),
    )
    async with mcp_turn_scope("thread") as scope:
        scope.acquire = AsyncMock(return_value=toolset)
        view = module.RegisteredMcpToolset()
        await view.get_tools(context())
        await view.get_tools(context())
        assert toolset.get_tools.await_count == 2


async def test_an_empty_listing_is_not_held_so_a_later_step_can_try_again(registry):
    toolset = epoch_toolset([])
    async with mcp_turn_scope("thread") as scope:
        scope.acquire = AsyncMock(return_value=toolset)
        view = module.RegisteredMcpToolset()
        await view.get_tools(context())
        await view.get_tools(context())
        assert toolset.get_tools.await_count == 2


async def test_a_listing_is_never_carried_into_another_turn(registry):
    tool = SimpleNamespace(name="mcp_one", description="Read", epoch=3)
    toolset = epoch_toolset([tool])
    view = module.RegisteredMcpToolset()
    for _ in range(2):
        async with mcp_turn_scope("thread") as scope:
            scope.acquire = AsyncMock(return_value=toolset)
            await view.get_tools(context())
    assert toolset.get_tools.await_count == 2
