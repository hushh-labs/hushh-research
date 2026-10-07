"""Authenticated API surface for connection-gated direct messages."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import AsyncGenerator

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from api.middleware import require_firebase_auth
from hushh_mcp.services.direct_messages_service import (
    DEFAULT_MESSAGE_PAGE_SIZE,
    MAX_DIRECT_MESSAGE_LENGTH,
    DirectMessagesError,
    DirectMessagesService,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/messages", tags=["Direct Messages"])


class _CamelModel(BaseModel):
    class Config:
        allow_population_by_field_name = True


class SendDirectMessageBody(_CamelModel):
    """Either public person ref or internal id, never both (service enforced)."""

    recipient_user_id: str | None = Field(
        default=None,
        alias="recipientUserId",
        min_length=1,
        max_length=256,
    )
    recipient_person_ref: str | None = Field(
        default=None,
        alias="recipientPersonRef",
        min_length=1,
        max_length=64,
    )
    content: str = Field(..., min_length=1, max_length=MAX_DIRECT_MESSAGE_LENGTH)
    reply_to_message_id: str | None = Field(
        default=None,
        alias="replyToMessageId",
        min_length=1,
        max_length=64,
    )


class EditDirectMessageBody(_CamelModel):
    content: str = Field(..., min_length=1, max_length=MAX_DIRECT_MESSAGE_LENGTH)


class DirectMessageReactionBody(_CamelModel):
    emoji: str = Field(..., min_length=1, max_length=32)


class DirectMessageBlockBody(_CamelModel):
    """A durable, directed block; either identifier form is service-validated."""

    blocked_user_id: str | None = Field(
        default=None,
        alias="blockedUserId",
        min_length=1,
        max_length=256,
    )
    blocked_person_ref: str | None = Field(
        default=None,
        alias="blockedPersonRef",
        min_length=1,
        max_length=64,
    )


def _service() -> DirectMessagesService:
    return DirectMessagesService()


def _handle(exc: Exception) -> HTTPException:
    if isinstance(exc, DirectMessagesError):
        return HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": exc.message},
        )
    # Never place a SQL exception in a relationship surface response.  It can
    # contain a Firebase id or a ciphertext field; the traceback belongs only
    # in the server log.
    logger.exception("direct_messages.route_failed error=%s", type(exc).__name__)
    return HTTPException(
        status_code=500,
        detail={
            "code": "DIRECT_MESSAGE_UNAVAILABLE",
            "message": "Messaging is temporarily unavailable. Please try again.",
        },
    )


@router.get("/conversations")
async def list_conversations(
    response: Response,
    limit: int = Query(default=100, ge=1, le=100),
    firebase_uid: str = Depends(require_firebase_auth),
):
    response.headers["Cache-Control"] = "private, no-store"
    try:
        return await run_in_threadpool(
            _service().list_conversations,
            firebase_uid,
            limit=limit,
        )
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.get("/with/person/{person_ref}")
async def open_conversation_with_person(
    response: Response,
    person_ref: str = Path(..., min_length=1, max_length=64),
    firebase_uid: str = Depends(require_firebase_auth),
):
    response.headers["Cache-Control"] = "private, no-store"
    try:
        return await run_in_threadpool(
            _service().open_with_person,
            firebase_uid,
            recipient_person_ref=person_ref,
        )
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.get("/with/{recipient_user_id}")
async def open_conversation_with_user(
    response: Response,
    recipient_user_id: str = Path(..., min_length=1, max_length=256),
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Compatibility endpoint for trusted internal callers.

    Browser entry points should use the opaque ``/with/person/{person_ref}``
    form.  The same connection gate runs for both forms.
    """

    response.headers["Cache-Control"] = "private, no-store"
    try:
        return await run_in_threadpool(
            _service().open_with_person,
            firebase_uid,
            recipient_user_id=recipient_user_id,
        )
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.post("")
async def send_direct_message(
    payload: SendDirectMessageBody,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Atomically create the pair conversation on the first successful send."""

    try:
        return await run_in_threadpool(
            _service().send_message,
            firebase_uid,
            content=payload.content,
            recipient_user_id=payload.recipient_user_id,
            recipient_person_ref=payload.recipient_person_ref,
            reply_to_message_id=payload.reply_to_message_id,
        )
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.post("/blocks")
async def block_direct_messages(
    payload: DirectMessageBlockBody,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Disable new messages in both directions while preserving history."""

    try:
        return await run_in_threadpool(
            _service().block_user,
            firebase_uid,
            blocked_user_id=payload.blocked_user_id,
            blocked_person_ref=payload.blocked_person_ref,
        )
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.delete("/blocks")
async def unblock_direct_messages(
    payload: DirectMessageBlockBody,
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return await run_in_threadpool(
            _service().unblock_user,
            firebase_uid,
            blocked_user_id=payload.blocked_user_id,
            blocked_person_ref=payload.blocked_person_ref,
        )
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.get("/conversations/{conversation_id}/messages")
async def list_conversation_messages(
    response: Response,
    conversation_id: str = Path(..., min_length=1, max_length=64),
    before: str | None = Query(default=None, min_length=1, max_length=64),
    limit: int = Query(default=DEFAULT_MESSAGE_PAGE_SIZE, ge=1, le=100),
    firebase_uid: str = Depends(require_firebase_auth),
):
    response.headers["Cache-Control"] = "private, no-store"
    try:
        return await run_in_threadpool(
            _service().list_messages,
            firebase_uid,
            conversation_id,
            before=before,
            limit=limit,
        )
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.post("/conversations/{conversation_id}/read")
async def mark_conversation_read(
    conversation_id: str = Path(..., min_length=1, max_length=64),
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return await run_in_threadpool(
            _service().mark_as_read,
            firebase_uid,
            conversation_id,
        )
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.patch("/conversations/{conversation_id}/messages/{message_id}")
async def edit_direct_message(
    payload: EditDirectMessageBody,
    conversation_id: str = Path(..., min_length=1, max_length=64),
    message_id: str = Path(..., min_length=1, max_length=64),
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return await run_in_threadpool(
            _service().edit_message,
            firebase_uid,
            conversation_id,
            message_id,
            content=payload.content,
        )
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.delete("/conversations/{conversation_id}/messages/{message_id}")
async def delete_direct_message(
    conversation_id: str = Path(..., min_length=1, max_length=64),
    message_id: str = Path(..., min_length=1, max_length=64),
    scope: str = Query(..., pattern="^(me|everyone)$"),
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return await run_in_threadpool(
            _service().delete_message,
            firebase_uid,
            conversation_id,
            message_id,
            scope=scope,
        )
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.put("/conversations/{conversation_id}/messages/{message_id}/reaction")
async def react_to_direct_message(
    payload: DirectMessageReactionBody,
    conversation_id: str = Path(..., min_length=1, max_length=64),
    message_id: str = Path(..., min_length=1, max_length=64),
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return await run_in_threadpool(
            _service().react_to_message,
            firebase_uid,
            conversation_id,
            message_id,
            emoji=payload.emoji,
        )
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


def _direct_message_event(payload: object) -> dict[str, object] | None:
    if not isinstance(payload, dict) or str(payload.get("type") or "") != "direct_message":
        return None
    message_id = str(payload.get("message_id") or "").strip()
    conversation_id = str(payload.get("conversation_id") or "").strip()
    if not message_id or not conversation_id:
        return None
    # This is a doorbell only.  The client reads encrypted content through its
    # participant-scoped API after receiving it; no body or raw actor id flows
    # over the notification transport.
    return {
        "messageId": message_id,
        "conversationId": conversation_id,
        "directMessageId": str(payload.get("direct_message_id") or "").strip() or None,
        "at": str(payload.get("at") or "").strip() or None,
        "deepLink": str(payload.get("deep_link") or "").strip() or None,
    }


async def _message_event_stream(
    user_id: str, request: Request
) -> AsyncGenerator[dict[str, str], None]:
    """Filter the shared user-state queue to direct-message doorbells."""

    from api.consent_listener import subscribe_consent_queue, unsubscribe_consent_queue

    queue = await subscribe_consent_queue(user_id)
    seen: set[str] = set()
    try:
        while True:
            if await request.is_disconnected():
                break
            try:
                payload = await asyncio.wait_for(queue.get(), timeout=25)
            except asyncio.TimeoutError:
                yield {
                    "event": "heartbeat",
                    "data": json.dumps({"timestamp": int(time.time() * 1000)}),
                }
                continue
            event = _direct_message_event(payload)
            if event is None:
                continue
            event_id = str(event["messageId"])
            if event_id in seen:
                continue
            seen.add(event_id)
            # Bound the per-stream dedupe set.  The network transport is a
            # doorbell, not durable history, and a client reconnect rereads.
            if len(seen) > 500:
                seen.clear()
                seen.add(event_id)
            yield {
                "event": "direct_message",
                "id": event_id,
                "data": json.dumps(event, separators=(",", ":")),
            }
    except asyncio.CancelledError:
        raise
    finally:
        await unsubscribe_consent_queue(user_id, queue)


async def _events_response(request: Request, firebase_uid: str) -> EventSourceResponse:
    return EventSourceResponse(
        _message_event_stream(firebase_uid, request),
        headers={
            "Cache-Control": "no-cache, no-store",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/events")
async def direct_message_events(
    request: Request,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Authenticated metadata-only SSE subscription for direct messages."""

    return await _events_response(request, firebase_uid)


@router.get("/stream")
async def direct_message_stream(
    request: Request,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Alias whose suffix opts into the existing long-lived Next proxy path."""

    return await _events_response(request, firebase_uid)


__all__ = [
    "DirectMessageBlockBody",
    "DirectMessageReactionBody",
    "EditDirectMessageBody",
    "SendDirectMessageBody",
    "router",
]
