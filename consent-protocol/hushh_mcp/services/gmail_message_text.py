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
from urllib.parse import urlsplit

_MAX_PARTS = 200
_MAX_DEPTH = 12
_BLOCK_TAGS = frozenset(
    {"br", "p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "table"}
)
_SKIPPED_TAGS = frozenset({"script", "style", "head", "title", "template", "noscript"})
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
_LINK_WHITESPACE = re.compile(r"[\x00-\x20\x7f]")


def _safe_mail_link(value: str | None) -> str | None:
    if not isinstance(value, str) or not 1 <= len(value) <= 1024 or _LINK_WHITESPACE.search(value):
        return None
    try:
        parsed = urlsplit(value)
        if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
            return None
        if parsed.username or parsed.password:
            return None
    except ValueError:
        return None
    # Parentheses would close a Markdown destination; encode them without
    # rewriting the remainder of the provider's original URL.
    return value.replace("(", "%28").replace(")", "%29")


def _markdown_link_label(value: str) -> str:
    return re.sub(r"([\\\[\]])", r"\\\1", " ".join(value.split())[:120])


class MessageTextError(ValueError):
    """The provider payload is not a well-formed message tree."""


class _HtmlText(HTMLParser):
    def __init__(self, *, preserve_links: bool = False) -> None:
        super().__init__(convert_charrefs=True)
        self._chunks: list[str] = []
        self._skipping = 0
        self._preserve_links = preserve_links
        self._anchors: list[tuple[str | None, int]] = []
        self.links: list[dict[str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in _SKIPPED_TAGS:
            self._skipping += 1
        elif self._skipping:
            return
        elif tag == "a" and self._preserve_links:
            href = next((value for name, value in attrs if name.lower() == "href"), None)
            self._anchors.append((_safe_mail_link(href), len(self._chunks)))
        elif tag in _BLOCK_TAGS:
            self._chunks.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in _SKIPPED_TAGS and self._skipping:
            self._skipping -= 1
        elif self._skipping:
            return
        elif tag == "a" and self._preserve_links and self._anchors:
            href, start = self._anchors.pop()
            label = _markdown_link_label("".join(self._chunks[start:]))
            if href and label and len(self.links) < 8:
                self._chunks[start:] = [f"[{label}]({href})"]
                self.links.append({"text": label, "url": href})
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


def _html_to_text_and_links(markup: str) -> tuple[str, list[dict[str, str]]]:
    """Keep bounded HTTP(S) anchors from a requested HTML body; never fetch them."""
    parser = _HtmlText(preserve_links=True)
    try:
        parser.feed(markup)
        parser.close()
    except Exception:  # noqa: BLE001 - malformed provider HTML is unreadable text
        return "", []
    return parser.text(), parser.links


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
