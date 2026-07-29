"""SSE frame whitespace-separator filter — canonical stream integrity gate.

Canonical surface : hushh_mcp.services.sse_filter.iter_sse_chunks
Canonical caller  : api.routes.kai._streaming (re-exports this function)
                    → Every Kai streaming route that wraps an upstream LLM
                      or backend async generator:
                        api/routes/kai/analyze.py  → _stream_kai_analysis()
                        api/routes/kai/stream.py   → _stream_response()
                        api/routes/kai/losers.py   → _stream_optimize()

Design
------
SSE wire format (RFC 8895 §9.2) uses blank lines as event boundaries.
Raw HTTP/1.1 chunked transfers and proxy layers frequently inject extra
``\\n``, ``\\r\\n``, or spaces-only lines between real data payloads.

A naive consumer that calls ``json.loads()`` on every raw line crashes with
``JSONDecodeError`` on these separator frames, silently halting the
connection chunk emitter.

``iter_sse_chunks`` is the canonical guard:

    raw_stream ──► iter_sse_chunks ──► json.loads() ──► client

It strips each raw buffer line and yields it ONLY when the stripped
content is non-empty.  Whitespace-only separator frames — spaces, ``\\n``,
``\\r\\n``, ``\\r``, or any combination — are silently dropped.
Valid data lines are passed through unmodified.

This module is intentionally dependency-free so it can be imported by
tests and lightweight consumers without triggering the heavy Kai agent
initialisation path.

[Stream Integrity Guard by Abdul Gaffar]

Integrated by Abdul Gaffar — canonical SSE stream integrity surface.
"""

from __future__ import annotations

import logging
from typing import Any, AsyncGenerator

logger = logging.getLogger(__name__)


async def iter_sse_chunks(
    raw_stream: Any,
    *,
    encoding: str = "utf-8",
) -> AsyncGenerator[str, None]:
    """Yield non-empty SSE data lines from *raw_stream*, skipping separator frames.

    Parameters
    ----------
    raw_stream:
        Any async iterable whose items are ``str`` or ``bytes`` chunks.
        String items are used as-is; bytes items are decoded with *encoding*.
    encoding:
        Codec for decoding ``bytes`` items (default ``"utf-8"``).

    Yields
    ------
    str
        Stripped, non-empty lines ready for JSON parsing.  Whitespace-only
        lines — including SSE blank-line separators (``\\n``, ``\\r\\n``,
        ``   \\n\\n``) — are silently dropped.

    Notes
    -----
    The function is a transparent pass-through for valid data lines.  It
    never parses, modifies, or re-encodes the content — callers apply
    ``json.loads()`` or any other parser on the returned strings.

    ``iter_sse_chunks`` sits between the raw network source and the
    ``json.loads()`` call — it is the only whitespace-filter gate in the
    stream pipeline.  A whitespace-only frame MUST NOT halt the emitter;
    processing continues with the next chunk.

    Example::

        async for line in iter_sse_chunks(upstream_generator):
            payload = json.loads(line)   # safe — line is never whitespace-only
            yield payload

    [Stream Integrity Guard by Abdul Gaffar]
    """
    async for raw_chunk in raw_stream:
        # Normalise bytes → str
        if isinstance(raw_chunk, bytes):
            raw_chunk = raw_chunk.decode(encoding, errors="replace")

        # Split on embedded newlines so a single chunk that contains
        # multiple lines (common in chunked HTTP) is handled correctly.
        for line in raw_chunk.splitlines():
            stripped = line.strip()
            if not stripped:
                # Whitespace-only separator frame — drop silently.
                logger.debug(
                    "[Stream Integrity Guard by Abdul Gaffar] "
                    "sse.whitespace_frame_dropped raw=%r",
                    line,
                )
                continue
            yield stripped
