"""Owner-confirmed Gmail sending and incremental send-scope routes."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_firebase_auth, require_vault_owner_token, verify_user_id_match
from hushh_mcp.services.google_connection_service import (
    GoogleConnectionError,
    get_google_connection_service,
)
from hushh_mcp.services.google_email_delivery_service import get_google_email_delivery_service
from hushh_mcp.services.google_email_draft_service import get_google_email_draft_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/one/email-send", tags=["One Email Send"])


class _UserRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    user_id: str = Field(min_length=1, max_length=256)


class EmailSendConnectStart(_UserRequest):
    redirect_uri: str | None = Field(default=None, max_length=2048)
    login_hint: str | None = Field(default=None, max_length=512)


class EmailSendConnectComplete(_UserRequest):
    code: str = Field(min_length=1, max_length=2048)
    state: str = Field(min_length=1, max_length=1024)
    redirect_uri: str | None = Field(default=None, max_length=2048)


class EmailDraft(BaseModel):
    to: list[str] = Field(default_factory=list, max_length=60)
    cc: list[str] = Field(default_factory=list, max_length=60)
    bcc: list[str] = Field(default_factory=list, max_length=60)
    subject: str = Field(default="", max_length=512)
    body: str = Field(min_length=1, max_length=20_000)


class EmailSendPrepare(_UserRequest):
    draft: EmailDraft
    idempotency_key: str = Field(min_length=16, max_length=256)


class EmailSendExecute(_UserRequest):
    action_id: str = Field(min_length=12, max_length=256)
    draft: EmailDraft


class EmailDraftGenerate(_UserRequest):
    instruction: str = Field(min_length=1, max_length=8_000)


def _http(exc: Exception) -> HTTPException:
    if isinstance(exc, GoogleConnectionError):
        return HTTPException(
            status_code=exc.status_code,
            detail={"code": "GOOGLE_EMAIL_SEND_ERROR", "message": str(exc)},
        )
    logger.exception("one.email_send.unexpected_error type=%s", type(exc).__name__)
    return HTTPException(
        status_code=503,
        detail={
            "code": "GOOGLE_EMAIL_SEND_UNAVAILABLE",
            "message": "Email sending is temporarily unavailable.",
        },
    )


@router.post("/connect/start")
async def start_connect(
    payload: EmailSendConnectStart, firebase_uid: str = Depends(require_firebase_auth)
) -> dict[str, Any]:
    verify_user_id_match(firebase_uid, payload.user_id)
    try:
        return await get_google_connection_service().start(
            user_id=payload.user_id,
            service="gmail",
            access_level="send",
            redirect_uri=payload.redirect_uri,
            login_hint=payload.login_hint,
        )
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/connect/complete")
async def complete_connect(
    payload: EmailSendConnectComplete, firebase_uid: str = Depends(require_firebase_auth)
) -> dict[str, Any]:
    verify_user_id_match(firebase_uid, payload.user_id)
    try:
        return await get_google_connection_service().complete(
            user_id=payload.user_id,
            code=payload.code,
            state=payload.state,
            redirect_uri=payload.redirect_uri,
        )
    except Exception as exc:
        raise _http(exc) from exc


@router.get("/status/{user_id}")
async def send_status(
    user_id: str, firebase_uid: str = Depends(require_firebase_auth)
) -> dict[str, Any]:
    verify_user_id_match(firebase_uid, user_id)
    try:
        return get_google_connection_service().status(user_id=user_id, service="gmail")
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/prepare")
async def prepare_send(
    payload: EmailSendPrepare, token: dict = Depends(require_vault_owner_token)
) -> dict[str, Any]:
    verify_user_id_match(token["user_id"], payload.user_id)
    try:
        return await get_google_email_delivery_service().prepare(
            user_id=token["user_id"],
            draft=payload.draft.model_dump(),
            idempotency_key=payload.idempotency_key,
        )
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/draft")
async def generate_draft(
    payload: EmailDraftGenerate, token: dict = Depends(require_vault_owner_token)
) -> dict[str, Any]:
    verify_user_id_match(token["user_id"], payload.user_id)
    try:
        return await get_google_email_draft_service().draft(instruction=payload.instruction)
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/execute")
async def execute_send(
    payload: EmailSendExecute, token: dict = Depends(require_vault_owner_token)
) -> dict[str, Any]:
    verify_user_id_match(token["user_id"], payload.user_id)
    try:
        return await get_google_email_delivery_service().execute(
            user_id=token["user_id"], action_id=payload.action_id, draft=payload.draft.model_dump()
        )
    except Exception as exc:
        raise _http(exc) from exc
