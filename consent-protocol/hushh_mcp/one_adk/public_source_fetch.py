"""Exact, permitted public-source reads using the existing public-network fence.

Search citations never stand in for retrieval. Only HTTP 200 at an admitted URL
receives a source receipt; redirects, private DNS, compressed and oversized
responses fail closed. Raw pages remain turn-local and are never logged.
"""

from __future__ import annotations

import hashlib
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from html.parser import HTMLParser

import httpx
from google.genai import types

from hushh_mcp.one_adk.public_sources import public_source_urls
from hushh_mcp.services.mcp_public_http import create_public_mcp_http_client

MAX_SOURCE_BYTES = 2 * 1024 * 1024


class _PageText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.hidden = 0
        self.text: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "template"}:
            self.hidden += 1

    def handle_endtag(self, tag):
        if tag in {"script", "style", "template"} and self.hidden:
            self.hidden -= 1

    def handle_data(self, data):
        if not self.hidden and data.strip():
            self.text.append(data.strip())


@dataclass(frozen=True)
class RetrievedPublicSource:
    ref: str
    url: str
    sha256: str
    parts: tuple[types.Part, ...]


async def retrieve_public_sources(
    urls: list[str],
    *,
    require_current: Callable[[], Awaitable[None]],
    client_factory=create_public_mcp_http_client,
) -> list[RetrievedPublicSource]:
    admitted = public_source_urls(urls)
    if not 1 <= len(admitted) <= 3:
        raise ValueError("Public source review requires one to three sources")
    sources: list[RetrievedPublicSource] = []
    async with client_factory(
        timeout=httpx.Timeout(15), max_response_bytes=MAX_SOURCE_BYTES
    ) as client:
        for url in admitted:
            await require_current()
            try:
                async with client.stream(
                    "GET",
                    url,
                    headers={"Accept": "text/html,text/plain,application/pdf,application/json"},
                ) as response:
                    if response.status_code != 200 or str(response.url) != url:
                        raise ValueError("The requested public source was not retrieved")
                    body = await response.aread()
                    if not body or len(body) > MAX_SOURCE_BYTES:
                        raise ValueError("The requested public source exceeds supported bounds")
                    mime = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
                    if mime == "application/pdf":
                        if not body.startswith(b"%PDF-") or b"%%EOF" not in body[-1024:]:
                            raise ValueError("The requested public PDF is invalid")
                        content = types.Part.from_bytes(data=body, mime_type=mime)
                    elif mime in {"text/html", "text/plain", "application/json"}:
                        text = body.decode(response.encoding or "utf-8", errors="strict")
                        if mime == "text/html":
                            parser = _PageText()
                            parser.feed(text)
                            text = "\n".join(parser.text)
                        if not text.strip():
                            raise ValueError(
                                "The requested public source contains no readable text"
                            )
                        content = types.Part(text=text)
                    else:
                        raise ValueError("The requested public source format is unsupported")
            except (httpx.HTTPError, ValueError, UnicodeError):
                # Keep other successful sources; never manufacture a receipt
                # for an unavailable or unsupported page. Authority errors
                # remain outside this catch and stop the entire operation.
                await require_current()
                continue
            await require_current()
            ref = f"s{len(sources) + 1}"
            sources.append(
                RetrievedPublicSource(
                    ref,
                    url,
                    hashlib.sha256(body).hexdigest(),
                    (types.Part(text=f"UNTRUSTED PUBLIC SOURCE {ref}: {url}"), content),
                )
            )
    if not sources:
        raise ValueError("Requested public sources were not retrieved")
    return sources
