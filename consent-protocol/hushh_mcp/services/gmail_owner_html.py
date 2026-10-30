"""Small Gmail-owner rich-email sanitizer, independent from One Email KYC."""

from __future__ import annotations

import html
from html.parser import HTMLParser
from urllib.parse import urlparse

_ALLOWED_TAGS = frozenset(
    {"p", "br", "h1", "h2", "h3", "strong", "em", "u", "ul", "ol", "li", "blockquote", "a"}
)
_VOID_TAGS = frozenset({"br"})
_DISCARDED_TAGS = frozenset({"script", "style", "iframe", "object", "embed", "form", "svg", "math"})
_MAX_HTML_CHARS = 50_000
_BLOCK_STYLE_VALUES = {
    "h1": frozenset({"margin:0 0 18px;font-size:24px;line-height:1.25"}),
    "h2": frozenset({"margin:0 0 14px;font-size:20px;line-height:1.3"}),
    "h3": frozenset({"margin:0 0 12px;font-size:16px;line-height:1.4"}),
    "ul": frozenset({"margin:0 0 16px;padding-left:24px"}),
    "ol": frozenset({"margin:0 0 16px;padding-left:24px"}),
    "li": frozenset({"margin:0 0 8px"}),
    "blockquote": frozenset({"margin:0 0 16px;padding-left:16px;color:#5f6368"}),
}
_PARAGRAPH_STYLE = "margin:0 0 16px;line-height:1.6"


def _safe_href(value: str) -> str | None:
    href = value.strip()
    if not href or "\r" in href or "\n" in href:
        return None
    parsed = urlparse(href)
    if parsed.scheme not in {"http", "https", "mailto"}:
        return None
    if parsed.scheme in {"http", "https"} and not parsed.netloc:
        return None
    if parsed.scheme == "mailto" and not parsed.path:
        return None
    return href


def _safe_block_style(tag: str, value: str) -> str | None:
    normalized = " ".join(value.lower().split())
    normalized = normalized.replace(": ", ":").replace(" ;", ";").replace("; ", ";")
    if normalized in _BLOCK_STYLE_VALUES.get(tag, frozenset()):
        return normalized
    if tag == "p":
        if normalized == _PARAGRAPH_STYLE:
            return normalized
        for alignment in ("left", "center", "right"):
            if normalized == f"{_PARAGRAPH_STYLE};text-align:{alignment}":
                return normalized
            # Preserve the alignment-only input accepted before rich delivery styling.
            if normalized == f"text-align:{alignment}":
                return normalized
    return None


class _GmailOwnerHtmlSanitizer(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.discard_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag in _DISCARDED_TAGS:
            self.discard_depth += 1
            return
        if self.discard_depth or tag not in _ALLOWED_TAGS:
            return
        if tag == "a":
            href = next((value for name, value in attrs if name.lower() == "href" and value), None)
            safe_href = _safe_href(href) if href else None
            self.parts.append(
                f'<a href="{html.escape(safe_href, quote=True)}">' if safe_href else "<a>"
            )
            return
        if tag in {"p", "h1", "h2", "h3", "ul", "ol", "li", "blockquote"}:
            style = next(
                (value for name, value in attrs if name.lower() == "style" and value), None
            )
            safe_style = _safe_block_style(tag, style) if style else None
            if safe_style:
                self.parts.append(f'<{tag} style="{safe_style}">')
                return
        self.parts.append(f"<{tag}>")

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag.lower() not in _VOID_TAGS:
            self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in _DISCARDED_TAGS:
            self.discard_depth = max(0, self.discard_depth - 1)
            return
        if self.discard_depth or tag not in _ALLOWED_TAGS or tag in _VOID_TAGS:
            return
        self.parts.append(f"</{tag}>")

    def handle_data(self, data: str) -> None:
        if not self.discard_depth:
            self.parts.append(html.escape(data))


def sanitize_gmail_owner_html(value: object) -> str | None:
    """Return the restricted HTML reviewed by the Gmail owner, or no HTML.

    This is intentionally a neutral delivery leaf. It must not reuse the
    platform-mailbox KYC renderer or sanitizer because those belong to a
    separate One Email KYC workflow.
    """

    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("html_body must be a string")
    if len(value) > _MAX_HTML_CHARS:
        raise ValueError("html_body is too long")
    parser = _GmailOwnerHtmlSanitizer()
    try:
        parser.feed(value)
        parser.close()
    except Exception as exc:  # HTMLParser input failures are invalid owner input.
        raise ValueError("html_body is invalid") from exc
    sanitized = "".join(parser.parts).strip()
    if len(sanitized) > _MAX_HTML_CHARS:
        raise ValueError("html_body is too long")
    return sanitized or None
