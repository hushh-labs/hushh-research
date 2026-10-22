"""Authenticated API surface for connection-gated direct messages."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import AsyncGenerator
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from api.middleware import require_firebase_auth
from hushh_mcp.services.chat_notification_state import unread_message_count
from hushh_mcp.services.direct_message_route_cipher import DirectMessageRouteCipher
from hushh_mcp.services.direct_messages_service import (
    DEFAULT_MESSAGE_PAGE_SIZE,
    MAX_DIRECT_ATTACHMENT_BASE64_LENGTH,
    MAX_DIRECT_MESSAGE_LENGTH,
    DirectMessagesError,
    DirectMessagesService,
)

logger = logging.getLogger(__name__)


class PrivateMessageRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def bounded(request: Request):
            try:
                if request.method == "POST" and request.url.path.rstrip("/") == "/api/one/messages":
                    maximum = MAX_DIRECT_ATTACHMENT_BASE64_LENGTH + 64_000
                    declared = request.headers.get("content-length")
                    if declared and declared.isdigit() and int(declared) > maximum:
                        raise HTTPException(413, "Message request is too large.")
                    chunks, size = [], 0
                    async with asyncio.timeout(30):
                        async for chunk in request.stream():
                            size += len(chunk)
                            if size > maximum:
                                raise HTTPException(413, "Message request is too large.")
                            chunks.append(chunk)
                    request._body = b"".join(chunks)
                result = await handler(request)
                result.headers["Cache-Control"] = "private, no-store"
                return result
            except RequestValidationError:
                # Validation errors must never echo an attachment's base64 data.
                raise HTTPException(422, "Invalid message request.") from None
            except TimeoutError:
                raise HTTPException(408, "Message request timed out.") from None

        return bounded


router = APIRouter(
    prefix="/api/one/messages", tags=["Direct Messages"], route_class=PrivateMessageRoute
)


class _CamelModel(BaseModel):
    class Config:
        allow_population_by_field_name = True


class DirectMessageAttachmentBody(_CamelModel):
    name: str = Field(..., min_length=1, max_length=160)
    mime_type: str = Field(..., alias="mimeType", min_length=1, max_length=160)
    data: str = Field(..., min_length=1, max_length=MAX_DIRECT_ATTACHMENT_BASE64_LENGTH)


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
    content: str = Field(default="", max_length=MAX_DIRECT_MESSAGE_LENGTH)
    attachment: DirectMessageAttachmentBody | None = None
    client_message_id: UUID | None = Field(default=None, alias="clientMessageId")
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


class DirectMessageDeliveryBody(_CamelModel):
    message_ids: list[UUID] = Field(..., alias="messageIds", min_length=1, max_length=100)


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


@router.get("/unread-count")
async def get_unread_count(
    response: Response,
    firebase_uid: str = Depends(require_firebase_auth),
) -> dict[str, int]:
    """Read the authenticated owner's People and Circle message total only."""
    response.headers["Cache-Control"] = "private, no-store"
    try:
        count = await run_in_threadpool(unread_message_count, firebase_uid)
        return {"unreadCount": count}
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


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


@router.delete("/conversations/{conversation_id}")
async def delete_conversation(
    conversation_id: UUID,
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return await run_in_threadpool(
            _service().delete_conversation, firebase_uid, str(conversation_id)
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
            client_message_id=str(payload.client_message_id) if payload.client_message_id else None,
            attachment=(
                {
                    "name": payload.attachment.name,
                    "mimeType": payload.attachment.mime_type,
                    "data": payload.attachment.data,
                }
                if payload.attachment
                else None
            ),
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
    through_message_id: UUID | None = Query(default=None, alias="throughMessageId"),
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return await run_in_threadpool(
            _service().mark_as_read,
            firebase_uid,
            conversation_id,
            **({"through_message_id": str(through_message_id)} if through_message_id else {}),
        )
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.post("/conversations/{conversation_id}/delivered")
async def acknowledge_message_delivery(
    payload: DirectMessageDeliveryBody,
    conversation_id: str = Path(..., min_length=1, max_length=64),
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return await run_in_threadpool(
            _service().acknowledge_delivery,
            firebase_uid,
            conversation_id,
            message_ids=[str(value) for value in payload.message_ids],
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


@router.delete("/conversations/{conversation_id}/messages/{message_id}/reaction")
async def remove_direct_message_reaction(
    payload: DirectMessageReactionBody,
    conversation_id: str = Path(..., min_length=1, max_length=64),
    message_id: str = Path(..., min_length=1, max_length=64),
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return await run_in_threadpool(
            _service().remove_reaction,
            firebase_uid,
            conversation_id,
            message_id,
            emoji=payload.emoji,
        )
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.get("/conversations/{conversation_id}/messages/{message_id}/attachment")
async def get_direct_message_attachment(
    conversation_id: str = Path(..., min_length=1, max_length=64),
    message_id: str = Path(..., min_length=1, max_length=64),
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        attachment = await run_in_threadpool(
            _service().get_attachment,
            firebase_uid,
            conversation_id,
            message_id,
        )
        return Response(
            content=attachment["content"],
            media_type=attachment["mimeType"],
            headers={
                "Cache-Control": "private, no-store",
                "Content-Disposition": "attachment",
                "X-Content-Type-Options": "nosniff",
            },
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
        "deepLink": None,  # Navigation resolves through the authenticated token endpoint.
        **(
            {"action": "conversation_deleted"}
            if payload.get("action") == "conversation_deleted"
            else {}
        ),
    }


async def _message_event_stream(
    user_id: str, request: Request
) -> AsyncGenerator[dict[str, str], None]:
    """Filter the shared user-state queue to direct-message doorbells."""

    from api.consent_listener import (
        LOCAL_RESYNC_EVENT_TYPE,
        subscribe_consent_queue,
        unsubscribe_consent_queue,
    )

    queue = await subscribe_consent_queue(user_id, snapshot_resets=True)
    seen: set[str] = set()
    try:
        # Subscribe before asking the client to reread. An initial page load
        # and this stream can otherwise miss a commit between their requests.
        yield {"event": "resync", "data": "{}"}
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
            if isinstance(payload, dict) and payload.get("type") == LOCAL_RESYNC_EVENT_TYPE:
                seen.clear()
                yield {"event": "resync", "data": "{}"}
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


class DirectMessageRouteBody(BaseModel):
    token: str | None = Field(default=None, max_length=512)
    conversationId: str | None = Field(default=None, max_length=64)
    personRef: str | None = Field(default=None, max_length=64)


@router.post("/route-token")
async def direct_message_route_token(
    body: DirectMessageRouteBody,
    response: Response,
    firebase_uid: str = Depends(require_firebase_auth),
):
    response.headers["Cache-Control"] = "private, no-store"
    try:
        if sum(bool(value) for value in (body.token, body.conversationId, body.personRef)) != 1:
            raise DirectMessagesError(
                "DIRECT_MESSAGE_ROUTE_INVALID", "This conversation link is unavailable."
            )
        cipher = DirectMessageRouteCipher()
        if body.token:
            kind, ref = cipher.open(firebase_uid, body.token)
        else:
            kind, ref = (
                ("conversation", body.conversationId)
                if body.conversationId
                else ("person", body.personRef)
            )
        service = _service()
        if kind == "conversation":
            ref = service._normalize_conversation_id(ref)
            row = await run_in_threadpool(service._conversation_for_participant, firebase_uid, ref)
            if not row:
                raise DirectMessagesError(
                    "DIRECT_MESSAGE_ROUTE_INVALID",
                    "This conversation link is unavailable.",
                    status_code=404,
                )
        else:
            await run_in_threadpool(
                service.open_with_person, firebase_uid, recipient_person_ref=ref
            )
        return {
            "token": body.token or cipher.seal(firebase_uid, kind, ref),
            "kind": kind,
            "ref": ref,
        }
    except Exception as exc:
        raise _handle(exc) from exc
