"""Bounded private JSON transport shared by web and native API clients."""

from __future__ import annotations

import logging
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from api.middleware import require_firebase_auth
from api.middlewares.rate_limit import limiter
from api.routes.one.private_message_route import PrivateMessageRoute
from hushh_mcp.services import direct_call_voip
from hushh_mcp.services.direct_call_policy import CallError
from hushh_mcp.services.direct_calls_service import DirectCallsService

logger = logging.getLogger(__name__)
router = APIRouter(
    prefix="/api/one/messages/calls", tags=["Direct Calls"], route_class=PrivateMessageRoute
)


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Proof(Strict):
    deviceId: str = Field(min_length=8, max_length=128)
    nonce: UUID
    expiresAt: int = Field(ge=0, le=9999999999)
    signature: str = Field(min_length=80, max_length=128, pattern=r"^[A-Za-z0-9+/]+=*$")


class Envelope(Strict):
    deviceId: str = Field(min_length=8, max_length=128)
    keyId: UUID
    algorithm: Literal["HPKE-P256-SHA256-AES256GCM-v1"]
    enc: str = Field(min_length=80, max_length=128, pattern=r"^[A-Za-z0-9+/]+=*$")
    ciphertext: str = Field(min_length=24, max_length=90000, pattern=r"^[A-Za-z0-9+/]+=*$")


class KeyPayload(Strict):
    keyId: UUID
    publicKey: str = Field(min_length=80, max_length=256, pattern=r"^[A-Za-z0-9+/]+=*$")


class InboxPayload(Strict):
    pass


class VoIPPayload(Strict):
    token: str | None = Field(pattern=r"^[a-f0-9]{64,200}$")
    environment: Literal["sandbox", "production"]


class DirectoryPayload(Strict):
    conversationId: UUID


class CreatePayload(Strict):
    callId: UUID
    conversationId: UUID | None = None
    recipientPersonRef: str | None = Field(default=None, min_length=1, max_length=64)

    @model_validator(mode="after")
    def one_recipient(self):
        if bool(self.conversationId) == bool(self.recipientPersonRef):
            raise ValueError("Choose one conversation or connected person.")
        return self


class OfferPayload(Strict):
    callId: UUID
    offers: list[Envelope] = Field(min_length=1, max_length=20)


class ReadPayload(Strict):
    callId: UUID
    after: int = Field(default=0, ge=0, le=9007199254740991)


class ActionPayload(Strict):
    callId: UUID
    action: Literal["accept", "connected", "decline", "cancel", "end"]
    revision: int = Field(ge=0, le=10000)


class SignalPayload(Strict):
    callId: UUID
    sequence: int = Field(ge=1, le=100)
    envelope: Envelope


class CredentialPayload(Strict):
    callId: UUID


class Command(Strict):
    proof: Proof
    payload: dict


_PAYLOADS: dict[str, type[Strict]] = {
    "register-key": KeyPayload,
    "directory": DirectoryPayload,
    "create": CreatePayload,
    "read": ReadPayload,
    "action": ActionPayload,
    "signal": SignalPayload,
    "credentials": CredentialPayload,
    "inbox": InboxPayload,
    "offer": OfferPayload,
    "register-voip": VoIPPayload,
}


@router.get("/capabilities")
async def capabilities(user: str = Depends(require_firebase_auth)):
    return DirectCallsService.capabilities()


@router.post("/{operation}")
@limiter.limit("180/minute")
async def command(
    request: Request,
    background_tasks: BackgroundTasks,
    operation: Literal[
        "register-key",
        "directory",
        "create",
        "read",
        "action",
        "signal",
        "credentials",
        "inbox",
        "offer",
        "register-voip",
    ],
    body: Command,
    user: str = Depends(require_firebase_auth),
):
    try:
        payload = (
            _PAYLOADS[operation]
            .model_validate(body.payload)
            .model_dump(mode="json", exclude_unset=True)
        )
    except ValidationError:
        raise HTTPException(422, "Invalid call command.") from None
    method = operation.replace("-", "_")
    try:
        result = await run_in_threadpool(
            getattr(DirectCallsService(), method), user, payload, body.proof.model_dump(mode="json")
        )
        if operation == "offer" and direct_call_voip.available():
            background_tasks.add_task(direct_call_voip.deliver_after_offer)
        return result
    except CallError as exc:
        raise HTTPException(exc.status, {"code": exc.code, "message": exc.message}) from None
    except Exception as exc:
        # Never log SQL parameters, ciphertext envelopes, proofs or credentials.
        logger.warning(
            "direct_calls.operation_failed operation=%s error=%s", operation, type(exc).__name__
        )
        raise HTTPException(
            503, {"code": "CALL_UNAVAILABLE", "message": "Calling is temporarily unavailable."}
        ) from None
