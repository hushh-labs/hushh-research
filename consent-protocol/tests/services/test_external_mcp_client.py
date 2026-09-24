"""Structured MCP results take precedence; search metadata stays bounded."""

from types import SimpleNamespace

from hushh_mcp.services.external_mcp_client import _normalize_and_cap
from hushh_mcp.services.google_drive_mcp_service import _search_metadata


def test_structured_search_drops_large_irrelevant_fields_before_cap():
    result = SimpleNamespace(
        isError=False,
        structuredContent={
            "files": [
                {
                    "id": "file-1",
                    "title": "Recording",
                    "mimeType": "video/mp4",
                    "description": "x" * 40_000,
                    "viewUrl": "https://drive.google.com/open?id=file-1",
                }
            ]
        },
        content=[SimpleNamespace(text='{"files": []}')],
    )
    normalized = _normalize_and_cap(result, project=_search_metadata)
    assert normalized.truncated is False
    assert normalized.payload["files"] == [
        {
            "id": "file-1",
            "title": "Recording",
            "mimeType": "video/mp4",
            "viewUrl": "https://drive.google.com/open?id=file-1",
        }
    ]
