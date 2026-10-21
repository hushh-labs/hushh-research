"""Adapters from the aid's ports to the live Drive reader and the embedding child.

Imported only where the aid is wired, so the rest of the package stays free of the
transport and the OAuth service chain. Neither adapter widens any authority: a head
is read through the same owner, grant and generation fence as every live read.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from hushh_mcp.services.drive_groups.text_head import HEAD_CHARS, capture_head
from hushh_mcp.services.google_drive_adapter import (
    LIVE_EXTRACTABLE_ORIGINAL_TYPES,
    DriveReadError,
)

# Outcomes that belong to one file. Anything else (rate limits, an unavailable
# parser, a changed grant) ends the run, so a systemic fault is never read as
# many files with no text.
_PER_FILE_CODES = frozenset(
    {
        "source_unavailable",
        "file_too_large",
        "unsupported_format",
        "invalid_document",
        "no_extractable_text",
        "encrypted_document",
    }
)


class TransportHeadSource:
    """Reads a file's text start through the fenced ``read_file_content`` tool."""

    def __init__(self, transport: Any, user_id: str, *, limit: int = HEAD_CHARS) -> None:
        self._transport, self._user_id, self._limit = transport, user_id, limit

    async def head(self, row: Mapping[str, Any]) -> str | None:
        file_id, mime = row.get("id"), row.get("mimeType")
        # No OCR: images and other types without a text layer are not read.
        if not isinstance(file_id, str) or mime not in LIVE_EXTRACTABLE_ORIGINAL_TYPES:
            return None
        try:
            result = await self._transport.read_tool(
                user_id=self._user_id,
                tool_name="read_file_content",
                arguments={"fileId": file_id},
            )
        except DriveReadError as error:
            if str(error) in _PER_FILE_CODES:
                return None
            raise
        text = result.payload.get("fileContent") if isinstance(result.payload, dict) else None
        return capture_head((text,), self._limit) if isinstance(text, str) else None


class IsolatedHeadEmbedder:
    """Embeds heads with the pinned E5 model in the isolated child, one call per batch."""

    def __init__(self, embedder: Any = None) -> None:
        from hushh_mcp.services.drive_document_processor import IsolatedDocumentEmbedding

        self._embedder = embedder or IsolatedDocumentEmbedding()

    async def embed(self, heads: Sequence[str]) -> list[tuple[float, ...] | None]:
        from hushh_mcp.services.drive_document_parser import ParsedText

        prepared = await self._embedder.prepare(ParsedText(tuple(heads), False))
        vectors: list[tuple[float, ...] | None] = [None] * len(heads)
        for chunk in prepared.chunks:
            # Each head is one page; a head the child had to split keeps its first chunk.
            if chunk.page is not None and vectors[chunk.page - 1] is None:
                vectors[chunk.page - 1] = chunk.embedding
        return vectors
