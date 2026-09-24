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
    _search_metadata,
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
        project=_search_metadata,
    )


@pytest.mark.asyncio
async def test_live_probe_requires_authenticated_search_and_read_capabilities(monkeypatch):
    service = GoogleDriveMcpService(oauth=oauth())
    catalog = [
        {"name": name, "inputSchema": {"type": "object"}}
        for name in ("search_files", "read_file_content")
    ]
    service.discover_read_tools = AsyncMock(return_value=catalog)
    transport = AsyncMock(return_value=ExternalMcpToolResult(False, {"files": []}, False))
    monkeypatch.setattr("hushh_mcp.services.google_drive_mcp_service.call_tool", transport)
    await service.probe_live_search(access_token="synthetic")  # noqa: S106 - fake test token
    assert transport.await_args.kwargs["headers"] == {"Authorization": "Bearer synthetic"}
    service.discover_read_tools.return_value = catalog[:1]
    with pytest.raises(DriveOAuthError, match="connector_unavailable"):
        await service.probe_live_search(access_token="synthetic")  # noqa: S106


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
