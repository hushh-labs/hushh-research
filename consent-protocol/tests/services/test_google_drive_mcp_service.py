"""Drive uses MCP transport without inheriting cumulative Google write authority."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult
from hushh_mcp.services.google_connection_service import (
    GoogleConnectionError,
    GoogleConnectionService,
)
from hushh_mcp.services.google_drive_mcp_service import (
    GOOGLE_DRIVE_READ_TOOLS,
    GoogleDriveMcpService,
)


def test_read_tool_set_cannot_expand_without_explicit_review():
    assert GOOGLE_DRIVE_READ_TOOLS == {
        "download_file_content",
        "get_file_metadata",
        "get_file_permissions",
        "list_recent_files",
        "read_file_content",
        "search_files",
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "tool",
    [
        "copy_file",
        "create_file",
        "delete_file",
        "search_files_and_send",
        "SEARCH_FILES",
        " search_files",
        "",
        "unknown",
    ],
)
async def test_unapproved_tools_fail_before_credentials_or_mcp(monkeypatch, tool):
    connections = SimpleNamespace(access_token=AsyncMock(return_value="synthetic-cumulative-token"))
    transport = AsyncMock()
    monkeypatch.setattr("hushh_mcp.services.google_drive_mcp_service.call_tool", transport)
    with pytest.raises(GoogleConnectionError) as error:
        await GoogleDriveMcpService(connections=connections).read_tool(
            user_id="owner", tool_name=tool, arguments={}
        )
    assert error.value.status_code == 403
    connections.access_token.assert_not_called()
    transport.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("tool", sorted(GOOGLE_DRIVE_READ_TOOLS))
async def test_reads_use_owner_service_grant_and_pinned_official_endpoint(monkeypatch, tool):
    connections = SimpleNamespace(access_token=AsyncMock(return_value="synthetic-token"))
    outcome = ExternalMcpToolResult(is_error=False, payload={"synthetic": True}, truncated=False)
    transport = AsyncMock(return_value=outcome)
    monkeypatch.setattr("hushh_mcp.services.google_drive_mcp_service.call_tool", transport)
    result = await GoogleDriveMcpService(connections=connections).read_tool(
        user_id="owner", tool_name=tool, arguments={}
    )
    connections.access_token.assert_awaited_once_with(
        user_id="owner", service="drive", access_level="read"
    )
    transport.assert_awaited_once_with(
        tool,
        {},
        endpoint="https://drivemcp.googleapis.com/mcp/v1",
        headers={"Authorization": "Bearer synthetic-token"},
    )
    assert result is outcome


@pytest.mark.asyncio
async def test_missing_owner_or_refused_grant_never_dispatches(monkeypatch):
    connections = SimpleNamespace(
        access_token=AsyncMock(
            side_effect=GoogleConnectionError(
                "Additional Google service permission is required", status_code=403
            )
        )
    )
    transport = AsyncMock()
    monkeypatch.setattr("hushh_mcp.services.google_drive_mcp_service.call_tool", transport)
    adapter = GoogleDriveMcpService(connections=connections)
    for owner in ["", "owner"]:
        with pytest.raises(GoogleConnectionError):
            await adapter.read_tool(user_id=owner, tool_name="search_files", arguments={})
    assert connections.access_token.await_count == 1
    transport.assert_not_called()


@pytest.mark.asyncio
async def test_existing_calendar_grant_cannot_authorize_drive(monkeypatch):
    class Db:
        def execute_raw(self, sql, params):
            if "google_provider_connections" in sql:
                return SimpleNamespace(
                    data=[
                        {
                            "status": "connected",
                            "provider_subject": "google-a",
                            "service_status": "connected",
                            "service_access_level": "read",
                            "service_scope_csv": "https://www.googleapis.com/auth/calendar.events.readonly",
                        }
                    ]
                )
            assert params["service"] == "drive"
            return SimpleNamespace(
                data=[
                    {
                        "status": "connected",
                        "access_level": "read",
                        "scope_csv": "https://www.googleapis.com/auth/calendar.events.readonly",
                    }
                ]
            )

    connections = GoogleConnectionService(db=Db())
    transport = AsyncMock()
    monkeypatch.setattr("hushh_mcp.services.google_drive_mcp_service.call_tool", transport)
    with pytest.raises(GoogleConnectionError) as error:
        await GoogleDriveMcpService(connections=connections).read_tool(
            user_id="owner", tool_name="search_files", arguments={}
        )
    assert error.value.status_code == 403
    transport.assert_not_called()
