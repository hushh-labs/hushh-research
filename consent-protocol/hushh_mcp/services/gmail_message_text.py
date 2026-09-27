"""Bounded plain-text projection of one Gmail ``format=full`` message payload.

A gene: pure, import-safe and provider-shape defensive. It prefers the
``text/plain`` alternative, falls back to readable text from ``text/html``,
skips attachments, and never follows links or interprets markup as anything
but text. The caller owns size limits for the model envelope.
"""

from __future__ import annotations

import base64
import binascii
import codecs
import re
from email.message import Message
from html.parser import HTMLParser
from typing import Any

_MAX_PARTS = 200
_MAX_DEPTH = 12
_BLOCK_TAGS = frozenset(
    {"br", "p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "table"}
)
_SKIPPED_TAGS = frozenset({"script", "style", "head", "title", "template", "noscript"})
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


class MessageTextError(ValueError):
    """The provider payload is not a well-formed message tree."""


class _HtmlText(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._chunks: list[str] = []
        self._skipping = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        del attrs  # Links, images and styles are never followed or surfaced.
        if tag in _SKIPPED_TAGS:
            self._skipping += 1
        elif tag in _BLOCK_TAGS:
            self._chunks.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in _SKIPPED_TAGS and self._skipping:
            self._skipping -= 1
        elif tag in _BLOCK_TAGS:
            self._chunks.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._skipping:
            self._chunks.append(data)

    def text(self) -> str:
        return "".join(self._chunks)


def _html_to_text(markup: str) -> str:
    parser = _HtmlText()
    try:
        parser.feed(markup)
        parser.close()
    except Exception:  # noqa: BLE001 - malformed provider HTML is just unreadable text
        return ""
    return parser.text()


def _charset(part: dict[str, Any]) -> str:
    headers = part.get("headers")
    if not isinstance(headers, list):
        return "utf-8"
    for header in headers:
        if (
            isinstance(header, dict)
            and str(header.get("name") or "").lower() == "content-type"
            and isinstance(header.get("value"), str)
        ):
            message = Message()
            message["content-type"] = header["value"][:512]
            charset = message.get_content_charset() or "utf-8"
            try:
                codecs.lookup(charset)
            except LookupError:
                return "utf-8"
            return charset
    return "utf-8"


def _decode(part: dict[str, Any]) -> str:
    body = part.get("body")
    if not isinstance(body, dict):
        return ""
    data = body.get("data")
    if not isinstance(data, str) or not data:
        return ""
    try:
        raw = base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))
    except (binascii.Error, ValueError):
        raise MessageTextError("invalid_body") from None
    return raw.decode(_charset(part), errors="replace")


def _normalize(text: str) -> str:
    text = _CONTROL.sub(" ", text.replace("\r\n", "\n").replace("\r", "\n"))
    lines = [" ".join(line.split()) for line in text.split("\n")]
    # Keep paragraph breaks readable without letting blank runs spend budget.
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def message_text(payload: Any) -> str:
    """Return the readable body of one message payload, or "" when it has none."""
    if not isinstance(payload, dict):
        raise MessageTextError("invalid_payload")
    plain: list[str] = []
    html: list[str] = []
    stack: list[tuple[Any, int]] = [(payload, 0)]
    visited = 0
    while stack:
        part, depth = stack.pop()
        visited += 1
        if not isinstance(part, dict) or visited > _MAX_PARTS or depth > _MAX_DEPTH:
            raise MessageTextError("invalid_payload")
        children = part.get("parts")
        if children is not None:
            if not isinstance(children, list):
                raise MessageTextError("invalid_payload")
            # Reversed onto a stack so parts are read in document order.
            stack.extend((child, depth + 1) for child in reversed(children))
            continue
        if part.get("filename"):
            continue  # An attachment, even a text one, is not the message body.
        mime_type = str(part.get("mimeType") or "").lower()
        if mime_type == "text/plain":
            plain.append(_decode(part))
        elif mime_type == "text/html":
            html.append(_html_to_text(_decode(part)))
    return _normalize("\n\n".join(plain if any(p.strip() for p in plain) else html))


def cap_utf8(text: str, maximum: int) -> tuple[str, bool]:
    """Cut on a UTF-8 boundary; report whether anything was dropped."""
    encoded = text.encode("utf-8")
    if len(encoded) <= maximum:
        return text, False
    return encoded[:maximum].decode("utf-8", errors="ignore").rstrip(), True
