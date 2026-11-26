"""AG-UI wire adapter for the owner-bound private chat transport."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import aclosing

from ag_ui.core import BaseEvent, EventType, RunAgentInput, RunErrorEvent
from ag_ui.encoder import EventEncoder

from hushh_mcp.one_adk.output_privacy import safe_exception_event
from hushh_mcp.one_adk.pod_agui_lifetime import PodTimedADKAgent
from hushh_mcp.one_adk.pod_chat_transport import stream_pod_chat_frames


async def pod_chat_events(
    agent: PodTimedADKAgent, admitted: RunAgentInput, *, owner_id: str
) -> AsyncGenerator[bytes, None]:
    encoder = EventEncoder(accept="text/event-stream")

    def encode(event: BaseEvent) -> bytes:
        return encoder.encode(event).encode("utf-8")

    def is_terminal(event: BaseEvent) -> bool:
        return getattr(event, "type", None) in (EventType.RUN_FINISHED, EventType.RUN_ERROR)

    def busy() -> bytes:
        return encode(
            RunErrorEvent(
                code="POD_CHAT_BUSY",
                message="Your private agent is finishing active work. Try again shortly.",
            )
        )

    def failure(exc: Exception) -> bytes:
        return encode(safe_exception_event(exc))

    async with aclosing(
        stream_pod_chat_frames(
            lambda: agent.run(admitted),
            owner_id=owner_id,
            conversation_id=admitted.thread_id,
            encode=encode,
            is_terminal=is_terminal,
            busy_frame=busy,
            error_frame=failure,
        )
    ) as stream:
        async for frame in stream:
            yield frame
