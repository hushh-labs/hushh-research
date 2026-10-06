"""Receipt-only MIME fallback; no credentials, persistence or remote URL reads."""

from __future__ import annotations

from typing import Any

from hushh_mcp.services.gmail_message_text import message_text

MAX_PDF_BYTES = 512 * 1024


def receipt_parts(payload: Any) -> list[dict[str, Any]]:
    """Bound traversal independently of the provider's advertised message size."""
    result = []
    stack = [(payload, 0)]
    while stack and len(result) < 200:
        part, depth = stack.pop()
        if not isinstance(part, dict) or depth > 12:
            continue
        result.append(part)
        children = part.get("parts")
        if isinstance(children, list):
            stack.extend((child, depth + 1) for child in reversed(children[:200]))
    return result


def html_fallback(payload: Any) -> str:
    parts = [
        part
        for part in receipt_parts(payload)
        if part.get("mimeType") == "text/html" and not part.get("filename")
    ]
    return message_text({"parts": parts})


def pdf_candidates(payload: Any) -> list[dict[str, Any]]:
    # A transport prefilter, not receipt classification. The dedicated extractor
    # must still establish transaction evidence from any parsed document.
    candidates = []
    for part in receipt_parts(payload):
        filename = str(part.get("filename") or "").lower()
        body = part.get("body")
        if (
            part.get("mimeType") == "application/pdf"
            and any(word in filename for word in ("invoice", "receipt"))
            and isinstance(body, dict)
            and type(body.get("size")) is int
            and 0 < body["size"] <= MAX_PDF_BYTES
        ):
            candidates.append(body)
    return candidates[:1]
