"""Presentation-only, tokenless Instagram oEmbed for public post and Reel URLs.

The returned HTML may only be rendered as an isolated front-end embed. Do not
persist, mine, or enrich it. Meta's current guide shows a tokenless request;
its older oEmbed Read feature page still describes App Review and business
verification for live access, so production eligibility needs confirmation.

Official sources, checked 2026-10-07:
https://developers.facebook.com/documentation/instagram-platform/oembed.md
https://developers.facebook.com/docs/features-reference/oembed-read/
https://developers.facebook.com/docs/graph-api/reference/instagram-oembed/
"""

from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urlsplit

import httpx

GRAPH_ENDPOINT = "https://graph.facebook.com/v25.0/instagram_oembed"
_POST_PATH = re.compile(r"^/(p|reel)/([A-Za-z0-9_-]{1,64})/?$")
_MAX_RESPONSE_BYTES = 128_000
_MAX_HTML_BYTES = 100_000
_EMBED_TAGS = frozenset({"blockquote", "div", "a", "p", "span", "br", "svg", "g", "path"})


class InstagramOEmbedError(RuntimeError):
    """Safe error code without provider response, URL, or credential material."""

    def __init__(self, code: str, *, status_code: int = 400) -> None:
        super().__init__(code)
        self.status_code = status_code


def canonical_post_url(value: str) -> str:
    """Accept documented public post URL shapes; discard sharing parameters."""
    if not isinstance(value, str) or len(value) > 2048 or any(ord(c) <= 32 for c in value):
        raise InstagramOEmbedError("invalid_post_url")
    try:
        parts = urlsplit(value)
        match = _POST_PATH.fullmatch(parts.path)
        if (
            parts.scheme != "https"
            or parts.hostname not in {"instagram.com", "www.instagram.com"}
            or parts.port not in {None, 443}
            or parts.username
            or parts.password
            or parts.fragment
            or "\\" in value
            or match is None
        ):
            raise InstagramOEmbedError("invalid_post_url")
    except ValueError:
        raise InstagramOEmbedError("invalid_post_url") from None
    return f"https://www.instagram.com/{match.group(1)}/{match.group(2)}/"


class _EmbedMarkupValidator(HTMLParser):
    """Reject active markup; clients must still use an isolated iframe."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.valid = True
        self.nodes = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.nodes += 1
        if tag not in _EMBED_TAGS or self.nodes > 2_000:
            self.valid = False
        for name, value in attrs:
            name = name.lower()
            if name.startswith("on") or name in {"srcdoc", "formaction"}:
                self.valid = False
            if (
                name == "style"
                and value
                and re.search(r"url\s*\(|expression\s*\(|@import|behavior\s*:", value, re.I)
            ):
                self.valid = False
            if name in {"href", "src", "xlink:href", "data-instgrm-permalink"}:
                try:
                    parts = urlsplit(value or "")
                    if (
                        parts.scheme != "https"
                        or not parts.hostname
                        or parts.username
                        or parts.password
                        or parts.port not in {None, 443}
                    ):
                        self.valid = False
                    if name in {"href", "data-instgrm-permalink"} and parts.hostname not in {
                        "instagram.com",
                        "www.instagram.com",
                    }:
                        self.valid = False
                except ValueError:
                    self.valid = False

    handle_startendtag = handle_starttag


def _safe_embed_html(value: str) -> bool:
    if (
        not value.strip().lower().startswith("<blockquote")
        or "instagram-media" not in value
        or len(value.encode("utf-8")) > _MAX_HTML_BYTES
    ):
        return False
    validator = _EmbedMarkupValidator()
    validator.feed(value)
    return validator.valid


class ExternalConnectorInstagramOEmbed:
    """Fetch only display HTML, never arbitrary URL content or analytics data.

    The quota callback must atomically reserve a request against a shared,
    budget below 1,000 per rolling hour across UAT and production. This
    service does not use an app or user access token.
    """

    def __init__(
        self,
        *,
        reserve_quota: Callable[[], Awaitable[bool]] | None = None,
    ) -> None:
        self.reserve_quota = reserve_quota

    async def embed(self, *, post_url: str, max_width: int = 540) -> dict[str, str]:
        post_url = canonical_post_url(post_url)
        if type(max_width) is not int or not 320 <= max_width <= 658:
            raise InstagramOEmbedError("invalid_embed_width")
        if self.reserve_quota is None:
            raise InstagramOEmbedError("oembed_quota_unavailable", status_code=503)
        try:
            reserved = await self.reserve_quota()
        except Exception:
            raise InstagramOEmbedError("oembed_quota_unavailable", status_code=503) from None
        if reserved is not True:
            raise InstagramOEmbedError("oembed_rate_limited", status_code=429)

        try:
            async with httpx.AsyncClient(
                timeout=10, follow_redirects=False, trust_env=False
            ) as client:
                async with client.stream(
                    "GET",
                    GRAPH_ENDPOINT,
                    params={
                        "url": post_url,
                        "maxwidth": max_width,
                        "omitscript": "true",
                    },
                    headers={"Accept": "application/json"},
                ) as response:
                    if response.status_code == 429:
                        raise InstagramOEmbedError("oembed_rate_limited", status_code=429)
                    if response.status_code in {400, 404}:
                        raise InstagramOEmbedError("post_unavailable", status_code=404)
                    if response.status_code in {401, 403}:
                        raise InstagramOEmbedError("oembed_access_unavailable", status_code=503)
                    if response.status_code < 200 or response.status_code >= 300:
                        raise InstagramOEmbedError("oembed_provider_unavailable", status_code=502)
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > _MAX_RESPONSE_BYTES:
                            raise InstagramOEmbedError("oembed_response_invalid", status_code=502)
        except httpx.HTTPError:
            raise InstagramOEmbedError("oembed_provider_unavailable", status_code=502) from None
        try:
            payload: Any = json.loads(body)
        except (UnicodeDecodeError, ValueError):
            raise InstagramOEmbedError("oembed_response_invalid", status_code=502) from None
        if not isinstance(payload, dict):
            raise InstagramOEmbedError("oembed_response_invalid", status_code=502)
        html = payload.get("html")
        if (
            payload.get("provider_name") != "Instagram"
            or payload.get("type") != "rich"
            or not isinstance(html, str)
            or not _safe_embed_html(html)
        ):
            raise InstagramOEmbedError("oembed_response_invalid", status_code=502)
        # Only the provider's presentation markup is exposed. Never return
        # author, thumbnail, counts, or other metadata for data extraction.
        return {"html": html}
