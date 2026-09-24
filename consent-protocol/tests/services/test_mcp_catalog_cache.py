"""MCP capability discovery must follow the current credential."""

import asyncio
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services import google_calendar_mcp_service as calendar
from hushh_mcp.services import google_drive_mcp_service as drive
from hushh_mcp.services import google_gmail_mcp_service as gmail
from hushh_mcp.services.external_mcp_client import ExternalMcpError
from hushh_mcp.services.mcp_catalog_cache import McpCatalogCache


@pytest.mark.asyncio
@pytest.mark.parametrize("refresh_succeeds", [True, False])
async def test_refresh_rejects_late_catalog_at_call_boundary(refresh_succeeds):
    cache = McpCatalogCache(ttl_seconds=300)
    started = asyncio.Event()
    release = asyncio.Event()

    async def old_discovery():
        started.set()
        await release.wait()
        return [{"name": "removed_tool"}]

    pending = asyncio.create_task(cache.load("owner", old_discovery))
    await started.wait()
    try:
        fresh = AsyncMock(return_value=[{"name": "current_tool"}])
        if not refresh_succeeds:
            fresh.side_effect = RuntimeError("unavailable")
            with pytest.raises(RuntimeError):
                await cache.load("owner", fresh, force_refresh=True)
        else:
            await cache.load("owner", fresh, force_refresh=True)
    finally:
        release.set()
    with pytest.raises(ExternalMcpError) as error:
        await pending
    assert error.value.code == "MCP_CATALOG_CHANGED"
    assert cache.get("owner") == ([{"name": "current_tool"}] if refresh_succeeds else None)


def test_cached_catalogs_are_isolated_and_copied():
    cache = McpCatalogCache(ttl_seconds=300)
    cache.put("owner-a-token", [{"name": "search_files"}])
    assert cache.get("owner-b-token") is None
    first = cache.get("owner-a-token")
    assert first is not None
    first[0]["name"] = "modified"
    assert cache.get("owner-a-token") == [{"name": "search_files"}]


def test_refresh_preserves_other_credentials_and_rejects_stale_fill():
    cache = McpCatalogCache(ttl_seconds=300)
    cache.put("a", [{"name": "old"}])
    cache.put("b", [{"name": "other"}])
    old_revision = cache.revision
    cache.invalidate("a")
    assert cache.get("a") is None
    assert cache.get("b") == [{"name": "other"}]
    cache.put("a", [{"name": "fresh"}], revision=cache.revision)
    cache.put("a", [{"name": "late"}], revision=old_revision)
    assert cache.get("a") == [{"name": "fresh"}]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("module", "service", "tool"),
    [
        (drive, drive.GoogleDriveMcpService, "search_files"),
        (gmail, gmail.GoogleGmailMcpService, "list_labels"),
        (calendar, calendar.GoogleCalendarMcpService, "list_events"),
    ],
)
async def test_explicit_refresh_replaces_catalog_and_failure_does_not_restore_it(
    monkeypatch, module, service, tool
):
    catalog = [{"name": tool, "inputSchema": {"type": "object"}}]
    listing = AsyncMock(side_effect=[catalog, [], RuntimeError("unavailable"), catalog])
    monkeypatch.setattr(module, "list_tools", listing)
    connector = service()
    credential = "synthetic-catalog-credential"

    async def discover(refresh=False):
        if module is drive:
            return await connector.discover_read_tools(
                access_token=credential, force_refresh=refresh
            )
        return await connector._catalog_for_token(credential, force_refresh=refresh)

    assert await discover()
    assert await discover()
    assert listing.await_count == 1
    assert await discover(True) == []
    assert await discover() == []
    with pytest.raises(RuntimeError):
        await discover(True)
    assert connector._catalog.get(credential) is None
    assert await discover()
    assert listing.await_count == 4


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("module", "service", "first_tool", "second_tool"),
    [
        (drive, drive.GoogleDriveMcpService, "search_files", "list_recent_files"),
        (gmail, gmail.GoogleGmailMcpService, "get_thread", "list_labels"),
        (calendar, calendar.GoogleCalendarMcpService, "get_event", "list_events"),
    ],
)
async def test_provider_catalog_is_not_reused_for_another_credential(
    monkeypatch, module, service, first_tool, second_tool
):
    listing = AsyncMock(
        side_effect=[
            [{"name": first_tool, "inputSchema": {"type": "object"}}],
            [{"name": second_tool, "inputSchema": {"type": "object"}}],
        ]
    )
    monkeypatch.setattr(module, "list_tools", listing)
    connector = service()

    async def discover(token):
        if module is drive:
            return await connector.discover_read_tools(access_token=token)
        return await connector._catalog_for_token(token)

    assert [tool["name"] for tool in await discover("owner-a-token")] == [first_tool]
    assert [tool["name"] for tool in await discover("owner-b-token")] == [second_tool]
    assert [tool["name"] for tool in await discover("owner-a-token")] == [first_tool]
    assert listing.await_count == 2
