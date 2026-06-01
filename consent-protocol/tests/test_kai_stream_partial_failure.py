"""Regression coverage for Kai SSE token buffering on upstream stream failure."""

from __future__ import annotations

import json

import pytest

from api.routes.kai import stream as stream_routes


class _ConnectedRequest:
    async def is_disconnected(self) -> bool:
        return False


async def _collect_agent_thinking_frames() -> list[dict[str, str]]:
    frames: list[dict[str, str]] = []
    async for frame in stream_routes.stream_agent_thinking(
        agent_name="Fundamental",
        ticker="AAPL",
        prompt_context="Inspect durable cash flow.",
        request=_ConnectedRequest(),
        round_number=1,
        phase="analysis",
    ):
        frames.append(frame)
    return frames


def _payload_texts(frames: list[dict[str, str]]) -> list[str]:
    texts: list[str] = []
    for frame in frames:
        envelope = json.loads(frame["data"])
        payload = envelope["payload"]
        if isinstance(payload.get("text"), str):
            texts.append(payload["text"])
    return texts


def _payload_token_sources(frames: list[dict[str, str]]) -> list[str]:
    sources: list[str] = []
    for frame in frames:
        envelope = json.loads(frame["data"])
        payload = envelope["payload"]
        if isinstance(payload.get("token_source"), str):
            sources.append(payload["token_source"])
    return sources


@pytest.mark.asyncio
async def test_agent_thinking_does_not_emit_partial_tokens_after_upstream_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sentinel = "SENTINEL_INTERNAL_UPSTREAM_PATH_/tmp/kai-stream"

    async def _partial_then_error(*args: object, **kwargs: object):
        yield {"type": "token", "text": "partial-alpha", "token_source": "response"}
        yield {"type": "error", "message": sentinel}

    monkeypatch.setattr(stream_routes, "stream_gemini_response", _partial_then_error)

    frames = await _collect_agent_thinking_frames()
    rendered = "\n".join(frame["data"] for frame in frames)
    texts = _payload_texts(frames)

    assert "partial-alpha" not in rendered
    assert sentinel not in rendered
    assert "".join(texts).startswith("Live commentary is temporarily unavailable.")
    assert set(_payload_token_sources(frames)) == {"fallback"}


@pytest.mark.asyncio
async def test_agent_thinking_flushes_buffered_tokens_after_upstream_complete(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _tokens_then_complete(*args: object, **kwargs: object):
        yield {"type": "token", "text": "alpha", "token_source": "response"}
        yield {"type": "token", "text": " beta", "token_source": "response"}
        yield {"type": "complete", "text": "alpha beta"}

    monkeypatch.setattr(stream_routes, "stream_gemini_response", _tokens_then_complete)

    frames = await _collect_agent_thinking_frames()

    assert _payload_texts(frames) == ["alpha", " beta"]
