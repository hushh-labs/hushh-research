"""Live progress for the owner's Personal World Model preparation.

GET /api/one/world-model/jobs/stream

Same authority as GET /jobs (vault-owner token plus that owner's chat key).
The stream reads the job status every 2 s and sends::

    progress  <PwmProgress>   whenever the derived progress changes
    partial   {validated_facts: [...]} when a cited provisional batch changes
    ping      {}              at least every 15 s
    result    <PwmResult>     when the job leaves pending/paused, needs a
                              restart, or the stream reaches its lifetime;
                              then the stream closes

The chat key the request carried stays bound for the whole response (the
middleware wraps the ASGI call) and expires 300 s after the handshake, so the
stream closes itself after 240 s with a ``result`` frame and the client
reconnects. Nothing from the stream is cached, logged or persisted.

Each tick costs a status read plus, while research is live, a second read of
the sealed checkpoint that ``WorldModelJobs.status`` decrypts to derive the
progress. The hourly limit only counts opens, so this module also caps the
streams one owner may hold open at once in this process (``MAX_OPEN_STREAMS``);
a third open is refused with 429 and ``Retry-After: 5`` before any read.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncGenerator
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from sse_starlette.sse import EventSourceResponse

from api.middlewares.rate_limit import limiter
from api.routes.one.profile_research import PrivateProfileRoute
from api.routes.one.world_model import owner
from hushh_mcp.services.owner_placement_guard import hub_content_chat_owner
from hushh_mcp.services.world_model_service import world_model_jobs

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/one/world-model", tags=["Personal World Model"], route_class=PrivateProfileRoute
)

POLL_SECONDS = 2.0
HEARTBEAT_SECONDS = 15.0
# Below the 300 s chat-key binding, with room for the handshake.
LIFETIME_SECONDS = 240.0
SEND_TIMEOUT_SECONDS = 10.0
_STREAM_HEADERS = {
    "Cache-Control": "no-cache, no-store",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}
LIVE_STATUSES = frozenset({"pending", "paused"})
#: Streams one owner may hold open at once in this process. The client keeps
#: one and reconnects after each ``result`` frame; a second covers the overlap.
MAX_OPEN_STREAMS = 2
RETRY_AFTER_SECONDS = "5"
#: user_id -> streams open right now. In-process only, like the rate limiter's
#: default storage; it never holds anything but a count.
open_streams: dict[str, int] = {}


def acquire_stream(user_id: str) -> bool:
    """Count one more open stream for ``user_id``; False when the owner is at the cap."""
    opened = open_streams.get(user_id, 0)
    if opened >= MAX_OPEN_STREAMS:
        return False
    open_streams[user_id] = opened + 1
    return True


def release_stream(user_id: str) -> None:
    opened = open_streams.get(user_id, 0) - 1
    if opened > 0:
        open_streams[user_id] = opened
    else:
        open_streams.pop(user_id, None)


async def counted(
    user_id: str, events: AsyncGenerator[dict[str, str], None]
) -> AsyncGenerator[dict[str, str], None]:
    """Relay ``events`` and give the owner's stream slot back however it ends."""
    try:
        async for frame in events:
            yield frame
    finally:
        release_stream(user_id)


def _frame(event: str, payload: Any) -> dict[str, str]:
    if event == "result":
        from hushh_mcp.one_adk.world_model_usage import public_result

        payload, _ = public_result(payload)
    return {"event": event, "data": json.dumps(payload, separators=(",", ":"))}


async def _disconnected(request: Any) -> bool:
    probe = getattr(request, "is_disconnected", None)
    return bool(await probe()) if probe is not None else False


async def progress_events(
    jobs: Any,
    user_id: str,
    consent_token: str,
    request: Any,
    *,
    poll_seconds: float = POLL_SECONDS,
    heartbeat_seconds: float = HEARTBEAT_SECONDS,
    lifetime_seconds: float = LIFETIME_SECONDS,
    clock=time.monotonic,
    sleep=asyncio.sleep,
    initial: dict | None = None,
) -> AsyncGenerator[dict[str, str], None]:
    """Poll ``jobs.status`` for one owner and turn changes into frames.

    ``initial`` is a status the handler already read. A lost session
    (PermissionError) or an unavailable backend closes the stream without a
    frame: the next handshake reports the real status.
    """
    started = clock()
    last_frame_at = started
    last_progress: dict | None = None
    last_partial: list | None = None
    result = initial
    while True:
        if result is None:
            try:
                result = await jobs.status(user_id, consent_token)
            except PermissionError:
                return
            except Exception as error:
                logger.warning("one.pwm_stream_unavailable error_type=%s", type(error).__name__)
                return
        now = clock()
        if result.get("status") not in LIVE_STATUSES or result.get("restart_required") is True:
            yield _frame("result", result)
            return
        progress = result.get("progress")
        if isinstance(progress, dict) and progress != last_progress:
            last_progress = progress
            last_frame_at = now
            yield _frame("progress", progress)
        partial = result.get("validated_facts")
        if (
            isinstance(partial, list)
            and partial != last_partial
            and (partial or last_partial is not None)
        ):
            last_partial = partial
            last_frame_at = now
            yield _frame("partial", {"validated_facts": partial})
        elif partial is None and last_partial:
            last_partial = []
            last_frame_at = now
            yield _frame("partial", {"validated_facts": []})
        if now - started >= lifetime_seconds:
            # The key expires soon; hand back the live state so the client
            # reconnects without an idle gap.
            yield _frame("result", result)
            return
        if now - last_frame_at >= heartbeat_seconds:
            last_frame_at = now
            yield {"event": "ping", "data": "{}"}
        if await _disconnected(request):
            return
        await sleep(poll_seconds)
        result = None


@router.get("/jobs/stream")
@limiter.limit("60/hour")
async def stream(request: Request, token: dict = Depends(hub_content_chat_owner)):
    user_id, consent_token = owner(token)
    if not acquire_stream(user_id):
        raise HTTPException(
            429,
            "Research is already open in another tab. Try again in a moment.",
            headers={"Retry-After": RETRY_AFTER_SECONDS},
        )
    try:
        # Same refusal as GET /jobs before any frame is sent.
        first = await world_model_jobs.status(user_id, consent_token)
    except HTTPException:
        release_stream(user_id)
        raise
    except PermissionError:
        release_stream(user_id)
        raise HTTPException(403, "Unlock your vault to continue.") from None
    except Exception:
        release_stream(user_id)
        raise HTTPException(
            503,
            "Research is temporarily unavailable.",
            headers={"Retry-After": RETRY_AFTER_SECONDS},
        ) from None
    except BaseException:
        release_stream(user_id)
        raise
    return EventSourceResponse(
        counted(
            user_id,
            progress_events(world_model_jobs, user_id, consent_token, request, initial=first),
        ),
        headers=dict(_STREAM_HEADERS),
        send_timeout=SEND_TIMEOUT_SECONDS,
    )


__all__ = ["MAX_OPEN_STREAMS", "acquire_stream", "progress_events", "release_stream", "router"]
