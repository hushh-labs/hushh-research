"""Google connectors run over the GA REST APIs by default.

Founder decision 2026-09-25: the project is not enrolled in Google's hosted
Workspace MCP developer preview. With the enrollment switch off, no hosted
Workspace endpoint is dialed: Gmail and Calendar point to One's typed REST
tools, Drive reads use the REST transport with an app-authored catalog, and no
curated or REST registry row is admitted to the MCP transport.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from hushh_mcp.one_adk import governed_mcp_toolset, workspace_mcp_tools
from hushh_mcp.one_adk.governed_mcp_toolset import native_registration_admitted


@pytest.fixture(autouse=True)
def _rest_default(monkeypatch):
    monkeypatch.setattr(governed_mcp_toolset, "HOSTED_WORKSPACE_MCP_ENROLLED", False)
    workspace_mcp_tools._rest_drive.cache_clear()
    workspace_mcp_tools._hosted_service.cache_clear()
    for hosted in ("GoogleGmailMcpService", "GoogleCalendarMcpService", "GoogleDriveMcpService"):
        monkeypatch.setattr(
            workspace_mcp_tools,
            hosted,
            MagicMock(side_effect=AssertionError(f"{hosted} must not be constructed")),
        )


def _row(connector_id: str, transport: str, owner=None):
    return SimpleNamespace(
        connector_id=connector_id, transport_kind=transport, is_active=True, owner_user_id=owner
    )


@pytest.mark.parametrize("connector_id", ["google_drive", "google_gmail", "google_calendar"])
@pytest.mark.parametrize("transport", ["mcp", "google_drive_rest"])
def test_no_curated_google_row_is_admitted_to_mcp_while_not_enrolled(connector_id, transport):
    assert not native_registration_admitted(_row(connector_id, transport), "owner")


def test_rest_rows_are_never_admitted_to_mcp_even_when_enrolled(monkeypatch):
    monkeypatch.setattr(governed_mcp_toolset, "HOSTED_WORKSPACE_MCP_ENROLLED", True)
    assert not native_registration_admitted(_row("google_drive", "google_drive_rest"), "owner")
    assert native_registration_admitted(_row("google_drive", "mcp"), "owner")


def test_owner_registered_mcp_rows_keep_their_existing_admission():
    assert native_registration_admitted(_row("wiki", "mcp", owner="owner"), "owner")
    assert not native_registration_admitted(_row("wiki", "mcp", owner="other"), "owner")


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["gmail", "calendar"])
async def test_gmail_and_calendar_discovery_points_to_typed_tools(monkeypatch, provider):
    monkeypatch.setattr(workspace_mcp_tools, "_owner", AsyncMock(return_value="owner"))
    monkeypatch.setattr(workspace_mcp_tools, "_grant_binding", AsyncMock(return_value=("rev",)))
    result = await workspace_mcp_tools.discover_workspace_tools(provider, MagicMock())
    assert result == {
        "status": "api_available",
        "provider": provider,
        "message": "Use the connected service's existing Chat tools.",
    }


@pytest.mark.asyncio
async def test_missing_grant_still_asks_to_connect(monkeypatch):
    monkeypatch.setattr(workspace_mcp_tools, "_owner", AsyncMock(return_value="owner"))
    monkeypatch.setattr(workspace_mcp_tools, "_grant_binding", AsyncMock(return_value=None))
    result = await workspace_mcp_tools.discover_workspace_tools("gmail", MagicMock())
    assert result["status"] == "permission_required"


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["gmail", "calendar"])
async def test_gmail_and_calendar_reads_never_dial_hosted_mcp(monkeypatch, provider):
    monkeypatch.setattr(workspace_mcp_tools, "_owner", AsyncMock(return_value="owner"))
    result = await workspace_mcp_tools.read_workspace_tool(provider, "list_events", {}, MagicMock())
    assert result["status"] == "api_available"


def test_drive_catalog_is_app_authored_and_passes_the_schema_sanitizer():
    catalog = workspace_mcp_tools._trusted_catalog(
        "drive", [dict(item) for item in workspace_mcp_tools._DRIVE_REST_CATALOG]
    )
    assert [tool["name"] for tool in catalog] == [
        "search_files",
        "list_recent_files",
        "read_file_content",
    ]


def test_drive_service_is_the_rest_transport_facade():
    assert isinstance(
        workspace_mcp_tools._service("drive"), workspace_mcp_tools._DriveRestWorkspace
    )
    with pytest.raises(ValueError):
        workspace_mcp_tools._service("gmail")
