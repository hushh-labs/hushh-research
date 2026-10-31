"""Calendar MCP reads remain exact, owner-bound, and non-mutating."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult
from hushh_mcp.services.google_calendar_mcp_service import (
    GOOGLE_CALENDAR_MCP_ENDPOINT,
    GOOGLE_CALENDAR_READ_TOOLS,
    GoogleCalendarMcpService,
)
from hushh_mcp.services.google_connection_service import GoogleConnectionError


def test_reviewed_calendar_read_allowlist() -> None:
    assert GOOGLE_CALENDAR_READ_TOOLS == {"get_event", "list_events", "suggest_time"}


@pytest.mark.asyncio
async def test_discovery_filters_provider_writes_and_requires_owner_grant(monkeypatch) -> None:
    connections = SimpleNamespace(access_token=AsyncMock(return_value="owner-token"))
    listing = AsyncMock(
        return_value=[
            {"name": "create_event", "inputSchema": {"type": "object"}},
            {"name": "list_events", "inputSchema": {"type": "object"}},
        ]
    )
    monkeypatch.setattr("hushh_mcp.services.google_calendar_mcp_service.list_tools", listing)

    result = await GoogleCalendarMcpService(connections=connections).discover_read_tools(
        user_id="owner"
    )

    assert [item["name"] for item in result] == ["list_events"]
    connections.access_token.assert_awaited_once_with(
        user_id="owner", service="calendar", access_level="read"
    )
    listing.assert_awaited_once_with(
        endpoint=GOOGLE_CALENDAR_MCP_ENDPOINT,
        headers={"Authorization": "Bearer owner-token"},
    )


@pytest.mark.asyncio
async def test_read_uses_exact_owner_token_and_validated_arguments(monkeypatch) -> None:
    connections = SimpleNamespace(access_token=AsyncMock(return_value="owner-token"))
    listing = AsyncMock(
        return_value=[
            {
                "name": "list_events",
                "inputSchema": {
                    "type": "object",
                    "properties": {"calendarId": {"type": "string"}},
                    "required": ["calendarId"],
                    "additionalProperties": False,
                },
            }
        ]
    )
    expected = ExternalMcpToolResult(is_error=False, payload={"events": []}, truncated=False)
    call = AsyncMock(return_value=expected)
    monkeypatch.setattr("hushh_mcp.services.google_calendar_mcp_service.list_tools", listing)
    monkeypatch.setattr("hushh_mcp.services.google_calendar_mcp_service.call_tool", call)

    service = GoogleCalendarMcpService(connections=connections)
    with pytest.raises(GoogleConnectionError):
        await service.read_tool(user_id="owner", tool_name="list_events", arguments={})
    call.assert_not_called()
    result = await service.read_tool(
        user_id="owner", tool_name="list_events", arguments={"calendarId": "primary"}
    )

    assert result is expected
    call.assert_awaited_once_with(
        "list_events",
        {"calendarId": "primary"},
        endpoint=GOOGLE_CALENDAR_MCP_ENDPOINT,
        headers={"Authorization": "Bearer owner-token"},
    )


@pytest.mark.asyncio
async def test_writes_and_oversized_input_fail_before_provider_or_grant(monkeypatch) -> None:
    connections = SimpleNamespace(access_token=AsyncMock())
    listing = AsyncMock()
    call = AsyncMock()
    monkeypatch.setattr("hushh_mcp.services.google_calendar_mcp_service.list_tools", listing)
    monkeypatch.setattr("hushh_mcp.services.google_calendar_mcp_service.call_tool", call)
    service = GoogleCalendarMcpService(connections=connections)

    for name, args in [
        ("create_event", {}),
        ("delete_event", {}),
        ("list_events", {"calendarId": "x" * 5000}),
    ]:
        with pytest.raises(GoogleConnectionError):
            await service.read_tool(user_id="owner", tool_name=name, arguments=args)

    connections.access_token.assert_not_called()
    listing.assert_not_called()
    call.assert_not_called()


@pytest.mark.asyncio
async def test_warm_catalog_does_not_bypass_another_owners_grant(monkeypatch) -> None:
    async def owner_token(*, user_id: str, service: str, access_level: str) -> str:
        assert service == "calendar" and access_level == "read"
        if user_id != "owner-a":
            raise GoogleConnectionError("Connect Calendar first", status_code=403)
        return "owner-a-token"

    connections = SimpleNamespace(access_token=AsyncMock(side_effect=owner_token))
    listing = AsyncMock(return_value=[{"name": "list_events", "inputSchema": {"type": "object"}}])
    call = AsyncMock()
    monkeypatch.setattr("hushh_mcp.services.google_calendar_mcp_service.list_tools", listing)
    monkeypatch.setattr("hushh_mcp.services.google_calendar_mcp_service.call_tool", call)
    service = GoogleCalendarMcpService(connections=connections)

    assert await service.discover_read_tools(user_id="owner-a")
    with pytest.raises(GoogleConnectionError) as error:
        await service.read_tool(user_id="owner-b", tool_name="list_events", arguments={})

    assert error.value.status_code == 403
    listing.assert_awaited_once()
    call.assert_not_called()
