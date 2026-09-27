"""Kai support messaging routes."""

from __future__ import annotations

import logging
from functools import partial
from typing import Literal, Optional
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from api.middleware import require_firebase_auth, verify_user_id_match
from api.utils.firebase_admin import get_firebase_auth_app
from hushh_mcp.services.support_email_service import (
    SupportEmailDeliveryUncertainError,
    SupportEmailNotConfiguredError,
    SupportEmailSendError,
    get_support_email_service,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Kai Support"])


class SupportMessageRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=128)
    kind: Literal["bug_report", "support_request", "developer_reachout"]
    subject: str = Field(min_length=3, max_length=140)
    message: str = Field(min_length=10, max_length=8000)
    user_email: Optional[str] = Field(default=None, max_length=320)
    user_display_name: Optional[str] = Field(default=None, max_length=120)
    persona: Optional[str] = Field(default=None, max_length=40)
    page_url: Optional[str] = Field(default=None, max_length=1000)


@router.post("/support/message")
async def send_support_message(
    payload: SupportMessageRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, payload.user_id)
    try:
        support_email_service = get_support_email_service()
        cfg = support_email_service.config
        if not cfg.configured:
            raise SupportEmailNotConfiguredError("Support email is not configured")

        app = get_firebase_auth_app()
        if app is None:
            raise HTTPException(status_code=503, detail={"code": "ACCOUNT_LOOKUP_UNAVAILABLE"})
        from firebase_admin import auth as firebase_auth

        account = await run_in_threadpool(firebase_auth.get_user, firebase_uid, app=app)
        verified_email = (
            str(account.email).strip()
            if getattr(account, "email_verified", False) and getattr(account, "email", None)
            else None
        )
        page_path = urlsplit(payload.page_url or "").path[:256] or None
        await run_in_threadpool(
            partial(
                support_email_service.send_message,
                kind=payload.kind,
                subject=payload.subject.strip(),
                message=payload.message.strip(),
                user_id=firebase_uid,
                user_email=verified_email,
                user_display_name=getattr(account, "display_name", None),
                persona=(payload.persona or "").strip() or None,
                page_url=page_path,
                user_agent=None,
            )
        )
        logger.info("support_email.accepted kind=%s", payload.kind)
        return {
            "accepted": True,
            "delivery_status": "accepted_by_provider",
            "kind": payload.kind,
        }
    except HTTPException:
        raise
    except SupportEmailNotConfiguredError as exc:
        logger.warning("support_email.not_configured")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "SUPPORT_EMAIL_NOT_CONFIGURED",
                "message": "Support messaging is temporarily unavailable.",
            },
        ) from exc
    except SupportEmailDeliveryUncertainError as exc:
        logger.warning("support_email.uncertain")
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail={
                "code": "SUPPORT_DELIVERY_UNCERTAIN",
                "message": "Delivery could not be confirmed. Please wait before retrying.",
            },
        ) from exc
    except SupportEmailSendError as exc:
        logger.error("support_email.failed")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={
                "code": "SUPPORT_DELIVERY_FAILED",
                "message": "We could not send your message.",
            },
        ) from exc
    except Exception as exc:
        logger.error("support_email.unexpected_failure error_type=%s", type(exc).__name__)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "SUPPORT_MESSAGE_FAILED",
                "message": "We could not send your message.",
            },
        ) from exc
