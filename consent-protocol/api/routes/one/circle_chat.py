"""Circle-only encrypted member messaging; JSON transport on all platforms."""

from __future__ import annotations

import asyncio
import base64
import logging
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy.exc import SQLAlchemyError

from api.consent_listener import subscribe_consent_queue, unsubscribe_consent_queue
from api.middleware import require_vault_owner_token
from api.middlewares.rate_limit import limiter
from hushh_mcp.services.circle_chat_service import MAX_SEQUENCE, CircleChatError, CircleChatService
from hushh_mcp.services.one_location_circle_service import (
    OneLocationCircleError,
    OneLocationCircleService,
)

logger = logging.getLogger(__name__)
MAX_REQUEST_BYTES = 7_250_000
# Authenticated automatic reads: 4 sessions x 4 coalesced refreshes/sec x
# 60 seconds = 960, plus manual pagination/roster headroom. Write/image abuse
# budgets remain independent; every read still authorizes membership.
AUTOMATIC_READ_LIMIT = "1200/minute"
_waiting: dict[str, int] = {}


class PrivateChatRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def bounded(request: Request):
            headers = {"Cache-Control": "private, no-store"}
            try:
                if request.method in {"POST", "PUT"}:
                    maximum = 430000 if request.url.path.endswith("/photo") else MAX_REQUEST_BYTES
                    declared = request.headers.get("content-length", "0")
                    if not declared.isdigit() or int(declared) > maximum:
                        raise HTTPException(413, "Chat request is too large.", headers=headers)
                    chunks, size = [], 0
                    async with asyncio.timeout(30):
                        async for chunk in request.stream():
                            size += len(chunk)
                            if size > maximum:
                                raise HTTPException(
                                    413, "Chat request is too large.", headers=headers
                                )
                            chunks.append(chunk)
                    request._body = b"".join(chunks)
                response = await handler(request)
                response.headers.update(headers)
                return response
            except RequestValidationError:
                # FastAPI's usual validation detail echoes rejected input.
                # Ciphertexts, envelopes and user-supplied fields stay private.
                raise HTTPException(422, "Invalid circle chat request.", headers=headers) from None
            except TimeoutError:
                raise HTTPException(408, "Chat request timed out.", headers=headers) from None
            except HTTPException as exc:
                exc.headers = {**(exc.headers or {}), **headers}
                raise

        return bounded


router = APIRouter(prefix="/api/one/circles", tags=["Circle chat"], route_class=PrivateChatRoute)
_B64 = r"^[A-Za-z0-9_-]+$"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PublicKey(StrictModel):
    kty: Literal["EC"]
    crv: Literal["P-256"]
    x: str = Field(min_length=43, max_length=43, pattern=_B64)
    y: str = Field(min_length=43, max_length=43, pattern=_B64)
    ext: bool = True
    key_ops: list[str] = Field(default_factory=list, max_length=0)


class KeyEnvelope(StrictModel):
    algorithm: Literal["ECDH-P256-AES256-GCM"]
    recipientKeyId: str = Field(min_length=8, max_length=160)
    ciphertext: str = Field(min_length=64, max_length=64, pattern=_B64)
    iv: str = Field(min_length=16, max_length=16, pattern=_B64)
    senderEphemeralPublicKeyJwk: PublicKey


class Recipient(StrictModel):
    userId: str = Field(min_length=1, max_length=160)
    envelope: KeyEnvelope


class SendMessage(StrictModel):
    clientMessageId: UUID
    rosterVersion: str = Field(min_length=64, max_length=64, pattern=r"^[a-f0-9]+$")
    ciphertext: str = Field(min_length=22, max_length=24000, pattern=_B64)
    iv: str = Field(min_length=16, max_length=16, pattern=_B64)
    imageCiphertext: str | None = Field(
        default=None, min_length=22, max_length=6990530, pattern=_B64
    )
    imageIv: str | None = Field(default=None, min_length=16, max_length=16, pattern=_B64)
    recipients: list[Recipient] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def attachment_pair(self):
        if (self.imageCiphertext is None) != (self.imageIv is None):
            raise ValueError("Image ciphertext and IV must be supplied together.")
        for value in [self.ciphertext, self.imageCiphertext]:
            if value and len(value) % 4 == 1:
                raise ValueError("Invalid ciphertext encoding.")
        # Reject noncanonical encodings so retry fingerprints have one representation.
        for value in [self.ciphertext, self.iv, self.imageCiphertext, self.imageIv]:
            if value:
                raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
                if base64.urlsafe_b64encode(raw).decode().rstrip("=") != value:
                    raise ValueError("Invalid ciphertext encoding.")
        return self


class ReadMessage(StrictModel):
    sequence: int = Field(gt=0, le=MAX_SEQUENCE)


class Preference(StrictModel):
    muted: bool


class CirclePhoto(StrictModel):
    photoUrl: str | None = Field(max_length=410000)


def _call(response: Response, method: str, owner: dict, circle: UUID, *args, **kwargs):
    response.headers["Cache-Control"] = "private, no-store"
    try:
        return getattr(CircleChatService(), method)(owner["user_id"], str(circle), *args, **kwargs)
    except CircleChatError as exc:
        raise HTTPException(
            exc.status,
            detail={"code": exc.code, "message": exc.message},
            headers={"Cache-Control": "private, no-store"},
        ) from exc
    except SQLAlchemyError as exc:
        logger.warning("circle_chat.request_failed error_type=%s", type(exc).__name__)
        raise HTTPException(
            503,
            detail={
                "code": "CIRCLE_CHAT_RETRY",
                "message": "Chat is temporarily unavailable. Retry safely.",
            },
            headers={"Cache-Control": "private, no-store"},
        ) from None


@router.get("/{circle}/chat")
@limiter.limit(AUTOMATIC_READ_LIMIT)
def chat_state(
    request: Request,
    response: Response,
    circle: UUID,
    owner: dict = Depends(require_vault_owner_token),
):
    return _call(response, "state", owner, circle)


@router.put("/{circle}/photo")
@limiter.limit("10/minute")
def circle_photo(
    request: Request,
    response: Response,
    circle: UUID,
    payload: CirclePhoto,
    owner: dict = Depends(require_vault_owner_token),
):
    response.headers["Cache-Control"] = "private, no-store"
    try:
        result = OneLocationCircleService().update_circle_photo(
            owner_user_id=owner["user_id"], circle_id=str(circle), photo_url=payload.photoUrl
        )
        return {"circle": result}
    except OneLocationCircleError as exc:
        raise HTTPException(
            exc.status_code, detail={"code": exc.code, "message": exc.message}
        ) from exc
    except SQLAlchemyError:
        raise HTTPException(503, "Circle photo could not be saved. Try again.") from None


@router.get("/{circle}/chat/messages")
@limiter.limit(AUTOMATIC_READ_LIMIT)
def chat_messages(
    request: Request,
    response: Response,
    circle: UUID,
    before: Annotated[int | None, Query(gt=0, le=MAX_SEQUENCE)] = None,
    after: Annotated[int | None, Query(ge=0, le=MAX_SEQUENCE)] = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 40,
    receiptAfter: Annotated[int | None, Query(ge=0, le=MAX_SEQUENCE)] = None,
    receiptThrough: Annotated[int | None, Query(ge=0, le=MAX_SEQUENCE)] = None,
    owner: dict = Depends(require_vault_owner_token),
):
    if before is not None and after is not None:
        raise HTTPException(422, "Choose one pagination direction.")
    if (receiptAfter is None) != (receiptThrough is None) or (
        receiptAfter is not None and receiptThrough is not None and receiptThrough < receiptAfter
    ):
        raise HTTPException(422, "Choose a valid receipt range.")
    return _call(
        response,
        "messages",
        owner,
        circle,
        before=before,
        after=after,
        limit=limit,
        receipt_after=receiptAfter,
        receipt_through=receiptThrough,
    )


@router.get("/{circle}/chat/wait")
@limiter.limit(AUTOMATIC_READ_LIMIT)
async def chat_wait(
    request: Request,
    response: Response,
    circle: UUID,
    after: Annotated[int, Query(ge=0, le=MAX_SEQUENCE)] = 0,
    owner: dict = Depends(require_vault_owner_token),
):
    """Bounded JSON long poll works through Capacitor without an SSE buffer.

    Subscribe before reading the revision to close the commit/subscribe gap.
    No database connection is held while waiting. Queued content is never
    returned; every response independently checks the current membership.
    """
    user = owner["user_id"]
    if _waiting.get(user, 0) >= 4:
        raise HTTPException(429, "Too many active chat connections.", headers={"Retry-After": "5"})
    _waiting[user] = _waiting.get(user, 0) + 1
    queue = None
    changed = False
    read_changed = False
    receipts_changed = False
    photo_changed = False
    try:
        queue = await subscribe_consent_queue(user)
        current = await asyncio.to_thread(_call, response, "revision", owner, circle)
        if current["latestSequence"] == after:
            try:
                async with asyncio.timeout(20):
                    while True:
                        if await request.is_disconnected():
                            raise HTTPException(499, "Chat connection closed.")
                        try:
                            event = await asyncio.wait_for(queue.get(), timeout=0.5)
                        except TimeoutError:
                            continue
                        if str(event.get("circle_id") or "") == str(circle):
                            changed = True
                            read_changed = event.get("type") == "location_circle_chat_read"
                            receipts_changed = event.get("type") == "location_circle_chat_receipts"
                            photo_changed = event.get("type") == "location_circle_photo_updated"
                            break
            except TimeoutError:
                pass
        return {
            **await asyncio.to_thread(_call, response, "revision", owner, circle),
            "changed": changed,
            "readChanged": read_changed,
            "receiptsChanged": receipts_changed,
            "photoChanged": photo_changed,
        }
    finally:
        if queue is not None:
            await unsubscribe_consent_queue(user, queue)
        _waiting[user] -= 1
        if not _waiting[user]:
            del _waiting[user]


@router.post("/{circle}/chat/messages")
@limiter.limit("30/minute")
@limiter.limit("1000/day")
def chat_send(
    request: Request,
    response: Response,
    circle: UUID,
    payload: SendMessage,
    owner: dict = Depends(require_vault_owner_token),
):
    return _call(response, "send", owner, circle, payload.model_dump(mode="json"))


@router.get("/{circle}/chat/messages/{message}/image")
@limiter.limit("120/minute")
def chat_image(
    request: Request,
    response: Response,
    circle: UUID,
    message: UUID,
    owner: dict = Depends(require_vault_owner_token),
):
    return _call(response, "image", owner, circle, str(message))


@router.get("/{circle}/chat/keys/{key}")
@limiter.limit("60/minute")
def chat_key(
    request: Request,
    response: Response,
    circle: UUID,
    key: Annotated[str, Path(min_length=8, max_length=160)],
    owner: dict = Depends(require_vault_owner_token),
):
    return _call(response, "key", owner, circle, key)


@router.post("/{circle}/chat/read")
@limiter.limit(AUTOMATIC_READ_LIMIT)
def chat_read(
    request: Request,
    response: Response,
    circle: UUID,
    payload: ReadMessage,
    owner: dict = Depends(require_vault_owner_token),
):
    return _call(response, "read", owner, circle, payload.sequence)


@router.put("/{circle}/chat/preferences")
@limiter.limit("20/minute")
def chat_preferences(
    request: Request,
    response: Response,
    circle: UUID,
    payload: Preference,
    owner: dict = Depends(require_vault_owner_token),
):
    return _call(response, "mute", owner, circle, payload.muted)
