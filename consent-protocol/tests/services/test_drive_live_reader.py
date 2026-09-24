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
    adapter = SimpleNamespace(get_metadata=AsyncMock(return_value=metadata))

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
