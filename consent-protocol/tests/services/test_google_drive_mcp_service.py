"""Live Drive MCP reads require the current verified broad profile."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult
from hushh_mcp.services.google_drive_adapter import LIVE_POLICY_HASH
from hushh_mcp.services.google_drive_mcp_service import (
    GOOGLE_DRIVE_READ_TOOLS,
    GoogleDriveMcpService,
)


def oauth(*, profile="live", verified=True, generation=4):
    row = {
        "status": "connected",
        "validation_state": "verified" if verified else "unverified",
        "verified_policy_hash": LIVE_POLICY_HASH if verified else None,
        "connection_generation": generation,
    }
    credential = {"accessToken": "synthetic-live-token", "profile": profile}
    current = AsyncMock(return_value=(row, credential))
    if profile != "live":
        current.side_effect = DriveOAuthError("reconnect_required", status_code=401)
    return SimpleNamespace(
        current_credential=current,
        lifecycle=SimpleNamespace(read=AsyncMock(return_value=row)),
    )


def admit(monkeypatch, tool="search_files", schema=None):
    monkeypatch.setattr(
        GoogleDriveMcpService,
        "discover_read_tools",
        AsyncMock(return_value=[{"name": tool, "inputSchema": schema or {"type": "object"}}]),
    )
    monkeypatch.setattr(
        "hushh_mcp.services.google_drive_mcp_service.connector_feature_enabled",
        lambda *_: True,
    )


def test_allowlist_is_exact():
    assert GOOGLE_DRIVE_READ_TOOLS == {
        "get_file_metadata",
        "get_file_permissions",
        "list_recent_files",
        "read_file_content",
        "search_files",
    }


@pytest.mark.asyncio
async def test_discovery_filters_write_and_unsafe_schemas(monkeypatch):
    catalog = AsyncMock(
        return_value=[
            {"name": "copy_file", "inputSchema": {"type": "object"}},
            {"name": "search_files", "inputSchema": {"type": "object"}},
            {
                "name": "get_file_permissions",
                "inputSchema": {
                    "type": "object",
                    "properties": {"x": {"$ref": "https://example.invalid"}},
                },
            },
        ]
    )
    monkeypatch.setattr("hushh_mcp.services.google_drive_mcp_service.list_tools", catalog)
    result = await GoogleDriveMcpService(oauth=oauth()).discover_read_tools(
        access_token="synthetic"  # noqa: S106 - fake test token
    )
    assert [item["name"] for item in result] == ["search_files"]
    catalog.assert_awaited_once_with(
        endpoint="https://drivemcp.googleapis.com/mcp/v1",
        headers={"Authorization": "Bearer synthetic"},
    )


@pytest.mark.asyncio
async def test_catalog_rejects_duplicate_and_oversized_schemas_and_bounds_descriptions(monkeypatch):
    catalog = AsyncMock(
        return_value=[
            {"name": "search_files", "inputSchema": {"type": "object"}},
            {"name": "search_files", "inputSchema": {"type": "object"}},
            {
                "name": "read_file_content",
                "description": "d" * 1000,
                "inputSchema": {"type": "object", "properties": {"file_id": {"type": "string"}}},
            },
            {
                "name": "get_file_metadata",
                "inputSchema": {"type": "object", "properties": {"x": {"type": "x"}}},
            },
            {
                "name": "get_file_permissions",
                "inputSchema": {
                    "type": "object",
                    "properties": {"x": {"type": "string", "description": "s" * 20_000}},
                },
            },
        ]
    )
    monkeypatch.setattr("hushh_mcp.services.google_drive_mcp_service.list_tools", catalog)

    result = await GoogleDriveMcpService(oauth=oauth()).discover_read_tools()

    assert [item["name"] for item in result] == ["read_file_content"]
    assert len(result[0]["description"]) == 700


@pytest.mark.asyncio
@pytest.mark.parametrize("tool", sorted(GOOGLE_DRIVE_READ_TOOLS))
async def test_every_reviewed_read_capability_uses_live_owner_credential(monkeypatch, tool):
    admit(monkeypatch, tool)
    owner = oauth()
    transport = AsyncMock(return_value=ExternalMcpToolResult(False, {"ok": True}, False))
    monkeypatch.setattr("hushh_mcp.services.google_drive_mcp_service.call_tool", transport)

    await GoogleDriveMcpService(oauth=owner).read_tool(
        user_id="owner", tool_name=tool, arguments={}
    )

    owner.current_credential.assert_awaited_once_with(user_id="owner", required_profile="live")
    assert transport.await_args.kwargs["endpoint"] == "https://drivemcp.googleapis.com/mcp/v1"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "tool", ["copy_file", "delete_file", "download_file_content", "", "SEARCH_FILES"]
)
async def test_write_or_unknown_tools_fail_before_credential(monkeypatch, tool):
    owner = oauth()
    monkeypatch.setattr("hushh_mcp.services.google_drive_mcp_service.call_tool", AsyncMock())
    with pytest.raises(DriveOAuthError):
        await GoogleDriveMcpService(oauth=owner).read_tool(
            user_id="owner", tool_name=tool, arguments={}
        )
    owner.current_credential.assert_not_awaited()


@pytest.mark.asyncio
async def test_read_uses_current_live_credential_and_fixed_endpoint(monkeypatch):
    admit(monkeypatch)
    owner = oauth()
    outcome = ExternalMcpToolResult(is_error=False, payload={"files": []}, truncated=False)
    transport = AsyncMock(return_value=outcome)
    monkeypatch.setattr("hushh_mcp.services.google_drive_mcp_service.call_tool", transport)
    result = await GoogleDriveMcpService(oauth=owner).read_tool(
        user_id="owner", tool_name="search_files", arguments={"query": "name contains 'statement'"}
    )
    assert result is outcome
    owner.current_credential.assert_awaited_once_with(user_id="owner", required_profile="live")
    transport.assert_awaited_once_with(
        "search_files",
        {"query": "name contains 'statement'"},
        endpoint="https://drivemcp.googleapis.com/mcp/v1",
        headers={"Authorization": "Bearer synthetic-live-token"},
    )


@pytest.mark.asyncio
async def test_oversized_arguments_fail_before_catalog_or_credentials(monkeypatch):
    catalog = AsyncMock()
    monkeypatch.setattr(GoogleDriveMcpService, "discover_read_tools", catalog)
    owner = oauth()

    with pytest.raises(DriveOAuthError) as error:
        await GoogleDriveMcpService(oauth=owner).read_tool(
            user_id="owner",
            tool_name="search_files",
            arguments={"query": "x" * 5000},
        )

    assert error.value.status_code == 400
    catalog.assert_not_awaited()
    owner.current_credential.assert_not_awaited()


@pytest.mark.asyncio
async def test_unverified_or_selected_grant_never_dispatches(monkeypatch):
    admit(monkeypatch)
    transport = AsyncMock()
    monkeypatch.setattr("hushh_mcp.services.google_drive_mcp_service.call_tool", transport)
    for owner in (oauth(verified=False), oauth(profile="selected")):
        with pytest.raises(DriveOAuthError):
            await GoogleDriveMcpService(oauth=owner).read_tool(
                user_id="owner", tool_name="search_files", arguments={}
            )
    transport.assert_not_awaited()


@pytest.mark.asyncio
async def test_missing_owner_or_disabled_live_feature_never_reads(monkeypatch):
    owner = oauth()
    transport = AsyncMock()
    monkeypatch.setattr("hushh_mcp.services.google_drive_mcp_service.call_tool", transport)
    service = GoogleDriveMcpService(oauth=owner)

    with pytest.raises(DriveOAuthError):
        await service.read_tool(user_id="", tool_name="search_files", arguments={})
    owner.current_credential.assert_not_awaited()

    monkeypatch.setattr(
        "hushh_mcp.services.google_drive_mcp_service.connector_feature_enabled",
        lambda *_: False,
    )
    with pytest.raises(DriveOAuthError):
        await service.read_tool(user_id="owner", tool_name="search_files", arguments={})
    owner.current_credential.assert_not_awaited()
    transport.assert_not_awaited()


@pytest.mark.asyncio
async def test_invalid_arguments_and_missing_catalog_tool_never_dispatch(monkeypatch):
    admit(
        monkeypatch,
        "search_files",
        {
            "type": "object",
            "required": ["query"],
            "properties": {"query": {"type": "string", "maxLength": 120}},
            "additionalProperties": False,
        },
    )
    transport = AsyncMock()
    monkeypatch.setattr("hushh_mcp.services.google_drive_mcp_service.call_tool", transport)
    service = GoogleDriveMcpService(oauth=oauth())

    for name, arguments in (
        ("get_file_metadata", {}),
        ("search_files", {}),
        ("search_files", {"query": "ok", "unexpected": True}),
        ("search_files", {"query": "x" * 121}),
    ):
        with pytest.raises(DriveOAuthError):
            await service.read_tool(user_id="owner", tool_name=name, arguments=arguments)

    transport.assert_not_awaited()


@pytest.mark.asyncio
async def test_owner_discovery_requires_verified_live_oauth_and_stable_generation(monkeypatch):
    catalog = AsyncMock(return_value=[{"name": "search_files", "inputSchema": {"type": "object"}}])
    monkeypatch.setattr(GoogleDriveMcpService, "discover_read_tools", catalog)
    monkeypatch.setattr(
        "hushh_mcp.services.google_drive_mcp_service.connector_feature_enabled",
        lambda *_: True,
    )
    owner = oauth()
    service = GoogleDriveMcpService(oauth=owner)

    result = await service.discover_for_owner(user_id="owner")

    assert result == [{"name": "search_files", "inputSchema": {"type": "object"}}]
    owner.current_credential.assert_awaited_once_with(user_id="owner", required_profile="live")
    catalog.assert_awaited_once_with(access_token="synthetic-live-token")  # noqa: S106 - fake token

    owner.lifecycle.read.return_value = {"connection_generation": 5}
    with pytest.raises(DriveOAuthError, match="connection_changed"):
        await GoogleDriveMcpService(oauth=owner).discover_for_owner(user_id="owner")


@pytest.mark.asyncio
async def test_generation_change_discards_provider_result(monkeypatch):
    admit(monkeypatch)
    owner = oauth()
    owner.lifecycle.read.return_value = {
        "connection_generation": 5,
        "status": "connected",
        "verified_policy_hash": LIVE_POLICY_HASH,
    }
    monkeypatch.setattr(
        "hushh_mcp.services.google_drive_mcp_service.call_tool",
        AsyncMock(return_value=ExternalMcpToolResult(False, {"files": []}, False)),
    )
    with pytest.raises(DriveOAuthError, match="connection_changed"):
        await GoogleDriveMcpService(oauth=owner).read_tool(
            user_id="owner", tool_name="search_files", arguments={}
        )
