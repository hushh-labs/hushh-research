"""
Push notification token registration for consent (FCM/APNs).

Stores device tokens so the notification worker can send push when consent
requests are created (WhatsApp-style delivery when app is closed).

Security hardening applied:
- Added max_length bounds to device token and user_id fields (CWE-400)
- Replaced unbounded body dict access with typed Pydantic request models
- Moved synchronous PushTokensService calls off the event loop via run_in_threadpool
"""

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from api.middleware import require_firebase_auth
from hushh_mcp.services.push_tokens_service import PushTokensService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/notifications", tags=["Notifications"])

Platform = Literal["web", "ios", "android"]

# FCM tokens are at most 163 chars; APNs hex device tokens are 128 chars.
# 256 provides a safe margin without accepting unbounded input.
_MAX_PUSH_TOKEN_LENGTH = 256
_MAX_USER_ID_LENGTH = 128


class RegisterPushTokenRequest(BaseModel):
    """Typed request body for push token registration."""

    user_id: str = Field(min_length=1, max_length=_MAX_USER_ID_LENGTH)
    token: str = Field(min_length=1, max_length=_MAX_PUSH_TOKEN_LENGTH)
    platform: Platform = Field(default="web")


class UnregisterPushTokenRequest(BaseModel):
    """Typed request body for push token unregistration. user_id is optional."""

    user_id: str | None = Field(default=None, max_length=_MAX_USER_ID_LENGTH)
    platform: Platform | None = Field(default=None)


@router.post("/register")
async def register_push_token(
    body: RegisterPushTokenRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """
    Register FCM or APNs device token for the authenticated user.

    Call after login or when the user grants notification permission.
    One token per user per platform (latest wins). Requires Firebase ID token.
    """
    if firebase_uid != body.user_id:
        raise HTTPException(
            status_code=403,
            detail="Cannot register token for another user",
        )

    try:
        service = PushTokensService()
        token_id = await run_in_threadpool(
            service.upsert_user_push_token,
            user_id=body.user_id,
            token=body.token,
            platform=body.platform,
        )
    except Exception as e:
        logger.error(
            "Push token registration failed user_id=%s platform=%s: %s",
            body.user_id,
            body.platform,
            e,
        )
        raise HTTPException(status_code=500, detail="Failed to register token")

    logger.info("Push token registered user_id=%s platform=%s", body.user_id, body.platform)
    return {"ok": True, "user_id": body.user_id, "platform": body.platform, "id": token_id}


@router.delete("/unregister")
async def unregister_push_token(
    body: UnregisterPushTokenRequest | None = None,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """
    Unregister FCM tokens for the authenticated user (logout flow).

    If platform is provided in the body, only that platform's token is removed.
    If user_id is omitted, defaults to the authenticated Firebase UID.
    """
    user_id = (body.user_id if body and body.user_id else None) or firebase_uid

    if firebase_uid != user_id:
        raise HTTPException(
            status_code=403,
            detail="Cannot unregister tokens for another user",
        )

    platform = body.platform if body else None

    try:
        service = PushTokensService()
        deleted = await run_in_threadpool(
            service.delete_user_push_tokens,
            user_id=user_id,
            platform=platform,
        )
    except Exception as e:
        logger.error("Push token unregister failed user_id=%s: %s", user_id, e)
        raise HTTPException(status_code=500, detail="Failed to unregister token(s)")

    logger.info(
        "Push token(s) unregistered user_id=%s platform=%s deleted=%d",
        user_id,
        platform,
        deleted,
    )
    return {"ok": True, "user_id": user_id, "deleted": deleted}
