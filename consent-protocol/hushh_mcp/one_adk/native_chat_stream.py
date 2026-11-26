"""Stream admitted native ADK output through the owner-bound pod transport."""

from __future__ import annotations

import json
import time
from collections.abc import AsyncGenerator, Awaitable, Callable
from contextlib import aclosing

from google.adk.events import Event

from hushh_mcp.one_adk.native_chat_output import encode_native_chat_output
from hushh_mcp.one_adk.pod_chat_transport import stream_pod_chat_frames
from hushh_mcp.services.pod_upgrade_admission import (
    ADMISSION,
    PodUpgradeAdmission,
    PodUpgradeInProgress,
    pod_incarnation,
)

_FINISHED = b"event: done\ndata: {}\n\n"
_BUSY = b'event: error\ndata: {"code":"POD_CHAT_BUSY"}\n\n'
_UPDATING = b'event: error\ndata: {"code":"POD_CHAT_UPDATING"}\n\n'
_FAILED = b'event: error\ndata: {"code":"AGENT_ERROR"}\n\n'
_REVIEW_REQUIRED = b"event: review\ndata: {}\n\n"


async def native_chat_frames(
    open_source: Callable[[], AsyncGenerator[Event, None]],
    *,
    owner_id: str,
    conversation_id: str,
    require_access: Callable[[], Awaitable[None]],
    settle: Callable[[], Awaitable[None]],
    admission: PodUpgradeAdmission = ADMISSION,
    incarnation: str | None = None,
    announce_start: bool = False,
) -> AsyncGenerator[bytes, None]:
    """Deliver read-only native output and report success after the session settles."""

    async def projected() -> AsyncGenerator[bytes, None]:
        await require_access()
        checked_at = time.monotonic()
        visible = False
        awaiting_review = False
        unfinished_work = False
        started = False
        async with aclosing(open_source()) as source:
            async for event in source:
                if not event.partial or time.monotonic() - checked_at >= 1.5:
                    await require_access()
                    checked_at = time.monotonic()
                if event.error_code or event.error_message:
                    yield _FAILED
                    return
                if announce_start and not started:
                    # The producer has entered the owner-bound run by its first event.
                    started = True
                    start = json.dumps({"sessionId": conversation_id}, separators=(",", ":"))
                    yield f"event: start\ndata: {start}\n\n".encode()
                if event.long_running_tool_ids:
                    unfinished_work = True
                if event.actions.requested_tool_confirmations or any(
                    call.name == "adk_request_confirmation" for call in event.get_function_calls()
                ):
                    awaiting_review = True
                if awaiting_review:
                    # Let ADK write its confirmation event before exposing a
                    # review boundary to the app.
                    continue
                if frame := encode_native_chat_output(event):
                    visible = True
                    yield frame
        if not awaiting_review and (not visible or unfinished_work):
            yield _FAILED
            return
        await require_access()
        await settle()
        await require_access()
        yield _REVIEW_REQUIRED if awaiting_review else _FINISHED

    async def admitted() -> AsyncGenerator[bytes, None]:
        await require_access()
        try:
            permit = await admission.acquire_turn(incarnation=incarnation or pod_incarnation())
        except PodUpgradeInProgress:
            yield _UPDATING
            return
        try:
            async with aclosing(projected()) as stream:
                async for frame in stream:
                    yield frame
        finally:
            await permit.release()

    async with aclosing(
        stream_pod_chat_frames(
            admitted,
            owner_id=owner_id,
            conversation_id=conversation_id,
            encode=lambda frame: frame,
            is_terminal=lambda frame: frame.startswith(
                (b"event: done\n", b"event: review\n", b"event: error\n")
            ),
            busy_frame=lambda: _BUSY,
            error_frame=lambda _: _FAILED,
        )
    ) as stream:
        async for frame in stream:
            yield frame
