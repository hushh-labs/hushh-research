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


def _admit_schema(monkeypatch, tool: str, schema: dict | None = None) -> None:
    monkeypatch.setattr(
        GoogleDriveMcpService,
        "discover_read_tools",
        AsyncMock(return_value=[{"name": tool, "inputSchema": schema or {"type": "object"}}]),
    )


def test_read_tool_set_cannot_expand_without_explicit_review():
    assert GOOGLE_DRIVE_READ_TOOLS == {
        "get_file_metadata",
        "get_file_permissions",
        "list_recent_files",
        "read_file_content",
        "search_files",
    }


@pytest.mark.asyncio
async def test_discovery_exposes_only_bounded_official_read_schemas(monkeypatch):
    connections = SimpleNamespace(access_token=AsyncMock())
    catalog = AsyncMock(
        return_value=[
            {"name": "copy_file", "description": "Write access", "inputSchema": {"type": "object"}},
            {
                "name": "search_files",
                "description": "Find files by name.",
                "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}},
            },
            {
                "name": "read_file_content",
                "description": "x" * 10_000,
                "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}},
            },
            {"name": "get_file_metadata", "inputSchema": {}},
            {"name": "list_recent_files", "inputSchema": {"type": "array"}},
            {
                "name": "get_file_permissions",
                "inputSchema": {
                    "type": "object",
                    "properties": {"anything": {"$ref": "https://example.invalid/schema"}},
                },
            },
            {
                "name": "download_file_content",
                "inputSchema": {
                    "type": "object",
                    "properties": {"x": {"type": "not_a_json_schema_type"}},
                },
            },
            {
                "name": "get_file_permissions",
                "inputSchema": {
                    "type": "object",
                    "properties": {"x": {"$dynamicRef": "https://example.invalid/schema"}},
                },
            },
        ]
    )
    monkeypatch.setattr("hushh_mcp.services.google_drive_mcp_service.list_tools", catalog)
    discovered = await GoogleDriveMcpService(connections=connections).discover_read_tools()
    assert [item["name"] for item in discovered] == ["read_file_content", "search_files"]
    assert discovered[0]["description"] == "x" * 700
    assert discovered[1]["inputSchema"]["properties"]["query"]["type"] == "string"
    catalog.assert_awaited_once_with(endpoint="https://drivemcp.googleapis.com/mcp/v1")
    connections.access_token.assert_not_called()


@pytest.mark.asyncio
async def test_duplicate_capability_name_is_not_admitted(monkeypatch):
    catalog = AsyncMock(
        return_value=[
            {"name": "search_files", "inputSchema": {"type": "object"}},
            {"name": "search_files", "inputSchema": {"type": "object"}},
        ]
    )
    monkeypatch.setattr("hushh_mcp.services.google_drive_mcp_service.list_tools", catalog)
    assert await GoogleDriveMcpService(connections=SimpleNamespace()).discover_read_tools() == []


@pytest.mark.asyncio
async def test_external_dynamic_reference_is_never_resolved(monkeypatch):
    connections = SimpleNamespace(access_token=AsyncMock())
    transport = AsyncMock()
    monkeypatch.setattr(
        "hushh_mcp.services.google_drive_mcp_service.list_tools",
        AsyncMock(
            return_value=[
                {
                    "name": "search_files",
                    "inputSchema": {
                        "type": "object",
                        "properties": {"query": {"$dynamicRef": "https://example.invalid/private"}},
                    },
                }
            ]
        ),
    )
    monkeypatch.setattr("hushh_mcp.services.google_drive_mcp_service.call_tool", transport)
    service = GoogleDriveMcpService(connections=connections)
    assert await service.discover_read_tools() == []
    with pytest.raises(GoogleConnectionError):
        await service.read_tool(
            user_id="owner", tool_name="search_files", arguments={"query": "synthetic"}
        )
    connections.access_token.assert_not_called()
    transport.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "tool",
    [
        "download_file_content",
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
    _admit_schema(monkeypatch, tool)
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
    _admit_schema(monkeypatch, "search_files")
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
async def test_oversized_arguments_fail_before_catalog_or_credentials(monkeypatch):
    catalog = AsyncMock()
    monkeypatch.setattr("hushh_mcp.services.google_drive_mcp_service.list_tools", catalog)
    connections = SimpleNamespace(access_token=AsyncMock())

    with pytest.raises(GoogleConnectionError) as error:
        await GoogleDriveMcpService(connections=connections).read_tool(
            user_id="owner",
            tool_name="search_files",
            arguments={"query": "x" * 5000},
        )

    assert error.value.status_code == 400
    catalog.assert_not_called()
    connections.access_token.assert_not_called()


@pytest.mark.asyncio
async def test_existing_calendar_grant_cannot_authorize_drive(monkeypatch):
    _admit_schema(monkeypatch, "search_files")

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


@pytest.mark.asyncio
async def test_invalid_arguments_and_missing_catalog_capability_fail_before_grant(monkeypatch):
    connections = SimpleNamespace(access_token=AsyncMock())
    transport = AsyncMock()
    monkeypatch.setattr("hushh_mcp.services.google_drive_mcp_service.call_tool", transport)
    _admit_schema(
        monkeypatch,
        "search_files",
        {
            "type": "object",
            "required": ["query"],
            "properties": {"query": {"type": "string", "maxLength": 120}},
            "additionalProperties": False,
        },
    )
    service = GoogleDriveMcpService(connections=connections)
    for name, args in [
        ("get_file_metadata", {}),
        ("search_files", {}),
        ("search_files", {"query": "x", "unapproved": True}),
        ("search_files", {"query": "x" * 5000}),
    ]:
        with pytest.raises(GoogleConnectionError):
            await service.read_tool(user_id="owner", tool_name=name, arguments=args)
    connections.access_token.assert_not_called()
    transport.assert_not_called()
