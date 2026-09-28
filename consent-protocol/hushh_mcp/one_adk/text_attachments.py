"""Pasted text travels beside a user turn as its own document part.

The web client sends a long paste as an AG-UI ``document`` content part with
``mimeType: text/plain``. The agent bridge turns it into an ``inline_data``
part, so the sealed session stores it as its own part, next to the person's
typed text and never inside it.

Two projections read that part:

* the model sees it as a clearly delimited, named document, rendered on the
  outgoing request copy only, which works the same for any provider; and
* history returns it as attachment metadata, so the transcript restores a chip
  and not the expanded text.

Nothing here logs attachment content.
"""

from __future__ import annotations

import re
from typing import Any

TEXT_ATTACHMENT_MIME_TYPE = "text/plain"
PASTED_TEXT_ATTACHMENT_NAME = "Pasted text"

_CLOSE_TAG = "</attachment>"
_ESCAPED_CLOSE_TAG = "<\\/attachment>"
# The web client's line rule (``countTextLines``), so both sides agree.
_LINE_BREAK = re.compile(r"\r\n|\r|\n")


def _text_attachment_bytes(part: Any) -> bytes | None:
    blob = getattr(part, "inline_data", None)
    if blob is None or getattr(blob, "mime_type", None) != TEXT_ATTACHMENT_MIME_TYPE:
        return None
    data = getattr(blob, "data", None)
    return data if isinstance(data, bytes) else None


def _decode(data: bytes) -> str:
    return data.decode("utf-8", errors="replace")


def _count_lines(text: str) -> int:
    return len(_LINE_BREAK.split(text)) if text else 0


def render_text_attachments_for_model(llm_request: Any) -> int:
    """Present each pasted ``text/plain`` part to the model as a named document.

    Only user turns are rewritten. ADK builds ``llm_request.contents`` from
    shallow copies of session events, so replacing ``Part`` objects here leaves
    the sealed session untouched. A paste cannot close its own delimiter.
    Returns the number of parts rendered.
    """
    from google.genai import types

    contents = getattr(llm_request, "contents", None)
    if not isinstance(contents, list):
        return 0
    rendered = 0
    for content in contents:
        if getattr(content, "role", None) != "user":
            continue
        parts = getattr(content, "parts", None)
        if not isinstance(parts, list):
            continue
        next_parts = []
        changed = False
        for part in parts:
            data = _text_attachment_bytes(part)
            if data is None:
                next_parts.append(part)
                continue
            body = _decode(data).replace(_CLOSE_TAG, _ESCAPED_CLOSE_TAG)
            next_parts.append(
                types.Part(
                    text=(
                        f'<attachment name="{PASTED_TEXT_ATTACHMENT_NAME}" '
                        f'mime_type="{TEXT_ATTACHMENT_MIME_TYPE}">\n{body}\n{_CLOSE_TAG}'
                    )
                )
            )
            changed = True
            rendered += 1
        if changed:
            content.parts = next_parts
    return rendered


def history_text_attachments(event: Any) -> list[dict[str, Any]]:
    """Attachment metadata for a person's own turn, restored as a chip.

    History is read over the owner's chat-key channel and already returns the
    owner's typed text; the pasted text is the owner's own content at the same
    trust level, so it is returned for the chip's preview.
    """
    if getattr(event, "author", None) != "user":
        return []
    attachments: list[dict[str, Any]] = []
    for part in getattr(getattr(event, "content", None), "parts", None) or []:
        data = _text_attachment_bytes(part)
        if data is None:
            continue
        text = _decode(data)
        attachments.append(
            {
                "name": PASTED_TEXT_ATTACHMENT_NAME,
                "mimeType": TEXT_ATTACHMENT_MIME_TYPE,
                "text": text,
                "byteSize": len(data),
                "lineCount": _count_lines(text),
            }
        )
    return attachments
