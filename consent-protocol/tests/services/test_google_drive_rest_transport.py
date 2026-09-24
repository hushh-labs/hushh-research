"""Live Drive reads over the GA REST API, with the Drive MCP tool contract.

Google's Drive MCP server refused every tool call for this project ("The caller
does not have permission", 2026-09-24), so no live grant on UAT ever verified.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services import google_drive_adapter as adapter_module
from hushh_mcp.services import google_drive_rest_transport as rest
from hushh_mcp.services.drive_live_reader import DriveLiveReader
from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.google_drive_adapter import LIVE_POLICY_HASH, DriveMetadata, DriveReadError

FILE_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345"
GRANT = "synthetic-live-grant"
PAGE = "p1"


def row(**changes):
    return {
        "status": "connected",
        "validation_state": "verified",
        "verified_policy_hash": LIVE_POLICY_HASH,
        "connection_generation": 7,
        **changes,
    }


def transport(*, current=None, adapter=None, monkeypatch=None, enabled=True):
    if monkeypatch is not None:
        monkeypatch.setattr(rest, "connector_feature_enabled", lambda *_: enabled)
    oauth = SimpleNamespace(
        current_credential=AsyncMock(return_value=(row(), {"accessToken": GRANT})),
        lifecycle=SimpleNamespace(read=AsyncMock(return_value=current or row())),
    )
    return rest.GoogleDriveRestTransport(oauth=oauth, adapter=adapter or SimpleNamespace())


def test_the_mcp_query_dialect_becomes_drive_rest_q():
    assert rest.rest_query("(title contains 'bank' or fullText contains 'bank')") == (
        "((name contains 'bank' or fullText contains 'bank')) and trashed = false"
    )
    assert rest.rest_query("owner = 'me'") == "('me' in owners) and trashed = false"
    assert rest.rest_query("mimeType contains 'video/' and sharedWithMe = true") == (
        "(mimeType contains 'video/' and sharedWithMe = true) and trashed = false"
    )


async def test_search_maps_rest_files_to_the_mcp_file_shape(monkeypatch):
    listing = AsyncMock(
        return_value={
            "files": [
                {
                    "id": FILE_ID,
                    "name": "March statement.pdf",
                    "mimeType": "application/pdf",
                    "modifiedTime": "2026-09-20T10:00:00Z",
                    "createdTime": "2026-09-19T10:00:00Z",
                    "webViewLink": f"https://drive.google.com/file/d/{FILE_ID}/view",
                }
            ],
            "nextPageToken": "next",
        }
    )
    drive = transport(adapter=SimpleNamespace(list_files=listing), monkeypatch=monkeypatch)
    result = await drive.read_tool(
        user_id="owner",
        tool_name="search_files",
        arguments={"query": "title contains 'statement'", "pageSize": 8, "pageToken": PAGE},
    )
    assert result.is_error is False
    assert result.payload == {
        "files": [
            {
                "id": FILE_ID,
                "title": "March statement.pdf",
                "mimeType": "application/pdf",
                "modifiedTime": "2026-09-20T10:00:00Z",
                "createdTime": "2026-09-19T10:00:00Z",
                "viewUrl": f"https://drive.google.com/file/d/{FILE_ID}/view",
            }
        ],
        "nextPageToken": "next",
        "overLimit": False,
    }
    listing.assert_awaited_once_with(
        access_token=GRANT,
        query="(name contains 'statement') and trashed = false",
        page_size=8,
        page_token=PAGE,
    )


async def test_recent_files_use_the_recency_order(monkeypatch):
    listing = AsyncMock(return_value={"files": []})
    drive = transport(adapter=SimpleNamespace(list_files=listing), monkeypatch=monkeypatch)
    result = await drive.read_tool(
        user_id="owner",
        tool_name="list_recent_files",
        arguments={"orderBy": "recency", "pageSize": 8},
    )
    assert result.payload["files"] == []
    assert listing.await_args.kwargs["order_by"] == "recency"


async def test_reading_a_google_doc_exports_text(monkeypatch):
    adapter = SimpleNamespace(
        get_metadata=AsyncMock(
            return_value=DriveMetadata(
                FILE_ID,
                "Notes",
                "application/vnd.google-apps.document",
                "3",
                "2026-09-20T00:00:00Z",
                1,
                None,
            )
        ),
        read_live_bytes=AsyncMock(return_value=("text/plain", b"Closing balance 1,204.55")),
    )
    drive = transport(adapter=adapter, monkeypatch=monkeypatch)
    result = await drive.read_tool(
        user_id="owner", tool_name="read_file_content", arguments={"fileId": FILE_ID}
    )
    assert result.payload == {"fileContent": "Closing balance 1,204.55"}
    assert adapter.get_metadata.await_args.kwargs["require_app_authorized"] is False
    assert adapter.get_metadata.await_args.kwargs["require_genai_eligibility"] is False


async def test_an_unparseable_file_is_unsupported_not_a_failure(monkeypatch):
    adapter = SimpleNamespace(
        get_metadata=AsyncMock(
            return_value=DriveMetadata(
                FILE_ID, "clip.mp4", "video/mp4", "3", "2026-09-20T00:00:00Z", 1, None
            )
        ),
        read_live_bytes=AsyncMock(return_value=("video/mp4", b"\x00\x01")),
    )
    drive = transport(adapter=adapter, monkeypatch=monkeypatch)
    result = await drive.read_tool(
        user_id="owner", tool_name="read_file_content", arguments={"fileId": FILE_ID}
    )
    assert result.payload == {"textFormattingNotSupported": True}


@pytest.mark.parametrize(
    "tool,arguments",
    [
        ("read_file_content", {"fileId": "../x"}),
        ("search_files", {"query": ""}),
        ("search_files", {"query": "x", "pageSize": 99}),
        ("search_files", {"query": "x", "pageSize": True}),
        ("create_file", {}),
    ],
)
async def test_bad_arguments_and_tools_never_reach_drive(monkeypatch, tool, arguments):
    adapter = SimpleNamespace(
        list_files=AsyncMock(side_effect=AssertionError("drive reached")),
        get_metadata=AsyncMock(side_effect=AssertionError("drive reached")),
    )
    drive = transport(adapter=adapter, monkeypatch=monkeypatch)
    with pytest.raises(DriveOAuthError):
        await drive.read_tool(user_id="owner", tool_name=tool, arguments=arguments)


async def test_an_unverified_grant_or_a_disabled_feature_reads_nothing(monkeypatch):
    listing = AsyncMock(side_effect=AssertionError("drive reached"))
    drive = transport(adapter=SimpleNamespace(list_files=listing), monkeypatch=monkeypatch)
    drive._oauth.current_credential.return_value = (
        row(validation_state="unverified"),
        {"accessToken": GRANT},
    )
    with pytest.raises(DriveOAuthError, match="reconnect_required"):
        await drive.read_tool(user_id="owner", tool_name="search_files", arguments={"query": "x"})
    off = transport(
        adapter=SimpleNamespace(list_files=listing), monkeypatch=monkeypatch, enabled=False
    )
    with pytest.raises(DriveOAuthError, match="connector_unavailable"):
        await off.read_tool(user_id="owner", tool_name="search_files", arguments={"query": "x"})


async def test_a_connection_change_during_the_read_releases_nothing(monkeypatch):
    listing = AsyncMock(return_value={"files": []})
    drive = transport(
        adapter=SimpleNamespace(list_files=listing),
        current=row(connection_generation=8),
        monkeypatch=monkeypatch,
    )
    with pytest.raises(DriveOAuthError, match="connection_changed"):
        await drive.read_tool(user_id="owner", tool_name="search_files", arguments={"query": "x"})


async def test_the_connect_probe_is_one_bounded_rest_search():
    listing = AsyncMock(return_value={})
    drive = rest.GoogleDriveRestTransport(
        oauth=SimpleNamespace(), adapter=SimpleNamespace(list_files=listing)
    )
    await drive.probe(access_token=GRANT)  # an account with no files still verifies
    listing.assert_awaited_once_with(access_token=GRANT, query="trashed = false", page_size=1)
    listing.side_effect = DriveReadError("reconnect_required")
    with pytest.raises(DriveOAuthError, match="reconnect_required"):
        await drive.probe(access_token=GRANT)
    listing.side_effect = DriveReadError("source_unavailable")
    with pytest.raises(DriveOAuthError, match="connector_unavailable"):
        await drive.probe(access_token=GRANT)


@pytest.mark.parametrize(
    "params,allowed",
    [
        ({**adapter_module.LIST_FIXED, "q": "trashed = false", "pageSize": "8"}, True),
        ({**adapter_module.LIST_FIXED, "q": "x", "pageSize": "25", "orderBy": "recency"}, True),
        ({**adapter_module.LIST_FIXED, "q": "x", "pageSize": "26"}, False),
        ({**adapter_module.LIST_FIXED, "q": "x", "pageSize": "8", "orderBy": "name"}, False),
        ({**adapter_module.LIST_FIXED, "fields": "*", "q": "x", "pageSize": "8"}, False),
        (
            {**adapter_module.LIST_FIXED, "q": "x", "pageSize": "8", "spaces": "appDataFolder"},
            False,
        ),
        ({**adapter_module.LIST_FIXED, "q": "x" * 2001, "pageSize": "8"}, False),
    ],
)
async def test_the_adapter_admits_only_the_bounded_list_shape(monkeypatch, params, allowed):
    if allowed:
        # Stop right after admission; the HTTP layer is not under test here.
        monkeypatch.setattr(
            adapter_module.httpx,
            "AsyncClient",
            lambda **_: (_ for _ in ()).throw(RuntimeError("admitted")),
        )
        with pytest.raises(RuntimeError, match="admitted"):
            await adapter_module.GoogleDriveAdapter()._get_private(
                "/files", access_token=GRANT, params=params, limit=adapter_module.METADATA_LIMIT
            )
    else:
        with pytest.raises(DriveReadError, match="operation_not_allowed"):
            await adapter_module.GoogleDriveAdapter()._get_private(
                "/files", access_token=GRANT, params=params, limit=adapter_module.METADATA_LIMIT
            )


def test_live_reads_default_to_the_rest_transport():
    reader = DriveLiveReader(user_id="owner", require_access=AsyncMock(), oauth=SimpleNamespace())
    assert isinstance(reader.mcp, rest.GoogleDriveRestTransport)
