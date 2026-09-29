"""Whether a One turn has settled, and the bare signal sent when it settles unseen.

A turn keeps running after its client disconnects (the AG-UI bridge runs it in
its own task) and its events are sealed into the conversation as they happen.
Two readers need to know where the newest turn stands:

* the history route, so a returning client can tell a turn that is still
  running from one that has finished, and reattach until it finishes;
* the detached-turn hook, which sends one push when a turn finishes after the
  person left.

The push is a wake-up only. Its title, body and data are fixed strings plus the
opaque conversation id; no message text, title, tool name or account id ever
reaches Firebase or the lock screen. The conversation loads after unlock.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections.abc import Sequence
from typing import Any

from hushh_mcp.branding import PRODUCT_NAME
from hushh_mcp.one_adk.follow_up_suggestions import FOLLOW_UP_TOOL_NAME
from hushh_mcp.services.chat_key import MAX_BINDING_SECONDS

logger = logging.getLogger(__name__)

# A detached run is bounded by the chat key it holds (``MAX_BINDING_SECONDS``),
# not by the route's 200 s stream bound, which only an attached reader enforces.
# After this a turn that never wrote a final event is over; nobody waits forever.
PENDING_WINDOW_SECONDS: float = float(MAX_BINDING_SECONDS)

ONE_REPLY_NOTIFICATION_TYPE = "one_reply"
ONE_REPLY_TITLE = PRODUCT_NAME
ONE_REPLY_BODY = "One replied"
ONE_REPLY_CATEGORY = "ONE_CHAT"
# Only native devices get this push. On the web the open app shows its own
# notice, and a browser push beside it would be a duplicate.
ONE_REPLY_PLATFORMS = frozenset({"ios", "android"})
_PUSH_TIMEOUT_SECONDS = 10.0


def _is_turn_event(event: Any) -> bool:
    """False for the bridge's own session-state writes.

    After a turn pauses on a review (and on some resumes) the AG-UI bridge
    persists bookkeeping through ``update_session_state``, which appends a
    content-less event under a synthetic ``state_update_*`` invocation. Those
    events belong to no turn and must not be read as the newest one.
    """
    content = getattr(event, "content", None)
    return bool(content is not None and getattr(content, "parts", None))


def _newest_turn(events: Sequence[Any]) -> list[Any]:
    turn_events = [event for event in events if _is_turn_event(event)]
    if not turn_events:
        return []
    invocation = getattr(turn_events[-1], "invocation_id", None)
    return [event for event in turn_events if getattr(event, "invocation_id", None) == invocation]


def _is_final(event: Any) -> bool:
    if getattr(event, "author", None) == "user" or getattr(event, "partial", False):
        return False
    is_final = getattr(event, "is_final_response", None)
    return bool(is_final()) if callable(is_final) else False


def _has_answer(event: Any) -> bool:
    if getattr(event, "long_running_tool_ids", None):
        # The turn paused on the person's review: there is something to open.
        return True
    content = getattr(event, "content", None)
    return any(
        isinstance(getattr(part, "text", None), str)
        and part.text.strip()
        and not getattr(part, "thought", False)
        for part in (getattr(content, "parts", None) or [])
    )


def newest_turn_settled(events: Sequence[Any]) -> bool:
    """True once the newest turn wrote a final event: an answer, a review pause or an error."""
    return any(_is_final(event) for event in _newest_turn(events))


def _ends_on_follow_ups(event: Any) -> bool:
    """A turn closed by follow-up suggestions: its answer is on the call's own event."""
    responses = event.get_function_responses() if hasattr(event, "get_function_responses") else []
    return bool(responses) and all(
        response.name == FOLLOW_UP_TOOL_NAME and (response.response or {}).get("status") == "shown"
        for response in responses
    )


def newest_turn_answered(events: Sequence[Any]) -> bool:
    """True when the newest turn ended with something the person can open."""
    turn = _newest_turn(events)
    for index, event in enumerate(turn):
        if not _is_final(event):
            continue
        if _has_answer(event):
            return True
        if _ends_on_follow_ups(event) and any(
            getattr(prior, "author", None) != "user" and _has_answer(prior)
            for prior in turn[:index]
        ):
            return True
    return False


def newest_turn_pending(events: Sequence[Any], *, now: float | None = None) -> bool:
    """True while the newest turn has no final event and is inside its execution window."""
    turn = _newest_turn(events)
    if not turn or newest_turn_settled(events):
        return False
    started = min(float(getattr(event, "timestamp", 0.0) or 0.0) for event in turn)
    return (time.time() if now is None else now) - started < PENDING_WINDOW_SECONDS


def one_reply_push(conversation_id: str) -> dict[str, Any]:
    """The complete push for a settled turn. Nothing here is derived from the turn's content."""
    return {
        "notification_type": ONE_REPLY_NOTIFICATION_TYPE,
        "title": ONE_REPLY_TITLE,
        "body": ONE_REPLY_BODY,
        # The client derives the tap target from type plus the id; this fixed
        # fallback is only for older builds that do not know the type.
        "deep_link": "/one/feed",
        "notification_tag": f"{ONE_REPLY_NOTIFICATION_TYPE}:{conversation_id}",
        "notification_category": ONE_REPLY_CATEGORY,
        "data": {"conversation_id": conversation_id, "message_id": uuid.uuid4().hex},
        "show_alert": True,
        # Recipient routing stays server-side; the account id never reaches the device.
        "include_user_id": False,
        "platforms": ONE_REPLY_PLATFORMS,
    }


async def notify_one_reply(*, owner_id: str, conversation_id: str) -> int:
    """Send the bare "One replied" signal to the owner's native devices. Never raises."""
    from hushh_mcp.services.push_notifications import send_user_data_push

    try:
        async with asyncio.timeout(_PUSH_TIMEOUT_SECONDS):
            return await asyncio.to_thread(
                send_user_data_push, owner_id, **one_reply_push(conversation_id)
            )
    except Exception:  # noqa: BLE001 - a wake-up is best-effort; no provider detail in logs
        logger.warning("one.reply_push_skipped")
        return 0


__all__ = [
    "ONE_REPLY_BODY",
    "ONE_REPLY_NOTIFICATION_TYPE",
    "ONE_REPLY_PLATFORMS",
    "ONE_REPLY_TITLE",
    "PENDING_WINDOW_SECONDS",
    "newest_turn_answered",
    "newest_turn_pending",
    "newest_turn_settled",
    "notify_one_reply",
    "one_reply_push",
]
