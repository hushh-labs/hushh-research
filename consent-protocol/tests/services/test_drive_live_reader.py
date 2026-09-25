"""Live preparation works without a selected file or indexed chunk."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.drive_live_reader import DriveLiveReader
from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult
from hushh_mcp.services.google_drive_adapter import LIVE_POLICY_HASH, DriveMetadata, DriveReadError


def fixture():
    row = {
        "status": "connected",
        "validation_state": "verified",
        "verified_policy_hash": LIVE_POLICY_HASH,
        "connection_generation": 7,
    }
    oauth = SimpleNamespace(
        current_credential=AsyncMock(return_value=(row, {"accessToken": "synthetic"}))
    )
    metadata = DriveMetadata(
        "file-1", "March statement.pdf", "application/pdf", "11", "2026-04-01T00:00:00Z", 100, None
    )
    adapter = SimpleNamespace(
        get_metadata=AsyncMock(return_value=metadata),
        get_share_metadata=AsyncMock(return_value=metadata),
    )

    async def read(*, user_id, tool_name, arguments):
        assert user_id == "owner"
        if tool_name == "search_files":
            assert (
                arguments["query"]
                == "(title contains 'statement' or fullText contains 'statement')"
            )
            return ExternalMcpToolResult(False, {"files": [{"id": "file-1"}]}, False)
        assert tool_name == "read_file_content" and arguments == {"fileId": "file-1"}
        return ExternalMcpToolResult(False, {"fileContent": "Statement period: March 2026"}, False)

    mcp = SimpleNamespace(read_tool=AsyncMock(side_effect=read))
    fence = AsyncMock()
    reader = DriveLiveReader(
        user_id="owner", require_access=fence, oauth=oauth, mcp=mcp, adapter=adapter
    )
    return reader, adapter, mcp, fence


@pytest.mark.asyncio
async def test_live_search_reads_without_indexing_and_fences_source():
    reader, adapter, mcp, fence = fixture()
    result = await reader.search(query=["statement"])
    assert len(result["untrusted_external_content"]) == 1
    assert result["untrusted_external_content"][0]["text"] == "Statement period: March 2026"
    assert result["truncated"] is False
    assert len(reader._rows) == 1
    assert reader._rows[0]["source_version"] == "11"
    assert len(reader._rows[0]["content_fingerprint"]) == 64
    assert all(
        call.kwargs["require_app_authorized"] is False
        for call in adapter.get_metadata.await_args_list
    )
    assert mcp.read_tool.await_count == 2
    assert fence.await_count >= 4


@pytest.mark.asyncio
async def test_changed_source_fails_before_review_publication():
    reader, adapter, _, _ = fixture()
    await reader.search(query=["statement"])
    adapter.get_metadata.return_value = DriveMetadata(
        "file-1",
        "March statement.pdf",
        "application/pdf",
        "12",
        "2026-04-01T00:00:00Z",
        100,
        None,
    )
    with pytest.raises(DriveReadError, match="source_changed"):
        await reader.require_current()


@pytest.mark.asyncio
async def test_invalid_model_search_terms_never_reach_provider():
    reader, _, mcp, _ = fixture()
    with pytest.raises(DriveReadError, match="narrow_selection_required"):
        await reader.search(query=["statement' or name contains 'secret"])
    mcp.read_tool.assert_not_awaited()


@pytest.mark.asyncio
async def test_empty_text_cannot_become_a_complete_suggestion():
    reader, _, mcp, _ = fixture()
    mcp.read_tool.side_effect = None
    mcp.read_tool.side_effect = [
        ExternalMcpToolResult(False, {"files": [{"id": "file-1"}]}, False),
        ExternalMcpToolResult(False, {"fileContent": "  "}, False),
    ]
    result = await reader.search(query=["statement"])
    assert result["truncated"] is True
    assert result["untrusted_external_content"] == []


@pytest.mark.asyncio
async def test_find_returns_video_and_folder_without_reading_content_or_index():
    reader, adapter, mcp, _ = fixture()
    mcp.read_tool.side_effect = [
        ExternalMcpToolResult(
            False,
            {
                "files": [
                    {
                        "id": "video-1",
                        "title": "Board recording.mp4",
                        "mimeType": "video/mp4",
                        "modifiedTime": "2026-09-23T10:00:00Z",
                        "viewUrl": "https://drive.google.com/file/d/video-1/view?resourcekey=0-abc",
                    }
                ],
                "nextPageToken": "next",
            },
            False,
        ),
        ExternalMcpToolResult(
            False,
            {
                "files": [
                    {
                        "id": "folder-1",
                        "title": "Board folder",
                        "mimeType": "application/vnd.google-apps.folder",
                    },
                    {
                        "id": "file-2",
                        "title": "Untyped file",
                        "viewUrl": "https://evil.invalid/fake",
                    },
                ],
            },
            False,
        ),
    ]
    found = await reader.find(query=["Board"])
    assert [item["name"] for item in found["matches"]] == [
        "Board recording.mp4",
        "Board folder",
        "Untyped file",
    ]
    assert found["matches"][0]["open_url"] == (
        "https://drive.google.com/file/d/video-1/view?resourcekey=0-abc"
    )
    assert found["matches"][2]["open_url"] == "https://drive.google.com/open?id=file-2"
    assert found["matches"][2]["mime_type"] == ""
    assert found["truncated"] is False
    assert mcp.read_tool.await_args_list[1].kwargs["arguments"]["pageToken"] == "next"
    adapter.get_metadata.assert_not_awaited()
    assert reader._rows == []


@pytest.mark.asyncio
async def test_find_caps_results_within_the_last_page():
    reader, adapter, mcp, _ = fixture()
    mcp.read_tool.side_effect = None
    mcp.read_tool.return_value = ExternalMcpToolResult(
        False,
        {
            "files": [{"id": f"file-{index}", "title": f"File {index}"} for index in range(25)],
            "nextPageToken": "more-results",
        },
        False,
    )
    found = await reader.find(query=["File"])
    assert len(found["matches"]) == 25
    assert found["truncated"] is True
    assert mcp.read_tool.await_count == 1
    assert mcp.read_tool.await_args.kwargs["arguments"]["pageSize"] == 25
    adapter.get_metadata.assert_not_awaited()


@pytest.mark.asyncio
async def test_read_matches_reads_only_chosen_file_and_rechecks_name():
    reader, adapter, mcp, _ = fixture()
    chosen = [{"file_id": "file-1", "name": "March statement.pdf"}]
    result = await reader.read_matches(matches=chosen)
    assert result["untrusted_external_content"][0]["text"] == "Statement period: March 2026"
    assert mcp.read_tool.await_count == 1
    assert mcp.read_tool.await_args.kwargs["tool_name"] == "read_file_content"
    adapter.get_metadata.return_value = DriveMetadata(
        "file-1", "Renamed.pdf", "application/pdf", "11", "2026-04-01T00:00:00Z", 100, None
    )
    with pytest.raises(DriveReadError, match="source_changed"):
        await reader.read_matches(matches=chosen)


@pytest.mark.asyncio
async def test_date_only_find_uses_bounded_provider_metadata_search():
    reader, adapter, mcp, _ = fixture()
    mcp.read_tool.side_effect = [
        ExternalMcpToolResult(
            False,
            {
                "files": [
                    {"id": "file-1", "title": "Recent.pdf", "modifiedTime": "2026-09-23T10:00:00Z"}
                ]
            },
            False,
        )
    ]
    result = await reader.find(
        query=[],
        time_field="modifiedTime",
        start_time="2026-09-22T00:00:00Z",
        end_time="2026-09-24T00:00:00Z",
    )
    assert [row["name"] for row in result["matches"]] == ["Recent.pdf"]
    assert mcp.read_tool.await_args.kwargs["arguments"]["query"] == (
        "(modifiedTime >= '2026-09-22T00:00:00Z' and modifiedTime < '2026-09-24T00:00:00Z')"
    )
    assert mcp.read_tool.await_args.kwargs["arguments"]["excludeContentSnippets"] is True
    adapter.get_metadata.assert_not_awaited()


@pytest.mark.asyncio
async def test_date_filter_combines_with_terms_in_read_search():
    reader, _, mcp, _ = fixture()
    mcp.read_tool.side_effect = [
        ExternalMcpToolResult(False, {"files": [{"id": "file-1"}]}, False),
        ExternalMcpToolResult(False, {"fileContent": "Statement period: March 2026"}, False),
    ]
    result = await reader.search(
        query=["statement"],
        time_field="createdTime",
        start_time="2026-03-01T00:00:00Z",
        end_time="2026-05-01T00:00:00Z",
    )
    assert result["untrusted_external_content"][0]["text"] == "Statement period: March 2026"
    assert mcp.read_tool.await_args_list[0].kwargs["arguments"]["query"] == (
        "(title contains 'statement' or fullText contains 'statement') "
        "and (createdTime >= '2026-03-01T00:00:00Z' "
        "and createdTime < '2026-05-01T00:00:00Z')"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "field,start,end",
    [
        ("viewedByMeTime", "2026-09-22T00:00:00Z", "2026-09-24T00:00:00Z"),
        ("modifiedTime", "2026-09-24T00:00:00Z", "2026-09-22T00:00:00Z"),
        ("modifiedTime", "2026-09-24T00:00:00Z", "2026-09-24T00:00:00Z"),
        ("modifiedTime", "2026-13-22T00:00:00Z", "2026-09-24T00:00:00Z"),
        ("modifiedTime", "2026-09-22T00:00:00+05:30", "2026-09-24T00:00:00Z"),
        ("modifiedTime", "2026-09-22T00:00:00Z", None),
    ],
)
async def test_invalid_date_bounds_never_reach_provider(field, start, end):
    reader, _, mcp, _ = fixture()
    with pytest.raises(DriveReadError, match="narrow_selection_required"):
        await reader.find(query=[], time_field=field, start_time=start, end_time=end)
    mcp.read_tool.assert_not_awaited()


@pytest.mark.asyncio
async def test_bind_matches_uses_current_metadata_without_reading_file_content():
    reader, adapter, mcp, _ = fixture()
    adapter.get_share_metadata.return_value = DriveMetadata(
        "file-1", "Recent.pdf", "application/pdf", "11", "2026-09-23T10:00:00Z", 100, None
    )
    matches = [{"file_id": "file-1", "name": "Recent.pdf", "mime_type": "application/pdf"}]
    result = await reader.bind_matches(
        matches=matches,
        time_field="modifiedTime",
        start_time="2026-09-22T00:00:00Z",
        end_time="2026-09-24T00:00:00Z",
    )
    assert result["truncated"] is False
    assert result["untrusted_external_content"][0]["metadata_only"] is True
    assert reader._rows[0]["source_version"] == "11"
    assert reader._rows[0]["connection_generation"] == 7
    assert reader._rows[0]["content_fingerprint"] is None
    assert reader._rows[0]["metadata_only"] is True
    assert reader._rows[0]["time_field"] == "modifiedTime"
    assert reader._rows[0]["start_time"] == "2026-09-22T00:00:00Z"
    assert reader._rows[0]["end_time"] == "2026-09-24T00:00:00Z"
    mcp.read_tool.assert_not_awaited()
    assert adapter.get_share_metadata.await_count == 2
    adapter.get_metadata.assert_not_awaited()


@pytest.mark.asyncio
async def test_metadata_only_binding_survives_a_version_bump_but_not_a_rename():
    """Sharing a file with one person bumps its Drive version; the next person's
    share of the same file must still bind. A rename is a different file choice."""
    reader, adapter, _, _ = fixture()

    def metadata(name, version):
        return DriveMetadata(
            "file-1", name, "application/pdf", version, "2026-09-23T10:00:00Z", 100, None
        )

    adapter.get_share_metadata.return_value = metadata("Recent.pdf", "11")
    await reader.bind_matches(
        matches=[{"file_id": "file-1", "name": "Recent.pdf", "mime_type": "application/pdf"}],
        time_field="modifiedTime",
        start_time="2026-09-22T00:00:00Z",
        end_time="2026-09-24T00:00:00Z",
    )
    adapter.get_share_metadata.return_value = metadata("Recent.pdf", "12")
    await reader.require_current()
    adapter.get_share_metadata.return_value = metadata("Renamed.pdf", "12")
    with pytest.raises(DriveReadError, match="source_changed"):
        await reader.require_current()


@pytest.mark.asyncio
async def test_bind_matches_excludes_folder_and_changed_date_from_complete_preview():
    reader, adapter, mcp, _ = fixture()
    adapter.get_share_metadata.return_value = DriveMetadata(
        "file-1", "Old.pdf", "application/pdf", "11", "2026-09-20T10:00:00Z", 100, None
    )
    result = await reader.bind_matches(
        matches=[
            {
                "file_id": "folder-1",
                "name": "Folder",
                "mime_type": "application/vnd.google-apps.folder",
            },
            {"file_id": "file-1", "name": "Old.pdf", "mime_type": "application/pdf"},
        ],
        time_field="modifiedTime",
        start_time="2026-09-22T00:00:00Z",
        end_time="2026-09-24T00:00:00Z",
    )
    assert result == {"untrusted_external_content": [], "truncated": True}
    assert reader._rows == []
    assert adapter.get_share_metadata.await_count == 1
    adapter.get_metadata.assert_not_awaited()
    mcp.read_tool.assert_not_awaited()


@pytest.mark.asyncio
async def test_bind_matches_can_preview_shareable_video_by_created_time():
    reader, adapter, mcp, _ = fixture()
    adapter.get_share_metadata.return_value = DriveMetadata(
        "video-1",
        "Recording.mp4",
        "video/mp4",
        "12",
        "2026-09-24T10:00:00Z",
        1234,
        None,
        "2026-09-23T10:00:00Z",
    )
    result = await reader.bind_matches(
        matches=[{"file_id": "video-1", "name": "Recording.mp4", "mime_type": "video/mp4"}],
        time_field="createdTime",
        start_time="2026-09-22T00:00:00Z",
        end_time="2026-09-24T00:00:00Z",
    )
    assert result["truncated"] is False
    assert reader._rows[0]["file_id"] == "video-1"
    assert reader._rows[0]["source_version"] == "12"
    assert adapter.get_share_metadata.await_count == 2
    adapter.get_metadata.assert_not_awaited()
    mcp.read_tool.assert_not_awaited()


@pytest.mark.asyncio
async def test_metadata_preview_rechecks_date_when_file_changes_before_review():
    reader, adapter, _, _ = fixture()
    adapter.get_share_metadata.return_value = DriveMetadata(
        "file-1", "Recent.pdf", "application/pdf", "11", "2026-09-23T10:00:00Z", 100, None
    )
    await reader.bind_matches(
        matches=[{"file_id": "file-1", "name": "Recent.pdf", "mime_type": "application/pdf"}],
        time_field="modifiedTime",
        start_time="2026-09-22T00:00:00Z",
        end_time="2026-09-24T00:00:00Z",
    )
    adapter.get_share_metadata.return_value = DriveMetadata(
        "file-1", "Recent.pdf", "application/pdf", "11", "2026-09-24T00:00:00Z", 100, None
    )
    with pytest.raises(DriveReadError, match="source_changed"):
        await reader.require_current()


@pytest.mark.asyncio
async def test_a_search_with_no_matches_is_an_empty_answer_not_a_failure():
    from hushh_mcp.services.google_drive_mcp_service import _search_metadata

    reader, _, mcp, _ = fixture()
    mcp.read_tool.side_effect = None
    mcp.read_tool.return_value = ExternalMcpToolResult(False, _search_metadata({}), False)
    found = await reader.find(query=["statement"])
    assert found == {"matches": [], "truncated": False}


def three_file_reader(read_payloads, metadata_errors=None):
    reader, adapter, mcp, _ = fixture()
    names = {"file-1": "March statement.pdf", "file-2": "Locked.pdf", "file-3": "Huge.pdf"}
    metadata_errors = metadata_errors or {}

    async def metadata(*, file_id, **_):
        if file_id in metadata_errors:
            raise DriveReadError(metadata_errors[file_id])
        return DriveMetadata(
            file_id, names[file_id], "application/pdf", "11", "2026-04-01T00:00:00Z", 100, None
        )

    async def read(*, user_id, tool_name, arguments):
        return ExternalMcpToolResult(False, read_payloads[arguments["fileId"]], False)

    adapter.get_metadata.side_effect = metadata
    mcp.read_tool.side_effect = read
    matches = [
        {"file_id": file_id, "name": name, "source_ref": f"document:{index:032d}"}
        for index, (file_id, name) in enumerate(names.items(), 1)
    ]
    return reader, mcp, matches


@pytest.mark.asyncio
async def test_unreadable_files_are_reported_with_a_reason():
    reader, _, matches = three_file_reader(
        {
            "file-1": {"fileContent": "Statement period: March 2026"},
            "file-2": {"textFormattingNotSupported": True, "reason": "encrypted_document"},
        },
        metadata_errors={"file-3": "file_too_large"},
    )
    result = await reader.read_matches(matches=matches)
    assert result["unreadable"] == [
        {
            "name": "Locked.pdf",
            "reason": "encrypted_document",
            "source_ref": matches[1]["source_ref"],
        },
        {"name": "Huge.pdf", "reason": "file_too_large", "source_ref": matches[2]["source_ref"]},
    ]
    assert result["truncated"] is True
    assert len(result["untrusted_external_content"]) == 1
    assert len(reader._rows) == 1


@pytest.mark.asyncio
async def test_live_reads_overlap_by_two_but_publish_in_search_order():
    reader, mcp, matches = three_file_reader(
        {file_id: {"fileContent": file_id} for file_id in ("file-1", "file-2", "file-3")}
    )
    release = asyncio.Event()
    two_started = asyncio.Event()
    started: list[str] = []
    active = 0
    max_active = 0

    async def read(*, user_id, tool_name, arguments):
        nonlocal active, max_active
        file_id = arguments["fileId"]
        started.append(file_id)
        active += 1
        max_active = max(max_active, active)
        if len(started) == 2:
            two_started.set()
        try:
            await release.wait()
            return ExternalMcpToolResult(False, {"fileContent": file_id}, False)
        finally:
            active -= 1

    mcp.read_tool.side_effect = read
    progress: list[tuple[int, int]] = []
    task = asyncio.create_task(
        reader.read_matches(matches=matches, on_progress=lambda *p: progress.append(p))
    )
    try:
        await asyncio.wait_for(two_started.wait(), timeout=1)
        assert started == ["file-1", "file-2"]
        assert max_active == 2
    finally:
        release.set()
    result = await asyncio.wait_for(task, timeout=1)
    assert [item["name"] for item in result["untrusted_external_content"]] == [
        item["name"] for item in matches
    ]
    assert [row["file_id"] for row in reader._rows] == [item["file_id"] for item in matches]
    assert max_active == 2
    assert progress == [(1, 3), (2, 3), (3, 3)]


@pytest.mark.asyncio
async def test_fatal_live_read_cancels_sibling_and_keeps_no_partial_observations():
    reader, mcp, matches = three_file_reader(
        {file_id: {"fileContent": file_id} for file_id in ("file-1", "file-2", "file-3")}
    )
    sibling_started = asyncio.Event()
    sibling_cancelled = asyncio.Event()
    started: list[str] = []

    async def read(*, user_id, tool_name, arguments):
        file_id = arguments["fileId"]
        started.append(file_id)
        if file_id == "file-1":
            await sibling_started.wait()
            raise DriveReadError("source_changed")
        if file_id == "file-2":
            sibling_started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                sibling_cancelled.set()
                raise
        raise AssertionError("third read must not start after a fatal error")

    mcp.read_tool.side_effect = read
    progress: list[tuple[int, int]] = []
    with pytest.raises(DriveReadError, match="source_changed"):
        await asyncio.wait_for(
            reader.read_matches(matches=matches, on_progress=lambda *p: progress.append(p)),
            timeout=1,
        )
    assert sibling_cancelled.is_set()
    assert started == ["file-1", "file-2"]
    assert reader._rows == []
    assert progress == []


@pytest.mark.asyncio
async def test_cancelled_live_read_drains_active_siblings_and_clears_partial_rows():
    reader, mcp, matches = three_file_reader(
        {file_id: {"fileContent": file_id} for file_id in ("file-1", "file-2", "file-3")}
    )
    both_waiting = asyncio.Event()
    waiting: set[str] = set()
    cancelled: set[str] = set()

    async def read(*, user_id, tool_name, arguments):
        file_id = arguments["fileId"]
        if file_id == "file-1":
            return ExternalMcpToolResult(False, {"fileContent": file_id}, False)
        waiting.add(file_id)
        if waiting == {"file-2", "file-3"}:
            both_waiting.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.add(file_id)
            raise

    mcp.read_tool.side_effect = read
    progress: list[tuple[int, int]] = []
    task = asyncio.create_task(
        reader.read_matches(matches=matches, on_progress=lambda *p: progress.append(p))
    )
    try:
        await asyncio.wait_for(both_waiting.wait(), timeout=1)
        assert len(reader._rows) == 1
        assert reader._rows[0]["file_id"] == "file-1"
    finally:
        task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, timeout=1)
    assert cancelled == {"file-2", "file-3"}
    assert reader._rows == []
    assert progress == [(1, 3)]


@pytest.mark.asyncio
async def test_access_loss_after_content_is_fatal_not_an_unreadable_file():
    reader, _, _, fence = fixture()
    fence.side_effect = [None, None, DriveReadError("source_unavailable")]
    with pytest.raises(DriveReadError, match="source_unavailable"):
        await reader.read_matches(matches=[{"file_id": "file-1", "name": "March statement.pdf"}])
    assert reader._rows == []


@pytest.mark.asyncio
async def test_unreadable_progress_is_count_only_and_callback_failure_is_nonfatal():
    reader, _, matches = three_file_reader(
        {
            "file-1": {"fileContent": "Readable"},
            "file-2": {"textFormattingNotSupported": True, "reason": "encrypted_document"},
            "file-3": {"fileContent": "Readable too"},
        }
    )
    progress: list[tuple[int, int]] = []

    def report(completed: int, total: int) -> None:
        progress.append((completed, total))
        if completed == 2:
            raise RuntimeError("UI closed")

    result = await reader.read_matches(matches=matches, on_progress=report)
    assert progress == [(1, 3), (2, 3), (3, 3)]
    assert [item["name"] for item in result["untrusted_external_content"]] == [
        matches[0]["name"],
        matches[2]["name"],
    ]
    assert result["unreadable"][0]["name"] == matches[1]["name"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("payload", "reason"),
    [
        ({"fileContent": "   "}, "no_extractable_text"),
        ({"textFormattingNotSupported": True}, "unsupported_format"),
        # A reason outside the allowlist is never passed through.
        ({"textFormattingNotSupported": True, "reason": "PRIVATE detail"}, "unsupported_format"),
        (
            {"textFormattingNotSupported": True, "reason": "no_extractable_text"},
            "no_extractable_text",
        ),
    ],
)
async def test_each_unreadable_file_carries_one_allowlisted_reason(payload, reason):
    reader, _, matches = three_file_reader({"file-1": payload})
    result = await reader.read_matches(matches=matches[:1])
    assert result["unreadable"] == [
        {"name": "March statement.pdf", "reason": reason, "source_ref": matches[0]["source_ref"]}
    ]
    assert result["untrusted_external_content"] == [] and result["truncated"] is True


@pytest.mark.asyncio
async def test_a_readable_turn_reports_no_unreadable_files():
    reader, _, _, _ = fixture()
    result = await reader.read_matches(
        matches=[{"file_id": "file-1", "name": "March statement.pdf"}]
    )
    assert result["unreadable"] == []


def statements_reader(count, text):
    reader, adapter, mcp, _ = fixture()
    names = {f"file-{index}": f"Statement {index:02d}.pdf" for index in range(1, count + 1)}

    async def metadata(*, file_id, **_):
        return DriveMetadata(
            file_id, names[file_id], "application/pdf", "11", "2026-04-01T00:00:00Z", 100, None
        )

    adapter.get_metadata.side_effect = metadata
    mcp.read_tool.side_effect = None
    mcp.read_tool.return_value = ExternalMcpToolResult(False, {"fileContent": text}, False)
    return reader, [{"file_id": file_id, "name": name} for file_id, name in names.items()]


@pytest.mark.asyncio
@pytest.mark.parametrize("unit", ["A", "क"])  # one byte and three bytes in UTF-8
async def test_six_statements_all_reach_the_model_with_a_fair_share_each(unit):
    """UAT 2026-09-25: 'last six months of statements' read three files in full
    and dropped the rest at the 16 KiB context budget."""
    import json

    from hushh_mcp.services.drive_live_reader import MAX_CONTEXT_BYTES

    reader, matches = statements_reader(6, "Statement period March 2026. " + unit * 6000)
    result = await reader.read_matches(matches=matches)
    content = result["untrusted_external_content"]
    assert [item["name"] for item in content] == [item["name"] for item in matches]
    assert all(item["text"].startswith("Statement period March 2026.") for item in content)
    assert len(json.dumps(content, ensure_ascii=False).encode()) <= MAX_CONTEXT_BYTES
    assert result["truncated"] is True and len(reader._rows) == 6


@pytest.mark.asyncio
async def test_one_file_still_gets_the_full_excerpt():
    reader, matches = statements_reader(1, "A" * 6000)
    result = await reader.read_matches(matches=matches)
    assert len(result["untrusted_external_content"][0]["text"]) == 4000


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("count", "text", "name_length"),
    [
        # Review 2026-09-25: a Hindi header over English lines overshot a
        # proportional clip, so only three of six statements were kept.
        (6, "क" * 1500 + "Txn 2026-01-02 UPI 450.00\n" * 200, 12),
        (8, "\x01" * 1000 + "A" * 4000, 12),
        (8, "A" * 6000, 240),
    ],
    ids=["hindi-header-six", "control-chars-eight", "long-names-eight"],
)
async def test_mixed_bytes_and_long_names_still_fit_every_chosen_file(count, text, name_length):
    import json

    from hushh_mcp.services.drive_live_reader import MAX_CONTEXT_BYTES

    reader, matches = statements_reader(count, text)
    names = {
        item["file_id"]: "N" * (name_length - 7) + f"-{index:02d}.pdf"
        for index, item in enumerate(matches)
    }

    async def metadata(*, file_id, **_):
        return DriveMetadata(
            file_id, names[file_id], "application/pdf", "11", "2026-04-01T00:00:00Z", 100, None
        )

    reader.adapter.get_metadata.side_effect = metadata
    for item in matches:
        item["name"] = names[item["file_id"]]
    result = await reader.read_matches(matches=matches)
    content = result["untrusted_external_content"]
    assert len(content) == count
    assert all(item["text"] for item in content)
    assert len(json.dumps(content, ensure_ascii=False).encode()) <= MAX_CONTEXT_BYTES


@pytest.mark.asyncio
async def test_an_unreadable_file_leaves_its_share_to_the_others():
    reader, matches = statements_reader(8, "S" * 6000)
    locked = {item["file_id"] for item in matches[:5]}

    async def read(*, user_id, tool_name, arguments):
        if arguments["fileId"] in locked:
            return ExternalMcpToolResult(
                False, {"textFormattingNotSupported": True, "reason": "encrypted_document"}, False
            )
        return ExternalMcpToolResult(False, {"fileContent": "S" * 6000}, False)

    reader.mcp.read_tool.side_effect = read
    result = await reader.read_matches(matches=matches)
    texts = [item["text"] for item in result["untrusted_external_content"]]
    # Five locked files leave their share: the three readable ones keep the
    # full excerpt instead of an eighth of the budget each.
    assert [len(text) for text in texts] == [4000, 4000, 4000]
