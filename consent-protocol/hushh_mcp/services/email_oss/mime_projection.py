# SPDX-License-Identifier: GPL-3.0-only
"""Bounded MIME inventory and plain-text projection; no provider calls or policy."""

from __future__ import annotations

import base64
import binascii
from email.message import Message
from typing import Any

from hushh_mcp.services.gmail_message_text import _html_to_text, _normalize, cap_utf8

from .execution_types import (
    _MAX_BODY_BYTES,
    _MAX_DEPTH,
    _MAX_PARTS,
    _MAX_PAYLOAD_BYTES,
    GmailExecutionError,
    _attachment_identifier,
    _identifier,
    _payload,
)
from .vendor.agents_from_scratch.mime import extract_message_part
from .vendor.theposch.execution import decode_mime_header


def _part_fields(include_body: bool, depth: int = 0) -> str:
    # `format=metadata` omits the attachment tree. Full + a restrictive field
    # mask supplies inventory without downloading ANY body.data in list mode.
    body = "attachmentId,size,data" if include_body else "attachmentId,size"
    fields = f"mimeType,filename,headers(name,value),body({body})"
    if depth < _MAX_DEPTH:
        fields += f",parts({_part_fields(include_body, depth + 1)})"
    return fields


def _message_fields(include_body: bool) -> str:
    return "id,threadId,snippet,internalDate,labelIds,payload(" + _part_fields(include_body) + ")"


def _headers(message: dict) -> dict[str, str]:
    payload = message.get("payload", {})
    if not isinstance(payload, dict):
        raise GmailExecutionError("invalid_provider_response")
    headers = payload.get("headers", [])
    if not isinstance(headers, list) or len(headers) > 512:
        raise GmailExecutionError("invalid_provider_response")
    result = {}
    for header in headers:
        if not isinstance(header, dict):
            raise GmailExecutionError("invalid_provider_response")
        name, value = header.get("name"), header.get("value")
        if not isinstance(name, str) or not isinstance(value, str) or len(value) > 16384:
            raise GmailExecutionError("invalid_provider_response")
        result.setdefault(name.lower(), value)
    return result


def _decode_text_part(part, data, decode_part):
    if not isinstance(data, str) or len(data) > _MAX_PAYLOAD_BYTES:
        raise GmailExecutionError("response_too_large")
    try:
        # Validate padding/alphabet before the donor's exact UTF-8 decoder.
        raw = base64.b64decode(data + "=" * (-len(data) % 4), altchars=b"-_", validate=True)
        charset = "utf-8"
        for header in part.get("headers", []):
            if isinstance(header, dict) and str(header.get("name") or "").lower() == "content-type":
                content_type = Message()
                content_type["content-type"] = str(header.get("value") or "")
                charset = content_type.get_content_charset() or "utf-8"
                break
        try:
            utf8 = raw.decode(charset, errors="replace").encode("utf-8")
        except LookupError:
            utf8 = raw.decode("utf-8", errors="replace").encode("utf-8")
        safe_part = {"body": {"data": base64.urlsafe_b64encode(utf8).decode("ascii")}}
        decoded = decode_part(safe_part)
    except (ValueError, binascii.Error):
        raise GmailExecutionError("invalid_provider_response") from None
    return decoded


def _mime_projection(
    payload: Any, *, decode_body: bool, decode_part=extract_message_part
) -> tuple[list[dict], str, bool]:
    """Inventory every returned part; prefer plain alternatives; never fetch files."""
    attachments, plain, html = [], [], []
    stack = [(payload, 0, False)]
    visited = 0
    complete = True
    while stack:
        part, depth, parent_attachment = stack.pop()
        visited += 1
        if not isinstance(part, dict) or visited > _MAX_PARTS or depth > _MAX_DEPTH:
            raise GmailExecutionError("invalid_provider_response")
        body = part.get("body", {})
        if not isinstance(body, dict):
            raise GmailExecutionError("invalid_provider_response")
        mime_type = str(part.get("mimeType") or "application/octet-stream")
        filename = str(part.get("filename") or "")
        if len(filename) > 1024:
            raise GmailExecutionError("invalid_provider_response")
        disposition = next(
            (
                str(h.get("value") or "")
                for h in part.get("headers", [])
                if isinstance(h, dict) and str(h.get("name") or "").lower() == "content-disposition"
            ),
            "",
        )
        is_attachment = (
            parent_attachment or bool(filename) or disposition.lower().startswith("attachment")
        )
        attachment_id = body.get("attachmentId")
        if attachment_id or filename:
            if attachment_id is not None:
                _attachment_identifier(attachment_id)
            size = body.get("size", 0)
            if not isinstance(size, int) or size < 0:
                raise GmailExecutionError("invalid_provider_response")
            attachments.append(
                {
                    "attachment_id": attachment_id,
                    "filename": filename,
                    "mime_type": mime_type,
                    "size": size,
                }
            )
        parts = part.get("parts", [])
        if not isinstance(parts, list):
            raise GmailExecutionError("invalid_provider_response")
        if depth == _MAX_DEPTH and mime_type.startswith("multipart/"):
            complete = False  # The bounded provider field mask may omit deeper parts.
        stack.extend((child, depth + 1, is_attachment) for child in reversed(parts))
        data = body.get("data")
        if (
            not decode_body
            or is_attachment
            or not data
            or mime_type.lower() not in {"text/plain", "text/html"}
        ):
            continue
        decoded = _decode_text_part(part, data, decode_part)
        (plain if mime_type.lower() == "text/plain" else html).append(decoded)
    body = (
        "\n\n".join(plain)
        if any(x.strip() for x in plain)
        else "\n\n".join(_html_to_text(x) for x in html)
    )
    return attachments, _normalize(body), complete


def _project_message(value: Any, *, include_body: bool, decode_part=extract_message_part) -> dict:
    message = _payload(value)
    headers = _headers(message)
    attachments, body, complete = _mime_projection(
        message.get("payload", {}), decode_body=include_body, decode_part=decode_part
    )
    result = {
        "id": _identifier(message.get("id")),
        "thread_id": _identifier(message.get("threadId")),
        "subject": decode_mime_header(headers.get("subject", ""))[:512],
        "from": headers.get("from", "")[:1024],
        "to": headers.get("to", "")[:4096],
        "date": headers.get("date", "")[:256],
        "snippet": str(message.get("snippet") or "")[:512],
        "attachments": attachments,
        "attachment_inventory_complete": complete,
    }
    if include_body:
        result["body"], result["body_truncated"] = cap_utf8(body, _MAX_BODY_BYTES)
    return result
