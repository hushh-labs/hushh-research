"""Kai support messaging routes."""

from __future__ import annotations

import logging
from functools import partial
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from api.middleware import require_firebase_auth, verify_user_id_match
from hushh_mcp.services.email_delivery_queue_service import get_email_delivery_queue_service
from hushh_mcp.services.support_email_service import (
    SupportEmailNotConfiguredError,
    get_support_email_service,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Kai Support"])


class SupportMessageRequest(BaseModel):
    user_id: str
    kind: Literal["bug_report", "support_request", "developer_reachout"]
    subject: str = Field(min_length=3, max_length=140)
    message: str = Field(min_length=10, max_length=8000)
    user_email: Optional[str] = Field(default=None, max_length=320)
    user_display_name: Optional[str] = Field(default=None, max_length=120)
    persona: Optional[str] = Field(default=None, max_length=40)
    page_url: Optional[str] = Field(default=None, max_length=1000)


@router.post("/support/message", status_code=status.HTTP_202_ACCEPTED)
async def send_support_message(
    payload: SupportMessageRequest,
    request: Request,
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, payload.user_id)
    try:
        support_email_service = get_support_email_service()
        cfg = support_email_service.config
        if not cfg.configured:
            raise SupportEmailNotConfiguredError(
                "Support email is not configured. Provide SUPPORT_EMAIL_SERVICE_ACCOUNT_JSON "
                "or FIREBASE_ADMIN_CREDENTIALS_JSON / FIREBASE_SERVICE_ACCOUNT_JSON, plus "
                "SUPPORT_EMAIL_* variables."
            )

        queue_result = await get_email_delivery_queue_service().enqueue(
            kind="support_message",
            send_callable=partial(
                support_email_service.send_message,
                kind=payload.kind,
                subject=payload.subject.strip(),
                message=payload.message.strip(),
                user_id=payload.user_id,
                user_email=(payload.user_email or "").strip() or None,
                user_display_name=(payload.user_display_name or "").strip() or None,
                persona=(payload.persona or "").strip() or None,
                page_url=(payload.page_url or "").strip() or None,
                user_agent=request.headers.get("user-agent"),
            ),
            context={
                "user_id": payload.user_id,
                "kind": payload.kind,
                "subject": payload.subject.strip(),
            },
        )
        return {
            "accepted": True,
            "delivery_status": queue_result["delivery_status"],
            "job_id": queue_result["job_id"],
            "kind": payload.kind,
            "delivery_mode": cfg.delivery_mode,
            "recipient": cfg.effective_recipient,
            "intended_recipient": cfg.support_to_email,
            "from_email": cfg.from_email,
        }
    except SupportEmailNotConfiguredError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "SUPPORT_EMAIL_NOT_CONFIGURED",
                "message": str(exc),
            },
        ) from exc
    except Exception as exc:
        logger.exception("kai.support.unexpected_failure user_id=%s", payload.user_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "SUPPORT_MESSAGE_FAILED",
                "message": str(exc),
            },
        ) from exc
