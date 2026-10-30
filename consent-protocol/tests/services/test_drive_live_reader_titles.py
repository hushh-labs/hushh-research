"""Provider titles retain their original value at every live-reader boundary."""

from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.drive_document_processor import LocalDocumentProcessor
from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult
from hushh_mcp.services.google_drive_adapter import (
    METADATA_LIMIT,
    DriveReadError,
    valid_metadata_name,
)
from tests.services.test_drive_live_reader import _original_text_pdf, fixture


@pytest.mark.feature_drive_packets
@pytest.mark.trace_loop
@pytest.mark.asyncio
@pytest.mark.parametrize("entrypoint", ["find", "preview", "compilation", "visual"])
@pytest.mark.parametrize(
    "name,accepted",
    [
        ("N" * 1025 + ".pdf", True),
        ("अ" * 1500 + ".pdf", True),
        ("", False),
        (123, False),
        ("\ud800", False),
        ("अ" * (METADATA_LIMIT // 3 + 1), False),
    ],
    ids=["long-ascii", "long-unicode", "empty", "wrong-type", "invalid-unicode", "byte-limit"],
)
async def test_provider_title_boundary_preserves_original_across_reader_paths(
    entrypoint, name, accepted
):
    reader, adapter, mcp, fence = fixture()
    metadata = replace(adapter.get_metadata.return_value, name=name)
    adapter.get_metadata.return_value = adapter.get_share_metadata.return_value = metadata
    adapter.read_live_bytes = AsyncMock(
        return_value=("application/pdf", _original_text_pdf("Synthetic original body"))
    )
    reader.page_processor = LocalDocumentProcessor(scanner=SimpleNamespace(scan=AsyncMock()))
    match = {"file_id": "file-1", "name": name, "mime_type": "application/pdf"}
    assert valid_metadata_name(name) is accepted
    if entrypoint == "find":
        mcp.read_tool.side_effect = None
        mcp.read_tool.return_value = ExternalMcpToolResult(
            False,
            {"files": [{"id": "file-1", "title": name, "mimeType": "application/pdf"}]},
            False,
        )
        result = await reader.find(query=["statement"])
        assert result["truncated"] is not accepted
        assert [item["name"] for item in result["matches"]] == ([name] if accepted else [])
    elif entrypoint == "preview":
        result = await reader.bind_matches(
            matches=[match],
            time_field="modifiedTime",
            start_time="2026-03-01T00:00:00Z",
            end_time="2026-05-01T00:00:00Z",
        )
        assert result["truncated"] is not accepted
        assert [item["name"] for item in result["untrusted_external_content"]] == (
            [name] if accepted else []
        )
        assert [row["name"] for row in reader._rows] == ([name] if accepted else [])
        mcp.read_tool.assert_not_awaited()
    elif not accepted:
        method = (
            reader.read_compilation_match
            if entrypoint == "compilation"
            else reader.read_request_visual_pages
        )
        with pytest.raises(DriveReadError, match="provider_response_invalid"):
            await method(match=match)
        mcp.read_tool.assert_not_awaited()
    elif entrypoint == "compilation":
        source, body, incomplete = await reader.read_compilation_match(match=match)
        assert source.name == name and source.version == "11"
        assert body == "Statement period: March 2026" and incomplete is False
    else:
        source, pages, incomplete, fingerprint = await reader.read_request_visual_pages(match=match)
        assert source.name == name and source.version == "11"
        assert len(pages) == 1 and "Synthetic original body" in pages[0].text
        assert incomplete is False and len(fingerprint) == 64
        mcp.read_tool.assert_not_awaited()
    if not accepted:
        adapter.get_metadata.assert_not_awaited()
        adapter.get_share_metadata.assert_not_awaited()
        adapter.read_live_bytes.assert_not_awaited()
    else:
        assert fence.await_count >= 2


@pytest.mark.feature_drive_packets
@pytest.mark.trace_loop
@pytest.mark.asyncio
async def test_long_provider_title_does_not_expand_exact_title_input_authority():
    reader, _, mcp, _ = fixture()
    with pytest.raises(DriveReadError, match="narrow_selection_required"):
        await reader.find(query=[], exact_title="N" * 1025)
    mcp.read_tool.assert_not_awaited()
