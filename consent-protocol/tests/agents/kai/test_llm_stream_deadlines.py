from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from hushh_mcp.operons.kai import llm


class _Stream:
    def __init__(self, events):
        self._events = iter(events)
        self.closed = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            event = next(self._events)
        except StopIteration:
            raise StopAsyncIteration from None
        if isinstance(event, float):
            await asyncio.sleep(event)
            raise StopAsyncIteration
        if event is StopAsyncIteration:
            raise StopAsyncIteration
        return event

    async def aclose(self):
        self.closed = True


def _chunk(text: str, *, thought: bool = False):
    part = SimpleNamespace(text=text, thought=thought)
    content = SimpleNamespace(parts=[part])
    candidate = SimpleNamespace(content=content)
    return SimpleNamespace(candidates=[candidate], text=text)


async def _collect(stream) -> list[dict]:
    return [event async for event in stream]


def _patched_client(stream: _Stream):
    client = MagicMock()
    client.aio.models.generate_content_stream = AsyncMock(return_value=stream)
    return (
        patch.object(llm, "_gemini_client", client),
        patch.object(llm, "GEMINI_AVAILABLE", True),
        patch.object(llm, "_gemini_model_name", "gemini-test"),
        patch.object(llm, "types", MagicMock()),
    )


@pytest.mark.asyncio
async def test_stream_times_out_before_first_event_and_closes_provider_stream():
    provider_stream = _Stream([0.05])
    patches = _patched_client(provider_stream)
    with patches[0], patches[1], patches[2], patches[3]:
        events = await _collect(llm.stream_gemini_response("prompt", timeout=0.01))

    assert events == [
        {
            "type": "error",
            "message": "Streaming analysis timed out.",
            "agent": "gemini",
        }
    ]
    assert provider_stream.closed is True


@pytest.mark.asyncio
async def test_stream_times_out_after_visible_response_without_false_completion():
    provider_stream = _Stream([_chunk("first"), 0.05])
    patches = _patched_client(provider_stream)
    with patches[0], patches[1], patches[2], patches[3]:
        events = await _collect(llm.stream_gemini_response("prompt", timeout=0.01))

    assert events[0]["type"] == "token"
    assert events[0]["text"] == "first"
    assert events[-1]["type"] == "error"
    assert not any(event["type"] == "complete" for event in events)


@pytest.mark.asyncio
async def test_stream_never_exposes_internal_thought_parts():
    provider_stream = _Stream(
        [
            _chunk("private reasoning", thought=True),
            _chunk("visible answer"),
            StopAsyncIteration,
        ]
    )
    patches = _patched_client(provider_stream)
    with patches[0], patches[1], patches[2], patches[3]:
        events = await _collect(llm.stream_gemini_response("prompt", timeout=1))

    tokens = [event["text"] for event in events if event["type"] == "token"]
    assert tokens == ["visible answer"]
    assert events[-1]["type"] == "complete"
    assert events[-1]["text"] == "visible answer"
