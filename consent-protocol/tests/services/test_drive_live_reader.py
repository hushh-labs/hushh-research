"""Live preparation works without a selected file or indexed chunk."""

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
    mcp.read_tool.side_effect = [
        ExternalMcpToolResult(
            False,
            {
                "files": [
                    {"id": f"file-{page}-{index}", "title": f"File {page}-{index}"}
                    for index in range(8)
                ],
                "nextPageToken": f"page-{page + 1}",
            },
            False,
        )
        for page in range(4)
    ]
    found = await reader.find(query=["File"])
    assert len(found["matches"]) == 25
    assert found["truncated"] is True
    assert mcp.read_tool.await_count == 4
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
