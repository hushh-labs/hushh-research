"""
Regression tests: stream_agent_thinking must not echo Gemini error messages to clients.

CWE-209 - Information Exposure Through Error Messages.

The stream_agent_thinking generator in api/routes/kai/stream.py previously
embedded the raw Gemini error-event message into a fallback text token sent to
all connected SSE clients:

    fallback_text = f"Live commentary is temporarily unavailable ({stream_error_message}). ..."

A Gemini error message can contain provider-internal details: model endpoint
names, API version strings, quota-limit payloads, or internal error codes.
Echoing this into user-facing SSE tokens aids reconnaissance.

Fix: the fallback text is now a static opaque string. The raw message is
retained only in server-side logs (logger.error at WARNING level), never
forwarded to the client.
"""

from __future__ import annotations

import json
from typing import Any, AsyncGenerator
from unittest.mock import AsyncMock, patch

import pytest

SENTINEL = "XK9_GEMINI_INTERNAL_ERROR_SENTINEL_XK9"

_FAKE_REQUEST = AsyncMock()
_FAKE_REQUEST.is_disconnected = AsyncMock(return_value=False)


async def _collect(gen: AsyncGenerator[Any, None]) -> list[Any]:
    items: list[Any] = []
    async for item in gen:
        items.append(item)
    return items


def _error_event(message: str) -> dict:
    return {"type": "error", "message": message}


@pytest.mark.asyncio
async def test_sentinel_not_in_fallback_token() -> None:
    """Gemini error message must not appear in any yielded agent_token event."""
    from api.routes.kai.stream import stream_agent_thinking

    async def _mock_stream(*args: Any, **kwargs: Any) -> AsyncGenerator[dict, None]:
        yield _error_event(SENTINEL)

    with patch(
        "api.routes.kai.stream.stream_gemini_response",
        side_effect=_mock_stream,
    ):
        events = await _collect(
            stream_agent_thinking(
                agent_name="Fundamental",
                ticker="AAPL",
                prompt_context="test",
                request=_FAKE_REQUEST,
                round_number=1,
                phase="analysis",
            )
        )

    full_output = str(events)
    assert SENTINEL not in full_output, (
        f"Gemini error sentinel leaked into SSE output: {SENTINEL}"
    )


@pytest.mark.asyncio
async def test_fallback_token_is_opaque_static_string() -> None:
    """When Gemini returns error and zero tokens, fallback text must be static."""
    from api.routes.kai.stream import stream_agent_thinking

    async def _mock_stream(*args: Any, **kwargs: Any) -> AsyncGenerator[dict, None]:
        yield _error_event(SENTINEL)

    with patch(
        "api.routes.kai.stream.stream_gemini_response",
        side_effect=_mock_stream,
    ):
        events = await _collect(
            stream_agent_thinking(
                agent_name="Sentiment",
                ticker="GOOG",
                prompt_context="test",
                request=_FAKE_REQUEST,
                round_number=1,
                phase="analysis",
            )
        )

    # At least one fallback token must be yielded
    assert events, "Expected at least one fallback token event when Gemini errors"
    # create_event serialises the payload into a JSON string under the "data" key.
    # Decode each frame and gather the text tokens from the envelope payload.
    def _frame_text(event: Any) -> str:
        raw = event.get("data", "")
        if isinstance(raw, dict):
            return raw.get("text", "") or raw.get("payload", {}).get("text", "")
        try:
            envelope = json.loads(raw)
            return envelope.get("payload", {}).get("text", "")
        except (ValueError, AttributeError):
            return ""

    all_text = "".join(_frame_text(e) for e in events)
    assert SENTINEL not in all_text
    assert "unavailable" in all_text.lower(), "Expected opaque unavailability message"


@pytest.mark.asyncio
async def test_error_with_no_message_field_does_not_crash() -> None:
    """An error event with no message field must not raise or leak."""
    from api.routes.kai.stream import stream_agent_thinking

    async def _mock_stream(*args: Any, **kwargs: Any) -> AsyncGenerator[dict, None]:
        yield {"type": "error"}  # missing "message" key

    with patch(
        "api.routes.kai.stream.stream_gemini_response",
        side_effect=_mock_stream,
    ):
        events = await _collect(
            stream_agent_thinking(
                agent_name="Valuation",
                ticker="MSFT",
                prompt_context="test",
                request=_FAKE_REQUEST,
                round_number=1,
                phase="analysis",
            )
        )

    assert SENTINEL not in str(events)


@pytest.mark.asyncio
async def test_normal_token_events_pass_through_unmodified() -> None:
    """Real analysis tokens must still be yielded when Gemini succeeds."""
    from api.routes.kai.stream import stream_agent_thinking

    async def _mock_stream(*args: Any, **kwargs: Any) -> AsyncGenerator[dict, None]:
        yield {"type": "token", "text": "Strong fundamentals", "token_source": "response"}
        yield {"type": "complete"}

    with patch(
        "api.routes.kai.stream.stream_gemini_response",
        side_effect=_mock_stream,
    ):
        events = await _collect(
            stream_agent_thinking(
                agent_name="Fundamental",
                ticker="NVDA",
                prompt_context="test",
                request=_FAKE_REQUEST,
                round_number=1,
                phase="analysis",
            )
        )

    # Should have exactly one token event
    assert len(events) == 1
    assert SENTINEL not in str(events)


@pytest.mark.asyncio
async def test_multi_field_error_sentinel_not_in_any_field() -> None:
    """Complex Gemini error messages with multiple fields must not leak to clients."""
    from api.routes.kai.stream import stream_agent_thinking

    complex_error = f"quota exceeded: {SENTINEL} endpoint=internal-model-v99 region=us-central"

    async def _mock_stream(*args: Any, **kwargs: Any) -> AsyncGenerator[dict, None]:
        yield _error_event(complex_error)

    with patch(
        "api.routes.kai.stream.stream_gemini_response",
        side_effect=_mock_stream,
    ):
        events = await _collect(
            stream_agent_thinking(
                agent_name="Fundamental",
                ticker="TSLA",
                prompt_context="test",
                request=_FAKE_REQUEST,
                round_number=1,
                phase="analysis",
            )
        )

    full_output = str(events)
    assert SENTINEL not in full_output
    assert "internal-model-v99" not in full_output
    assert "us-central" not in full_output
