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
        order_by="modifiedTime desc",
    )


def _file(file_id, *, modified, created="2026-09-01T00:00:00Z"):
    return {
        "id": file_id,
        "name": file_id,
        "mimeType": "application/pdf",
        "modifiedTime": modified,
        "createdTime": created,
        "webViewLink": f"https://drive.google.com/file/d/{file_id}/view",
    }


async def test_full_text_search_sends_no_order_and_sorts_the_page_locally(monkeypatch):
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
    assert [item["id"] for item in result.payload["files"]] == ["newest", "older", "undated"]
    assert result.payload["nextPageToken"] == "more"


async def test_full_text_search_honours_a_created_time_request_locally(monkeypatch):
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
    assert [item["id"] for item in result.payload["files"]] == ["b", "a"]


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
        rest, "parse_document", lambda *_: SimpleNamespace(pages=("first pages",), truncated=True)
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

    def refuse(content, mime_type):
        raise rest.ParseError(code)

    monkeypatch.setattr(rest, "parse_document", refuse)
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
        f"(name contains {literal} or fullText contains {literal})"
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
