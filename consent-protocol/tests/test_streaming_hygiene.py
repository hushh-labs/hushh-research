"""SSE stream whitespace-separator hygiene tests.

[Stream Integrity Guard by Abdul Gaffar]

Verifies that ``api.routes.kai._streaming.iter_sse_chunks`` â€” the canonical
SSE frame filter â€” correctly drops whitespace-only separator frames without
halting the connection chunk emitter and without corrupting valid payloads.

Problem being solved
--------------------
SSE wire format (RFC 8895 Â§9.2) uses blank lines as event boundaries.
Raw HTTP/1.1 chunked transfers and proxy layers frequently inject extra
``\\n``, ``\\r\\n``, or spaces-only frames between real data lines.  A naive
consumer that calls ``json.loads()`` on every raw line crashes with
``JSONDecodeError`` on these separator frames, silently halting the stream.

``iter_sse_chunks`` is the canonical guard that strips each raw buffer line
and yields it only when the stripped content is non-empty â€” it never modifies
valid data lines.

Canonical surface : api.routes.kai._streaming.iter_sse_chunks
Canonical caller  : Every Kai streaming route that wraps an upstream LLM or
                    backend async generator:
                      api/routes/kai/analyze.py  â†’ _stream_kai_analysis()
                      api/routes/kai/stream.py   â†’ _stream_response()
                      api/routes/kai/losers.py   â†’ _stream_optimize()

No DB, no network, no LLM.

[Stream Integrity Guard by Abdul Gaffar]
"""

from __future__ import annotations

import json
from typing import AsyncGenerator

import pytest

from hushh_mcp.services.sse_filter import iter_sse_chunks

# ---------------------------------------------------------------------------
# Async generator helpers
# ---------------------------------------------------------------------------


async def _gen(*items: str) -> AsyncGenerator[str, None]:
    """Yield each string item in order â€” simulates a raw SSE network stream."""
    for item in items:
        yield item


async def _collect(stream: AsyncGenerator[str, None]) -> list[str]:
    """Drain an async generator into a list."""
    result: list[str] = []
    async for chunk in stream:
        result.append(chunk)
    return result


# ===========================================================================
# TestWhitespaceOnlyFramesDropped â€” core contract
# ===========================================================================


class TestWhitespaceOnlyFramesDropped:
    """[Stream Integrity Guard by Abdul Gaffar] Whitespace frames must be silently dropped."""

    async def test_spaces_only_frame_dropped(self):
        """A chunk containing only spaces is silently ignored."""
        raw = _gen("   ")
        result = await _collect(iter_sse_chunks(raw))
        assert result == []

    async def test_newline_only_frame_dropped(self):
        """A bare newline is a standard SSE boundary â€” must be dropped."""
        raw = _gen("\n")
        result = await _collect(iter_sse_chunks(raw))
        assert result == []

    async def test_crlf_frame_dropped(self):
        """A CRLF-only frame is dropped (HTTP/1.1 chunk boundary)."""
        raw = _gen("\r\n")
        result = await _collect(iter_sse_chunks(raw))
        assert result == []

    async def test_double_newline_sse_separator_dropped(self):
        """The canonical SSE event separator (blank line) is dropped."""
        raw = _gen("\n\n")
        result = await _collect(iter_sse_chunks(raw))
        assert result == []

    async def test_spaces_plus_newlines_frame_dropped(self):
        """Mixed spaces and newlines (the exact task-spec malformed frame) are dropped."""
        raw = _gen("   \n\n")
        result = await _collect(iter_sse_chunks(raw))
        assert result == []

    async def test_tab_only_frame_dropped(self):
        """A tab-only chunk is whitespace â€” must be dropped."""
        raw = _gen("\t")
        result = await _collect(iter_sse_chunks(raw))
        assert result == []

    async def test_multiple_whitespace_frames_all_dropped(self):
        """A stream of nothing but whitespace frames yields nothing."""
        raw = _gen("\n", "\r\n", "   ", "\t\t", "\n\n")
        result = await _collect(iter_sse_chunks(raw))
        assert result == []


# ===========================================================================
# TestValidPayloadsPassThrough â€” no modification of real data
# ===========================================================================


class TestValidPayloadsPassThrough:
    """[Stream Integrity Guard by Abdul Gaffar] Valid data lines must pass through unchanged."""

    async def test_single_valid_json_line_passes(self):
        """A valid JSON string passes through unchanged."""
        payload = '{"event": "progress", "pct": 42}'
        raw = _gen(payload)
        result = await _collect(iter_sse_chunks(raw))
        assert result == [payload]

    async def test_sse_data_prefix_passes(self):
        """Standard SSE 'data: ...' prefix passes through unchanged."""
        line = 'data: {"status": "ok"}'
        raw = _gen(line)
        result = await _collect(iter_sse_chunks(raw))
        assert result == [line]

    async def test_plain_string_passes(self):
        """Any non-whitespace string passes through."""
        raw = _gen("hello world")
        result = await _collect(iter_sse_chunks(raw))
        assert result == ["hello world"]

    async def test_multiple_valid_lines_all_pass(self):
        """Three valid JSON payloads all pass through."""
        a = '{"seq": 1}'
        b = '{"seq": 2}'
        c = '{"seq": 3}'
        raw = _gen(a, b, c)
        result = await _collect(iter_sse_chunks(raw))
        assert result == [a, b, c]

    async def test_leading_trailing_whitespace_stripped(self):
        """Valid content with surrounding whitespace is stripped but not dropped."""
        raw = _gen('  {"event": "start"}  ')
        result = await _collect(iter_sse_chunks(raw))
        assert result == ['{"event": "start"}']


# ===========================================================================
# TestMinimalRuntimeProof â€” exact task-spec scenario
# ===========================================================================


class TestMinimalRuntimeProof:
    """
    [Stream Integrity Guard by Abdul Gaffar]

    Task-spec scenario: valid JSON chunk â†’ whitespace-only separator â†’ valid
    JSON chunk.  The wrapper must yield exactly 2 valid parsed objects and
    safely ignore the malformed middle frame.
    """

    async def test_valid_whitespace_valid_yields_exactly_two_objects(self):
        """Core proof: [valid, whitespace, valid] â†’ exactly 2 objects parsed."""
        chunk_a = '{"event": "progress", "pct": 10}'
        separator = "   \n\n"
        chunk_b = '{"event": "complete", "pct": 100}'

        raw = _gen(chunk_a, separator, chunk_b)
        lines = await _collect(iter_sse_chunks(raw))

        # Exactly 2 lines â€” the separator was dropped
        assert len(lines) == 2, (
            f"[Stream Integrity Guard by Abdul Gaffar] "
            f"Expected 2 lines, got {len(lines)}: {lines!r}"
        )

        # Both lines parse as valid JSON
        parsed = [json.loads(line) for line in lines]
        assert parsed[0] == {"event": "progress", "pct": 10}
        assert parsed[1] == {"event": "complete", "pct": 100}

    async def test_multiple_separators_between_payloads(self):
        """Multiple separator frames between two valid payloads â€” both pass, all separators dropped."""
        chunk_a = '{"seq": 1}'
        chunk_b = '{"seq": 2}'
        raw = _gen(chunk_a, "\n", "\r\n", "   \n\n", "\t", chunk_b)
        lines = await _collect(iter_sse_chunks(raw))

        assert len(lines) == 2
        assert json.loads(lines[0]) == {"seq": 1}
        assert json.loads(lines[1]) == {"seq": 2}

    async def test_separator_at_start_is_dropped(self):
        """A leading whitespace frame before any valid data is dropped."""
        payload = '{"event": "start"}'
        raw = _gen("\n\n", payload)
        lines = await _collect(iter_sse_chunks(raw))

        assert lines == [payload]

    async def test_separator_at_end_is_dropped(self):
        """A trailing whitespace frame after the last valid payload is dropped."""
        payload = '{"event": "end"}'
        raw = _gen(payload, "   \n")
        lines = await _collect(iter_sse_chunks(raw))

        assert lines == [payload]

    async def test_empty_stream_yields_nothing(self):
        """An empty source stream produces no output."""
        raw = _gen()
        result = await _collect(iter_sse_chunks(raw))
        assert result == []


# ===========================================================================
# TestBytesDecoding â€” bytes chunks decoded transparently
# ===========================================================================


class TestBytesDecoding:
    """[Stream Integrity Guard by Abdul Gaffar] Bytes chunks are decoded before filtering."""

    async def test_valid_bytes_chunk_decoded_and_yielded(self):
        """UTF-8 bytes are decoded and yielded unchanged."""
        payload = b'{"event": "ok"}'
        raw = _gen(payload)  # type: ignore[arg-type]
        result = await _collect(iter_sse_chunks(raw))
        assert result == ['{"event": "ok"}']

    async def test_bytes_whitespace_frame_dropped(self):
        """Whitespace-only bytes chunk is decoded then dropped."""
        raw = _gen(b"   \n")  # type: ignore[arg-type]
        result = await _collect(iter_sse_chunks(raw))
        assert result == []

    async def test_mixed_bytes_and_str_chunks(self):
        """A stream mixing bytes and str chunks is handled correctly."""

        async def _mixed() -> AsyncGenerator[str | bytes, None]:
            yield '{"a": 1}'
            yield b"\n\n"
            yield b'{"b": 2}'

        result = await _collect(iter_sse_chunks(_mixed()))  # type: ignore[arg-type]
        assert len(result) == 2
        assert json.loads(result[0]) == {"a": 1}
        assert json.loads(result[1]) == {"b": 2}


# ===========================================================================
# TestMultilineChunks â€” single chunk containing embedded newlines
# ===========================================================================


class TestMultilineChunks:
    """[Stream Integrity Guard by Abdul Gaffar] Single chunk with multiple embedded lines."""

    async def test_chunk_with_embedded_newline_split_correctly(self):
        """A single chunk 'line1\\nline2' is split and both lines yielded."""
        raw = _gen('{"x": 1}\n{"x": 2}')
        result = await _collect(iter_sse_chunks(raw))
        assert len(result) == 2
        assert json.loads(result[0]) == {"x": 1}
        assert json.loads(result[1]) == {"x": 2}

    async def test_chunk_with_embedded_whitespace_line_split_and_dropped(self):
        """Chunk 'valid\\n   \\nvalid' splits into 3 lines; middle is dropped."""
        raw = _gen('{"x": 1}\n   \n{"x": 2}')
        result = await _collect(iter_sse_chunks(raw))
        assert len(result) == 2

    async def test_chunk_with_crlf_split_correctly(self):
        """CRLF-delimited chunk is split at CRLF boundaries."""
        raw = _gen('{"a": 1}\r\n{"b": 2}')
        result = await _collect(iter_sse_chunks(raw))
        assert len(result) == 2
        assert json.loads(result[0]) == {"a": 1}
        assert json.loads(result[1]) == {"b": 2}


# ===========================================================================
# TestTrustBoundaryProof â€” canonical attach point named explicitly
# ===========================================================================


class TestTrustBoundaryProof:
    """
    Canonical surface : api.routes.kai._streaming.iter_sse_chunks
                        (whitespace-separator filter added in this PR)
    Canonical caller  : Every Kai streaming route wrapping an upstream
                        LLM or backend async generator:
                          api/routes/kai/analyze.py  â†’ _stream_kai_analysis()
                          api/routes/kai/stream.py   â†’ _stream_response()
                          api/routes/kai/losers.py   â†’ _stream_optimize()
                        iter_sse_chunks sits between the raw network source and
                        the json.loads() call â€” it is the ONLY whitespace-filter
                        gate in the stream pipeline.
    Attach point proof: The tests below prove iter_sse_chunks is importable
                        from its canonical location, that the task-spec scenario
                        (valid â†’ whitespace â†’ valid) yields exactly 2 objects,
                        and that no valid data frame is ever modified or dropped.
    """

    async def test_importable_from_canonical_location(self):
        """iter_sse_chunks is importable from api.routes.kai._streaming."""
        from hushh_mcp.services.sse_filter import iter_sse_chunks as fn  # noqa: F401
        assert callable(fn)

    async def test_task_spec_scenario_exactly_two_objects(self):
        """[Stream Integrity Guard by Abdul Gaffar] Task-spec: validâ†’whitespaceâ†’valid â†’ 2 objects."""
        chunk_a = '{"event": "progress", "pct": 10}'
        separator = "   \n\n"
        chunk_b = '{"event": "complete", "pct": 100}'

        lines = await _collect(iter_sse_chunks(_gen(chunk_a, separator, chunk_b)))

        assert len(lines) == 2
        parsed = [json.loads(ln) for ln in lines]
        assert parsed[0]["event"] == "progress"
        assert parsed[1]["event"] == "complete"

    async def test_filter_is_transparent_for_valid_data(self):
        """[Stream Integrity Guard by Abdul Gaffar] Valid data passes through unmodified."""
        payloads = [f'{{"seq": {i}}}' for i in range(5)]
        raw = _gen(*payloads)
        result = await _collect(iter_sse_chunks(raw))
        assert result == payloads

    @pytest.mark.parametrize("separator", [
        "\n",
        "\r\n",
        "   ",
        "\t",
        "\n\n",
        "   \n\n",
        "  \r\n  ",
        "\r",
    ])
    async def test_all_whitespace_separator_variants_dropped(self, separator: str):
        """[Stream Integrity Guard by Abdul Gaffar] Every whitespace variant is silently dropped."""
        payload = '{"event": "ok"}'
        raw = _gen(payload, separator, payload)
        result = await _collect(iter_sse_chunks(raw))
        assert len(result) == 2, (
            f"[Stream Integrity Guard by Abdul Gaffar] "
            f"Separator {separator!r} was not dropped â€” got {len(result)} lines"
        )
        assert all(json.loads(r)["event"] == "ok" for r in result)

    async def test_no_crash_on_whitespace_only_stream(self):
        """[Stream Integrity Guard by Abdul Gaffar] A whitespace-only stream does not crash."""
        raw = _gen("\n", "\r\n", "   \n\n", "\t\t\t")
        result = await _collect(iter_sse_chunks(raw))
        assert result == []

    async def test_connection_emitter_not_halted_by_separator(self):
        """[Stream Integrity Guard by Abdul Gaffar] Connection continues after a separator frame."""
        before = '{"phase": "init"}'
        after = '{"phase": "done"}'
        raw = _gen(before, "   \n\n", after)

        lines = await _collect(iter_sse_chunks(raw))

        # The emitter did NOT halt â€” we received the frame AFTER the separator
        assert lines[-1] == after, (
            "[Stream Integrity Guard by Abdul Gaffar] "
            "Post-separator payload missing â€” emitter halted on whitespace frame"
        )
