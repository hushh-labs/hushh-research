"""Live Drive reads over the GA REST API, with the Drive MCP tool contract.

Google's Drive MCP server refused every tool call for this project ("The caller
does not have permission", 2026-09-24), so no live grant on UAT ever verified.
"""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from hushh_mcp.services import google_drive_adapter as adapter_module
from hushh_mcp.services import google_drive_rest_transport as rest
from hushh_mcp.services.drive_live_reader import DriveLiveReader
from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.external_mcp_client import ExternalMcpError
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


async def test_group_index_read_refuses_a_replacement_grant_before_provider_io(monkeypatch):
    adapter = SimpleNamespace(list_files=AsyncMock())
    drive = transport(adapter=adapter, monkeypatch=monkeypatch)
    with pytest.raises(DriveOAuthError, match="connection_changed"):
        await drive.read_group_index_tool(
            user_id="owner",
            tool_name="search_files",
            arguments={"query": "trashed = false"},
            expected_generation=6,
        )
    adapter.list_files.assert_not_awaited()


async def test_real_rest_page_keeps_version_and_bounded_provider_relationship_facts(monkeypatch):
    source = {
        "id": FILE_ID,
        "name": "A generic title",
        "mimeType": "application/vnd.google-apps.document",
        "version": "741",
        "capabilities": {"canShare": True},
        "owners": [
            {
                "displayName": "Synthetic Owner",
                "emailAddress": "owner@example.invalid",
                "photoLink": "discard",
            }
        ],
        "sharingUser": {
            "displayName": "Synthetic Sharer",
            "emailAddress": "sharer@example.invalid",
            "permissionId": "discard",
        },
        "description": "private source text must not be projected",
    }
    adapter = SimpleNamespace(list_files=AsyncMock(return_value={"files": [source]}))
    drive = transport(adapter=adapter, monkeypatch=monkeypatch)
    result = await drive.read_owner_search_page(
        user_id="owner", tool_name="search_files", arguments={"query": "fullText contains 'topic'"}
    )
    observed = result.payload["files"][0]
    assert observed["version"] == "741"
    assert observed["owners"] == [
        {"displayName": "Synthetic Owner", "emailAddress": "owner@example.invalid"}
    ]
    assert observed["sharingUser"] == {
        "displayName": "Synthetic Sharer",
        "emailAddress": "sharer@example.invalid",
    }
    assert observed["capabilities"] == {"canShare": True}
    assert "description" not in observed
    assert "photoLink" not in observed["owners"][0]
    assert "permissionId" not in observed["sharingUser"]


@pytest.mark.parametrize(
    "evidence",
    [
        {"version": True},
        {"version": ""},
        {"version": "7\n41"},
        {"version": "1" * 33},
        {"owners": {}},
        {"owners": [{}] * 21},
        {"owners": ["person"]},
        {"owners": [{"displayName": "x" * 257}]},
        {"sharingUser": {"emailAddress": "email\nheader"}},
        {"sharingUser": {"emailAddress": "x" * 255}},
    ],
)
def test_provider_relationship_projection_rejects_unbounded_or_malformed_facts(evidence):
    source = {"id": FILE_ID, "name": "Plan.pdf", "mimeType": "application/pdf", **evidence}
    with pytest.raises(DriveReadError, match="provider_response_invalid"):
        rest._project_page({"files": [source]}, [source])


def test_provider_relationship_projection_ignores_blank_optional_identity_fields():
    # Drive can return sharingUser.displayName as an empty string on a valid
    # files.list page. One such row must not fail the whole owner's search.
    source = {
        "id": FILE_ID,
        "name": "Plan.pdf",
        "mimeType": "application/pdf",
        "version": "42",
        "owners": [{"displayName": "", "emailAddress": "owner@example.invalid"}],
        "sharingUser": {"displayName": ""},
    }
    projected = rest._project_page({"files": [source]}, [source])["files"][0]
    assert projected["owners"] == [{"emailAddress": "owner@example.invalid"}]
    assert "sharingUser" not in projected


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
        "incompleteSearch": False,
    }
    listing.assert_awaited_once_with(
        access_token=GRANT,
        query="(name contains 'statement') and trashed = false",
        page_size=8,
        page_token=PAGE,
        order_by="modifiedTime desc",
    )


async def test_owner_scanner_keeps_rest_rows_without_widening_agent_read(monkeypatch):
    listing = AsyncMock(
        return_value={
            "files": [
                _file(f"file-{index}", modified="2026-09-20T10:00:00Z") for index in range(100)
            ],
            "nextPageToken": "next-100",
            "incompleteSearch": False,
        }
    )
    drive = transport(adapter=SimpleNamespace(list_files=listing), monkeypatch=monkeypatch)
    result = await drive.read_owner_search_page(
        user_id="owner",
        tool_name="search_files",
        arguments={"query": "title contains 'file'", "pageSize": 100},
    )
    assert [item["id"] for item in result.payload["files"]] == [
        f"file-{index}" for index in range(100)
    ]
    assert result.payload["nextPageToken"] == "next-100"
    assert result.payload["overLimit"] is False
    assert listing.await_args.kwargs["page_size"] == 100
    large = await drive.read_owner_search_page(
        user_id="owner",
        tool_name="search_files",
        arguments={"query": "title contains 'file'", "pageSize": 1000},
    )
    # Google may return fewer rows than requested, leaving a continuation.
    assert len(large.payload["files"]) == 100
    assert large.payload["nextPageToken"] == "next-100"
    assert listing.await_args.kwargs["page_size"] == 1000
    assert listing.await_args.kwargs["owner_search_page"] is True
    with pytest.raises(DriveOAuthError, match="invalid_argument"):
        await drive.read_tool(
            user_id="owner",
            tool_name="search_files",
            arguments={"query": "title contains 'file'", "pageSize": 26},
        )
    with pytest.raises(DriveOAuthError, match="invalid_argument"):
        await drive.read_owner_search_page(
            user_id="owner",
            tool_name="search_files",
            arguments={"query": "title contains 'file'", "pageSize": 1001},
        )


async def test_owner_search_continuation_reaches_real_rest_adapter_at_page_size_1000(monkeypatch):
    original = httpx.AsyncClient
    requests = []

    def handler(request):
        requests.append(request)
        if request.url.params.get("pageToken") == "next-25":
            files = [
                _file(f"file-{index}", modified="2026-09-20T10:00:00Z") for index in range(25, 50)
            ]
            return httpx.Response(
                200, stream=httpx.ByteStream(json.dumps({"files": files}).encode())
            )
        files = [_file(f"file-{index}", modified="2026-09-20T10:00:00Z") for index in range(25)]
        return httpx.Response(
            200,
            stream=httpx.ByteStream(
                json.dumps({"files": files, "nextPageToken": "next-25"}).encode()
            ),
        )

    monkeypatch.setattr(
        adapter_module.httpx,
        "AsyncClient",
        lambda **kw: original(**kw, transport=httpx.MockTransport(handler)),
    )
    drive = transport(adapter=adapter_module.GoogleDriveAdapter(), monkeypatch=monkeypatch)
    first = await drive.read_owner_search_page(
        user_id="owner",
        tool_name="search_files",
        arguments={"query": "title contains 'file'", "pageSize": 25},
    )
    second = await drive.read_owner_search_page(
        user_id="owner",
        tool_name="search_files",
        arguments={"query": "title contains 'file'", "pageSize": 1000, "pageToken": "next-25"},
    )
    assert len(first.payload["files"]) == len(second.payload["files"]) == 25
    assert first.payload["nextPageToken"] == "next-25"
    assert [request.url.params["pageSize"] for request in requests] == ["25", "1000"]
    assert requests[1].url.params["pageToken"] == "next-25"


def _file(file_id, *, modified, created="2026-09-01T00:00:00Z"):
    return {
        "id": file_id,
        "name": file_id,
        "mimeType": "application/pdf",
        "modifiedTime": modified,
        "createdTime": created,
        "webViewLink": f"https://drive.google.com/file/d/{file_id}/view",
    }


async def test_full_text_search_preserves_provider_relevance_and_cursor(monkeypatch):
    # Drive refuses orderBy on any q with a fullText term ("Sorting is not
    # supported for queries with fullText terms"), so a keyword search that
    # sent one failed outright. Negative control: the previous code sent
    # order_by="modifiedTime desc" here and this assertion fails on it.
    relevance_order = [
        _file("older", modified="2026-09-01T00:00:00Z"),
        _file("undated", modified=None),
        _file("newest", modified="2026-09-20T00:00:00Z"),
    ]
    listing = AsyncMock(return_value={"files": relevance_order, "nextPageToken": "more"})
    drive = transport(adapter=SimpleNamespace(list_files=listing), monkeypatch=monkeypatch)
    result = await drive.read_tool(
        user_id="owner",
        tool_name="search_files",
        arguments={"query": "(title contains 'tax' or fullText contains 'tax')"},
    )
    assert listing.await_args.kwargs["order_by"] is None
    assert listing.await_args.kwargs["query"] == (
        "((name contains 'tax' or fullText contains 'tax')) and trashed = false"
    )
    assert [item["id"] for item in result.payload["files"]] == ["older", "undated", "newest"]
    assert result.payload["nextPageToken"] == "more"


async def test_full_text_does_not_pretend_page_sorting_is_global_chronology(monkeypatch):
    listing = AsyncMock(
        return_value={
            "files": [
                _file("a", modified="2026-09-20T00:00:00Z", created="2026-01-01T00:00:00Z"),
                _file("b", modified="2026-09-01T00:00:00Z", created="2026-09-10T00:00:00Z"),
            ]
        }
    )
    drive = transport(adapter=SimpleNamespace(list_files=listing), monkeypatch=monkeypatch)
    result = await drive.read_tool(
        user_id="owner",
        tool_name="search_files",
        arguments={
            "query": "fullText contains 'invoice'",
            "orderBy": "createdTime desc",
        },
    )
    assert listing.await_args.kwargs["order_by"] is None
    assert [item["id"] for item in result.payload["files"]] == ["a", "b"]


async def test_a_metadata_search_keeps_the_provider_side_order(monkeypatch):
    listing = AsyncMock(return_value={"files": []})
    drive = transport(adapter=SimpleNamespace(list_files=listing), monkeypatch=monkeypatch)
    await drive.read_tool(
        user_id="owner",
        tool_name="search_files",
        arguments={"query": "title contains 'tax'", "orderBy": "createdTime desc"},
    )
    assert listing.await_args.kwargs["order_by"] == "createdTime desc"


def test_only_a_full_text_term_disables_provider_sorting():
    assert rest.has_full_text_term("(title contains 'x' or fullText contains 'x')")
    assert not rest.has_full_text_term("title contains 'fulltextual'")
    assert not rest.has_full_text_term("mimeType = 'application/pdf'")


async def test_a_created_window_is_listed_newest_created_first(monkeypatch):
    listing = AsyncMock(return_value={"files": []})
    drive = transport(adapter=SimpleNamespace(list_files=listing), monkeypatch=monkeypatch)
    await drive.read_tool(
        user_id="owner",
        tool_name="search_files",
        arguments={
            "query": "(createdTime >= '2026-09-17T00:00:00Z' and createdTime < '2026-09-24T00:00:00Z')",
            "orderBy": "createdTime desc",
        },
    )
    assert listing.await_args.kwargs["order_by"] == "createdTime desc"


@pytest.mark.parametrize(
    "order", ["name", "createdTime", "recency desc", ["createdTime desc"], None]
)
async def test_an_unlisted_order_is_refused_before_any_provider_call(monkeypatch, order):
    listing = AsyncMock(return_value={"files": []})
    drive = transport(adapter=SimpleNamespace(list_files=listing), monkeypatch=monkeypatch)
    with pytest.raises(DriveOAuthError, match="invalid_argument"):
        await drive.read_tool(
            user_id="owner",
            tool_name="search_files",
            arguments={"query": "title contains 'x'", "orderBy": order},
        )
    assert listing.called is False


async def test_recent_files_come_back_newest_first(monkeypatch):
    # files.list sorts each key ascending unless told "desc": bare "recency"
    # would list the oldest files first.
    listing = AsyncMock(return_value={"files": []})
    drive = transport(adapter=SimpleNamespace(list_files=listing), monkeypatch=monkeypatch)
    result = await drive.read_tool(
        user_id="owner",
        tool_name="list_recent_files",
        arguments={"orderBy": "recency", "pageSize": 8},
    )
    assert result.payload["files"] == []
    assert listing.await_args.kwargs["order_by"] == "recency desc"


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


async def test_compilation_can_tell_when_drive_extraction_was_truncated(monkeypatch):
    adapter = SimpleNamespace(
        get_metadata=AsyncMock(
            return_value=DriveMetadata(
                FILE_ID,
                "Long notes",
                "application/vnd.google-apps.document",
                "3",
                "2026-09-20T00:00:00Z",
                1,
                None,
            )
        ),
        read_live_bytes=AsyncMock(return_value=("text/plain", b"many pages")),
    )
    monkeypatch.setattr(
        rest.IsolatedDocumentParser,
        "parse",
        AsyncMock(return_value=SimpleNamespace(pages=("first pages",), truncated=True)),
    )
    drive = transport(adapter=adapter, monkeypatch=monkeypatch)
    result = await drive.read_tool(
        user_id="owner", tool_name="read_file_content", arguments={"fileId": FILE_ID}
    )
    assert result.payload == {"fileContent": "first pages", "contentTruncated": True}


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
    ("code", "payload"),
    [
        (
            "encrypted_document",
            {"textFormattingNotSupported": True, "reason": "encrypted_document"},
        ),
        (
            "no_extractable_text",
            {"textFormattingNotSupported": True, "reason": "no_extractable_text"},
        ),
        ("file_too_large", {"textFormattingNotSupported": True, "reason": "file_too_large"}),
        ("invalid_document", {"textFormattingNotSupported": True, "reason": "invalid_document"}),
        # Anything else keeps the exact old payload: no new vocabulary leaks out.
        ("unsupported_format", {"textFormattingNotSupported": True}),
        ("unexpected_code", {"textFormattingNotSupported": True}),
    ],
)
async def test_parse_errors_return_an_allowlisted_reason(monkeypatch, code, payload):
    adapter = SimpleNamespace(
        get_metadata=AsyncMock(
            return_value=DriveMetadata(
                FILE_ID, "Locked.pdf", "application/pdf", "3", "2026-09-20T00:00:00Z", 1, None
            )
        ),
        read_live_bytes=AsyncMock(return_value=("application/pdf", b"%PDF-1.7")),
    )

    monkeypatch.setattr(
        rest.IsolatedDocumentParser, "parse", AsyncMock(side_effect=DriveReadError(code))
    )
    drive = transport(adapter=adapter, monkeypatch=monkeypatch)
    result = await drive.read_tool(
        user_id="owner", tool_name="read_file_content", arguments={"fileId": FILE_ID}
    )
    assert result.payload == payload


@pytest.mark.parametrize(
    "tool,arguments",
    [
        ("read_file_content", {"fileId": "../x"}),
        ("search_files", {"query": ""}),
        ("search_files", {"query": "x", "pageSize": 99}),
        ("search_files", {"query": "x", "pageSize": True}),
        # A search needs a criterion; a typed filter never carries raw syntax.
        ("search_files", {}),
        ("search_files", {"owner": "everyone"}),
        ("search_files", {"mimeType": "x' or name contains 'y"}),
        ("search_files", {"folderId": "a' in parents or 'b"}),
        ("search_files", {"modifiedAfter": "last week"}),
        # The model's read tool can never reach a write, reviewed or not.
        ("create_file", {}),
        ("share_file", {"fileId": FILE_ID, "email": "a@example.invalid", "role": "writer"}),
        ("trash_file", {"fileId": FILE_ID}),
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


async def test_pooled_search_checks_credentials_and_revocation_on_every_page(monkeypatch):
    listing = AsyncMock(return_value={"files": []})
    drive = transport(adapter=SimpleNamespace(list_files=listing), monkeypatch=monkeypatch)
    drive._oauth.current_credential.side_effect = [
        (row(), {"accessToken": "synthetic-first"}),
        (row(), {"accessToken": "synthetic-refreshed"}),
        DriveOAuthError("reconnect_required", status_code=401),
    ]
    async with drive.owner_search_session():
        for _ in range(2):
            await drive.read_owner_search_page(
                user_id="owner", tool_name="search_files", arguments={"query": "x"}
            )
        with pytest.raises(DriveOAuthError, match="reconnect_required"):
            await drive.read_owner_search_page(
                user_id="owner", tool_name="search_files", arguments={"query": "x"}
            )
    assert [call.kwargs["access_token"] for call in listing.await_args_list] == [
        "synthetic-first",
        "synthetic-refreshed",
    ]
    assert drive._oauth.lifecycle.read.await_count == 2


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
        (
            {**adapter_module.LIST_FIXED, "q": "x", "pageSize": "25", "orderBy": "recency desc"},
            True,
        ),
        (
            {
                **adapter_module.LIST_FIXED,
                "q": "x",
                "pageSize": "8",
                "orderBy": "modifiedTime desc",
            },
            True,
        ),
        (
            {
                **adapter_module.LIST_FIXED,
                "q": "x",
                "pageSize": "8",
                "orderBy": "createdTime desc",
            },
            True,
        ),
        ({**adapter_module.LIST_FIXED, "q": "x", "pageSize": "8", "orderBy": "recency"}, False),
        ({**adapter_module.LIST_FIXED, "q": "x", "pageSize": "8", "orderBy": "createdTime"}, False),
        ({**adapter_module.LIST_FIXED, "q": "x", "pageSize": "100"}, True),
        ({**adapter_module.LIST_FIXED, "q": "x", "pageSize": "101"}, False),
        ({**adapter_module.LIST_FIXED, "q": "x", "pageSize": "8", "orderBy": "name"}, False),
        ({**adapter_module.LIST_FIXED, "fields": "*", "q": "x", "pageSize": "8"}, False),
        (
            {**adapter_module.LIST_FIXED, "q": "x", "pageSize": "8", "spaces": "appDataFolder"},
            False,
        ),
        ({**adapter_module.LIST_FIXED, "q": "x" * 4097, "pageSize": "8"}, False),
        (
            {
                **adapter_module.LIST_FIXED,
                "corpora": "drive",
                "driveId": "team-1",
                "q": "x",
                "pageSize": "25",
            },
            True,
        ),
        ({**adapter_module.LIST_FIXED, "corpora": "drive", "q": "x", "pageSize": "25"}, False),
        ({**adapter_module.LIST_FIXED, "driveId": "team-1", "q": "x", "pageSize": "25"}, False),
        ({**adapter_module.LIST_FIXED, "corpora": "allDrives", "q": "x", "pageSize": "25"}, False),
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


async def test_typed_search_filters_compile_to_one_escaped_drive_query(monkeypatch):
    # The owner's words are data, never query syntax: a quote or backslash in
    # them cannot close the literal and add a clause of the model's choosing.
    listing = AsyncMock(return_value={"files": []})
    drive = transport(adapter=SimpleNamespace(list_files=listing), monkeypatch=monkeypatch)
    await drive.read_tool(
        user_id="owner",
        tool_name="search_files",
        arguments={
            "text": "Q3 'budget' \\ final",
            "mimeType": "spreadsheet",
            "owner": "shared_with_me",
            "modifiedAfter": "2026-09-01",
            "modifiedBefore": "2026-09-27T10:00:00-07:00",
            "folderId": "folder_1",
        },
    )
    literal = "'Q3 \\'budget\\' \\\\ final'"
    assert listing.await_args.kwargs["query"] == (
        f"(name contains {literal} or fullText contains {rest.full_text_literal("Q3 'budget' \\ final")})"
        " and mimeType = 'application/vnd.google-apps.spreadsheet'"
        " and sharedWithMe = true"
        " and modifiedTime >= '2026-09-01T00:00:00Z'"
        " and modifiedTime < '2026-09-27T17:00:00Z'"
        " and 'folder_1' in parents"
        " and trashed = false"
    )
    # A word search is a fullText search, which Drive refuses to order.
    assert listing.await_args.kwargs["order_by"] is None


async def test_a_file_without_text_returns_metadata_only(monkeypatch):
    adapter = SimpleNamespace(
        get_metadata=AsyncMock(side_effect=DriveReadError("unsupported_format")),
        get_file_facts=AsyncMock(
            return_value={"id": FILE_ID, "title": "clip.mp4", "mimeType": "video/mp4"}
        ),
        read_live_bytes=AsyncMock(side_effect=AssertionError("content read")),
    )
    drive = transport(adapter=adapter, monkeypatch=monkeypatch)
    result = await drive.read_tool(
        user_id="owner", tool_name="read_file_content", arguments={"fileId": FILE_ID}
    )
    assert result.payload == {
        "textFormattingNotSupported": True,
        "metadataOnly": True,
        "file": {"id": FILE_ID, "title": "clip.mp4", "mimeType": "video/mp4"},
    }


def _folder(**changes):
    from hushh_mcp.services.google_drive_write_adapter import FOLDER_MIME, FileFacts

    fields = {
        "file_id": "folder_1",
        "mime_type": FOLDER_MIME,
        "parents": (),
        "trashed": False,
        "owned_by_me": True,
        "shared": False,
        "shared_drive": False,
        "can_add_children": True,
        **changes,
    }
    return FileFacts(**fields)


@pytest.mark.parametrize(
    "folder", [{"shared": True}, {"owned_by_me": False}, {"shared_drive": True}]
)
@pytest.mark.parametrize(
    "tool,arguments",
    [
        ("create_file", {"name": "Notes", "kind": "document", "folderId": "folder_1"}),
        ("copy_file", {"fileId": FILE_ID, "folderId": "folder_1"}),
        ("move_file", {"fileId": FILE_ID, "folderId": "folder_1"}),
    ],
)
async def test_a_direct_write_cannot_share_a_file_by_filing_it(
    monkeypatch, folder, tool, arguments
):
    # Sharing is a reviewed write. Filing into a folder others can see would
    # share the file with them, so no direct write may choose such a folder.
    from hushh_mcp.services.google_drive_write_adapter import DriveWriteError

    refuse = AsyncMock(side_effect=AssertionError("drive written"))
    writer = SimpleNamespace(
        facts=AsyncMock(return_value=_folder(**folder)), create=refuse, copy=refuse, update=refuse
    )
    drive = transport(monkeypatch=monkeypatch)
    drive.writer = writer
    with pytest.raises(DriveWriteError, match="destination_shared"):
        await drive.write_tool(user_id="owner", tool_name=tool, arguments=arguments)
    refuse.assert_not_awaited()


async def test_a_move_into_a_private_folder_leaves_its_old_folders(monkeypatch):
    moved = {"id": FILE_ID, "title": "a", "mimeType": "application/pdf", "viewUrl": None}
    writer = SimpleNamespace(
        facts=AsyncMock(
            side_effect=[_folder(), _folder(file_id=FILE_ID, parents=("old_1", "old_2"))]
        ),
        update=AsyncMock(return_value=moved),
    )
    drive = transport(monkeypatch=monkeypatch)
    drive.writer = writer
    result = await drive.write_tool(
        user_id="owner",
        tool_name="move_file",
        arguments={"fileId": FILE_ID, "folderId": "folder_1", "name": "Final"},
    )
    assert result.payload == {"file": moved}
    writer.update.assert_awaited_once_with(
        access_token=GRANT,
        target=FILE_ID,
        name="Final",
        add_parent="folder_1",
        remove_parents=("old_1", "old_2"),
    )


async def test_writes_keep_the_live_grant_fence(monkeypatch):
    comment = AsyncMock(return_value={"commentId": "c1", "createdTime": None})
    arguments = {"fileId": FILE_ID, "text": "Looks good"}
    off = transport(monkeypatch=monkeypatch, enabled=False)
    off.writer = SimpleNamespace(comment=comment)
    with pytest.raises(DriveOAuthError, match="connector_unavailable"):
        await off.write_tool(user_id="owner", tool_name="add_comment", arguments=arguments)
    comment.assert_not_awaited()
    # A write already sent when the connection changes is not reported as a
    # failure to reconnect and retry, which could post it twice.
    from hushh_mcp.services.google_drive_write_adapter import DriveWriteError

    changed = transport(current=row(connection_generation=8), monkeypatch=monkeypatch)
    changed.writer = SimpleNamespace(comment=comment)
    with pytest.raises(DriveWriteError) as raised:
        await changed.write_tool(user_id="owner", tool_name="add_comment", arguments=arguments)
    assert raised.value.outcome_unknown is True


async def test_a_reviewed_write_under_another_connection_is_refused_before_sending(monkeypatch):
    share = AsyncMock(side_effect=AssertionError("drive written"))
    drive = transport(monkeypatch=monkeypatch)
    drive.writer = SimpleNamespace(share=share)
    arguments = {"fileId": FILE_ID, "email": "a@example.invalid", "role": "reader"}
    with pytest.raises(DriveOAuthError, match="connection_changed"):
        await drive.write_tool(
            user_id="owner", tool_name="share_file", arguments=arguments, expected_generation=6
        )
    share.assert_not_awaited()


async def test_any_failure_after_a_write_was_sent_is_an_unknown_outcome(monkeypatch):
    # A failure after the request left (here the post-write connection read)
    # must not read as a plain error the model might retry into a duplicate.
    # A failure before anything was sent stays an ordinary refusal.
    from hushh_mcp.services import google_drive_write_adapter as writes

    async def sent_comment(**_):
        writes.MUTATION_SENT.get()["sent"] = True
        return {"commentId": "c1", "createdTime": None}

    drive = transport(monkeypatch=monkeypatch)
    drive.writer = SimpleNamespace(comment=sent_comment)
    drive._oauth.lifecycle.read.side_effect = RuntimeError("database unavailable")
    arguments = {"fileId": FILE_ID, "text": "Looks good"}
    with pytest.raises(writes.DriveWriteError) as raised:
        await drive.write_tool(user_id="owner", tool_name="add_comment", arguments=arguments)
    assert raised.value.outcome_unknown is True

    unsent = transport(monkeypatch=monkeypatch)
    unsent.writer = SimpleNamespace(comment=AsyncMock(side_effect=RuntimeError("before send")))
    with pytest.raises(RuntimeError, match="before send"):
        await unsent.write_tool(user_id="owner", tool_name="add_comment", arguments=arguments)


@pytest.mark.parametrize(
    "title",
    ["O'Brien\\Notes.pdf", "A title contains B", "fullText owner = 'me'", "नमस्ते • résumé.pdf"],
)
async def test_exact_title_literals_survive_rest_compatibility_translation(monkeypatch, title):
    listing = AsyncMock(
        return_value={"files": [], "incompleteSearch": True, "nextPageToken": "later"}
    )
    drive = transport(adapter=SimpleNamespace(list_files=listing), monkeypatch=monkeypatch)
    literal = rest.quote_literal(title)
    result = await drive.read_tool(
        user_id="owner", tool_name="search_files", arguments={"query": f"title = {literal}"}
    )
    assert listing.await_args.kwargs["query"] == f"(name = {literal}) and trashed = false"
    assert listing.await_args.kwargs["order_by"] == "modifiedTime desc"
    assert result.payload["incompleteSearch"] is True and result.payload["nextPageToken"] == "later"


def test_query_compilation_treats_punctuation_as_literal_and_multiword_text_as_phrase():
    assert rest.compile_search_terms(["bank", "salary slip"]) == (
        "(title contains 'bank' or fullText contains 'bank') and "
        "(title contains 'salary slip' or fullText contains '\"salary slip\"')"
    )
    assert rest.compile_search_terms(["2026/09/10"]) == (
        "(title contains '2026/09/10' or fullText contains '\"2026/09/10\"')"
    )
    assert rest.rest_query("owner = 'me' and title contains 'owner = \\'me\\''") == (
        "('me' in owners and name contains 'owner = \\'me\\'') and trashed = false"
    )


async def test_shared_drive_inventory_and_per_drive_search_preserve_cursors(monkeypatch):
    adapter = SimpleNamespace(
        list_drives=AsyncMock(
            return_value={
                "drives": [{"id": "drive-1", "name": "Team", "secret": "drop"}],
                "nextPageToken": "drive-next",
            }
        ),
        list_files=AsyncMock(
            return_value={"files": [], "nextPageToken": "file-next", "incompleteSearch": True}
        ),
    )
    drive = transport(adapter=adapter, monkeypatch=monkeypatch)
    inventory = await drive.read_tool(
        user_id="owner",
        tool_name="list_shared_drives",
        arguments={"pageSize": 25, "pageToken": "drive-start"},
    )
    assert inventory.payload == {
        "drives": [{"id": "drive-1", "name": "Team"}],
        "nextPageToken": "drive-next",
    }
    assert adapter.list_drives.await_args.kwargs["page_token"] == "drive-start"
    listing = await drive.read_tool(
        user_id="owner",
        tool_name="search_files",
        arguments={"query": "name = 'Plan'", "driveId": "drive-1", "pageToken": "file-start"},
    )
    assert adapter.list_files.await_args.kwargs["drive_id"] == "drive-1"
    assert (
        listing.payload["nextPageToken"] == "file-next"
        and listing.payload["incompleteSearch"] is True
    )
    with pytest.raises(DriveOAuthError, match="invalid_argument"):
        await drive.read_tool(
            user_id="owner",
            tool_name="search_files",
            arguments={"query": "name = 'Plan'", "driveId": "../bad"},
        )
    assert adapter.list_files.await_count == 1


@pytest.mark.parametrize(
    "params,allowed",
    [
        ({"fields": "nextPageToken,drives(id,name)", "pageSize": "25", "pageToken": "next"}, True),
        ({"fields": "*", "pageSize": "25"}, False),
        ({"fields": "nextPageToken,drives(id,name)", "pageSize": "26"}, False),
        (
            {
                "fields": "nextPageToken,drives(id,name)",
                "pageSize": "25",
                "useDomainAdminAccess": "true",
            },
            False,
        ),
    ],
)
async def test_shared_drive_inventory_is_bounded_without_admin_authority(
    monkeypatch, params, allowed
):
    monkeypatch.setattr(
        adapter_module.httpx,
        "AsyncClient",
        lambda **_: (_ for _ in ()).throw(RuntimeError("admitted")),
    )
    with pytest.raises(RuntimeError, match="admitted" if allowed else "operation_not_allowed"):
        await adapter_module.GoogleDriveAdapter()._get_private(
            "/drives", access_token=GRANT, params=params, limit=adapter_module.METADATA_LIMIT
        )


@pytest.mark.parametrize(
    "payload",
    [
        {"files": [None]},
        {"files": [], "incompleteSearch": "false"},
        {"files": [], "nextPageToken": "x" * 1025},
    ],
)
async def test_bad_page_cannot_be_reported_as_complete_empty_results(monkeypatch, payload):
    drive = transport(
        adapter=SimpleNamespace(list_files=AsyncMock(return_value=payload)), monkeypatch=monkeypatch
    )
    with pytest.raises((DriveReadError, ExternalMcpError)) as raised:
        await drive.read_tool(
            user_id="owner", tool_name="search_files", arguments={"query": "name = 'Plan'"}
        )
    assert str(raised.value) in {"provider_response_invalid", "Invalid Drive listing."}


async def test_owner_index_changes_are_owner_search_only_and_keep_the_row_shape(monkeypatch):
    view = f"https://drive.google.com/file/d/{FILE_ID}/view"
    changes = AsyncMock(
        return_value={
            "changes": [
                {
                    "changeType": "file",
                    "fileId": FILE_ID,
                    "removed": False,
                    "file": {
                        "id": FILE_ID,
                        "name": "March statement.pdf",
                        "mimeType": "application/pdf",
                        "modifiedTime": "2026-09-20T10:00:00Z",
                        "createdTime": "2026-09-19T10:00:00Z",
                        "webViewLink": view,
                        "trashed": True,
                        "capabilities": {"canShare": True},
                    },
                },
                {"changeType": "file", "fileId": "removed-file", "removed": True},
                {"changeType": "drive", "removed": False},
            ],
            "newStartPageToken": "next-start",
        }
    )
    start = AsyncMock(return_value="start-cursor")
    drive = transport(
        adapter=SimpleNamespace(index_changes=changes, collection_start_token=start),
        monkeypatch=monkeypatch,
    )
    cursor = await drive.read_owner_search_page(
        user_id="owner", tool_name="changes_start_token", arguments={}
    )
    assert cursor.payload == {"startPageToken": "start-cursor"}
    page = await drive.read_owner_search_page(
        user_id="owner", tool_name="list_changes", arguments={"pageToken": "start-cursor"}
    )
    # The changed file has exactly the owner-search row shape.
    assert page.payload == {
        "changes": [
            {
                "changeType": "file",
                "fileId": FILE_ID,
                "removed": False,
                "trashed": True,
                "file": {
                    "id": FILE_ID,
                    "title": "March statement.pdf",
                    "mimeType": "application/pdf",
                    "modifiedTime": "2026-09-20T10:00:00Z",
                    "createdTime": "2026-09-19T10:00:00Z",
                    "viewUrl": view,
                    "capabilities": {"canShare": True},
                },
            },
            {"changeType": "file", "fileId": "removed-file", "removed": True, "trashed": False},
            {"changeType": "drive", "removed": False, "trashed": False},
        ],
        "nextPageToken": None,
        "newStartPageToken": "next-start",
    }
    changes.assert_awaited_once_with(
        access_token=GRANT, page_token=cursor.payload["startPageToken"], page_size=200
    )
    # Agent-facing reads cannot reach the change feed at all.
    for tool in ("list_changes", "changes_start_token"):
        with pytest.raises(DriveOAuthError, match="connector_unavailable"):
            await drive.read_tool(user_id="owner", tool_name=tool, arguments={})
    for arguments in (
        {},
        {"pageToken": "c", "pageSize": 1000},
        {"pageToken": "c", "fields": "*"},
        {"pageToken": ""},
    ):
        with pytest.raises(DriveOAuthError, match="invalid_argument"):
            await drive.read_owner_search_page(
                user_id="owner", tool_name="list_changes", arguments=arguments
            )
    with pytest.raises(DriveOAuthError, match="invalid_argument"):
        await drive.read_owner_search_page(
            user_id="owner", tool_name="changes_start_token", arguments={"pageToken": "c"}
        )
    assert changes.await_count == 1
    for bad in (
        {"changes": [], "nextPageToken": "a", "newStartPageToken": "b"},
        {"changes": []},
        {
            "changes": [{"changeType": "file", "fileId": "x", "file": {"id": "other"}}],
            "newStartPageToken": "b",
        },
    ):
        changes.return_value = bad
        with pytest.raises(DriveReadError, match="provider_response_invalid"):
            await drive.read_owner_search_page(
                user_id="owner", tool_name="list_changes", arguments={"pageToken": "start-cursor"}
            )
