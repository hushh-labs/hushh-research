"""MCP capability discovery must follow the current credential."""

from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services import google_calendar_mcp_service as calendar
from hushh_mcp.services import google_drive_mcp_service as drive
from hushh_mcp.services import google_gmail_mcp_service as gmail
from hushh_mcp.services.mcp_catalog_cache import McpCatalogCache


def test_cached_catalogs_are_isolated_and_copied():
    cache = McpCatalogCache(ttl_seconds=300)
    cache.put("owner-a-token", [{"name": "search_files"}])
    assert cache.get("owner-b-token") is None
    first = cache.get("owner-a-token")
    assert first is not None
    first[0]["name"] = "modified"
    assert cache.get("owner-a-token") == [{"name": "search_files"}]


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
