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


def _safe_alignment_style(value: str) -> str | None:
    normalized = "".join(value.lower().split())
    if normalized in {"text-align:left", "text-align:center", "text-align:right"}:
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
        if tag in {"p", "h1", "h2", "h3"}:
            style = next(
                (value for name, value in attrs if name.lower() == "style" and value), None
            )
            safe_style = _safe_alignment_style(style) if style else None
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
