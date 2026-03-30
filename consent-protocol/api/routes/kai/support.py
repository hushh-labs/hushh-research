"""Kai support messaging routes."""

from __future__ import annotations

import logging
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field, field_validator

from api.middleware import require_firebase_auth, verify_user_id_match
from hushh_mcp.services.support_email_service import (
    SupportEmailNotConfiguredError,
    SupportEmailSendError,
    get_support_email_service,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Kai Support"])
_SUPPORT_EMAIL_UNAVAILABLE_MESSAGE = (
    "Support messaging is temporarily unavailable right now. Please try again later."
)
_SUPPORT_EMAIL_DELIVERY_FAILED_MESSAGE = (
    "We couldn't send your message right now. Please try again later."
)
_SUPPORT_EMAIL_UNEXPECTED_MESSAGE = (
    "We hit an unexpected problem while sending your message. Please try again later."
)


class SupportMessageRequest(BaseModel):
    user_id: str
    kind: Literal["bug_report", "support_request", "developer_reachout"]
    subject: str = Field(min_length=3, max_length=140)
    message: str = Field(min_length=10, max_length=8000)
    user_email: Optional[str] = Field(default=None, max_length=320)
    user_display_name: Optional[str] = Field(default=None, max_length=120)
    persona: Optional[str] = Field(default=None, max_length=40)
    page_url: Optional[str] = Field(default=None, max_length=1000)

    @field_validator("subject")
    @classmethod
    def validate_subject(cls, value: str) -> str:
        text = value.strip()
        if len(text) < 3:
            raise ValueError("Subject must contain at least 3 non-whitespace characters.")
        return text

    @field_validator("message")
    @classmethod
    def validate_message(cls, value: str) -> str:
        text = value.strip()
        if len(text) < 10:
            raise ValueError("Message must contain at least 10 non-whitespace characters.")
        return text


@router.post("/support/message")
async def send_support_message(
    payload: SupportMessageRequest,
    request: Request,
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, payload.user_id)
    try:
        return get_support_email_service().send_message(
            kind=payload.kind,
            subject=payload.subject,
            message=payload.message,
            user_id=payload.user_id,
            user_email=(payload.user_email or "").strip() or None,
            user_display_name=(payload.user_display_name or "").strip() or None,
            persona=(payload.persona or "").strip() or None,
            page_url=(payload.page_url or "").strip() or None,
            user_agent=request.headers.get("user-agent"),
        )
    except SupportEmailNotConfiguredError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "SUPPORT_EMAIL_NOT_CONFIGURED",
                "message": _SUPPORT_EMAIL_UNAVAILABLE_MESSAGE,
            },
        ) from exc
    except SupportEmailSendError as exc:
        logger.exception("kai.support.send_failed user_id=%s", payload.user_id)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={
                "code": "SUPPORT_EMAIL_SEND_FAILED",
                "message": _SUPPORT_EMAIL_DELIVERY_FAILED_MESSAGE,
            },
        ) from exc
    except Exception as exc:
        logger.exception("kai.support.unexpected_failure user_id=%s", payload.user_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "SUPPORT_MESSAGE_FAILED",
                "message": _SUPPORT_EMAIL_UNEXPECTED_MESSAGE,
            },
        ) from exc
