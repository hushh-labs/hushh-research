"""Vault-gated owner-approved Gmail delivery routes.

These endpoints are separate from One's platform-mailbox KYC workflow.  They
use the user's existing Gmail receipts connection and never accept OAuth tokens
or a sender address from the caller.
"""

from __future__ import annotations

import logging
from typing import Any, cast

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from api.middleware import require_firebase_auth, require_vault_owner_token
from hushh_mcp.services.gmail_delivery_service import GmailDeliveryError, get_gmail_delivery_service
from hushh_mcp.services.gmail_receipts_service import GmailApiError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one", tags=["One Gmail Delivery"])


class EmailDraftRequest(BaseModel):
    instruction: str = Field(min_length=1, max_length=12_000)


class EmailEnvelope(BaseModel):
    # The compact draft card submits comma-separated strings; API consumers may
    # also use structured lists.  Service normalization remains the authority.
    to: str | list[str] = Field(default_factory=list)
    cc: str | list[str] = Field(default_factory=list)
    bcc: str | list[str] = Field(default_factory=list)
    subject: str = Field(default="", max_length=256)
    body: str = Field(default="", max_length=50_000)
    # This optional representation is independently sanitized by the Gmail
    # owner delivery service before it becomes part of the reviewed envelope.
    html_body: str | None = Field(default=None, max_length=50_000)


class EmailPrepareRequest(EmailEnvelope):
    idempotency_key: str = Field(min_length=16, max_length=256)


class EmailSendRequest(EmailEnvelope):
    action_id: str = Field(min_length=1, max_length=128)


def _owner_user_id(*, firebase_uid: str, token_data: dict[str, Any]) -> str:
    owner_user_id = str(token_data.get("user_id") or "").strip()
    if not owner_user_id or owner_user_id != firebase_uid:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "GMAIL_DELIVERY_USER_MISMATCH",
                "message": "Gmail delivery requires the current vault owner.",
            },
        )
    return owner_user_id


def _as_http_error(exc: Exception) -> HTTPException:
    if isinstance(exc, GmailDeliveryError):
        return HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": exc.message},
        )
    if isinstance(exc, GmailApiError):
        return HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code or "GMAIL_SEND_NOT_READY", "message": str(exc)},
        )
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail={
            "code": "GMAIL_DELIVERY_UNAVAILABLE",
            "message": "Gmail delivery is temporarily unavailable. Please try again.",
        },
    )


@router.post("/email/draft")
async def gmail_email_draft(
    payload: EmailDraftRequest,
    firebase_uid: str = Depends(require_firebase_auth),
    token_data: dict[str, Any] = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    _owner_user_id(
        firebase_uid=firebase_uid,
        token_data=token_data,
    )
    try:
        return cast(
            dict[str, Any],
            await get_gmail_delivery_service().draft_from_instruction(
                instruction=payload.instruction
            ),
        )
    except Exception as exc:
        logger.warning("one.gmail_delivery.draft_failed error=%s", type(exc).__name__)
        raise _as_http_error(exc) from exc


@router.post("/email/prepare")
async def gmail_email_prepare(
    payload: EmailPrepareRequest,
    firebase_uid: str = Depends(require_firebase_auth),
    token_data: dict[str, Any] = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    user_id = _owner_user_id(
        firebase_uid=firebase_uid,
        token_data=token_data,
    )
    try:
        return cast(
            dict[str, Any],
            await get_gmail_delivery_service().prepare(
                user_id=user_id,
                draft_payload=payload.model_dump(exclude={"idempotency_key"}),
                idempotency_key=payload.idempotency_key,
            ),
        )
    except Exception as exc:
        logger.warning("one.gmail_delivery.prepare_failed error=%s", type(exc).__name__)
        raise _as_http_error(exc) from exc


@router.post("/email/send")
async def gmail_email_send(
    payload: EmailSendRequest,
    firebase_uid: str = Depends(require_firebase_auth),
    token_data: dict[str, Any] = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    user_id = _owner_user_id(
        firebase_uid=firebase_uid,
        token_data=token_data,
    )
    try:
        return cast(
            dict[str, Any],
            await get_gmail_delivery_service().execute(
                user_id=user_id,
                action_id=payload.action_id,
                draft_payload=payload.model_dump(exclude={"action_id"}),
            ),
        )
    except Exception as exc:
        logger.warning("one.gmail_delivery.send_failed error=%s", type(exc).__name__)
        raise _as_http_error(exc) from exc
