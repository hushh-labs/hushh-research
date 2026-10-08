"""
Push notification token registration for consent (FCM/APNs).

Stores device tokens so the notification worker can send push when consent
requests are created (WhatsApp-style delivery when app is closed).
"""

import logging
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.concurrency import run_in_threadpool

from api.utils.firebase_auth import verify_firebase_bearer
from hushh_mcp.services.push_tokens_service import PushTokensService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/notifications", tags=["Notifications"])

Platform = Literal["web", "ios", "android"]


@router.post("/register")
async def register_push_token(request: Request):
    """
    Register FCM or APNs device token for the authenticated user.

    Call after login or when the user grants notification permission.
    One token per user per platform (latest wins). Requires Firebase ID token.
    """
    auth_header = request.headers.get("Authorization")
    firebase_uid = verify_firebase_bearer(auth_header)

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    user_id = body.get("user_id") or body.get("userId")
    token = body.get("token")
    platform = body.get("platform", "web")

    if not isinstance(user_id, str) or not isinstance(token, str) or not 1 <= len(token) <= 4096:
        raise HTTPException(
            status_code=400,
            detail="user_id and token are required",
        )
    if firebase_uid != user_id:
        raise HTTPException(
            status_code=403,
            detail="Cannot register token for another user",
        )
    if platform not in ("web", "ios", "android"):
        raise HTTPException(
            status_code=400,
            detail="platform must be one of: web, ios, android",
        )

    try:
        service = PushTokensService()
        token_id = await run_in_threadpool(
            service.upsert_user_push_token, user_id=user_id, token=token, platform=platform
        )
    except Exception as e:
        logger.error("Push token registration failed: %s", e)
        raise HTTPException(status_code=500, detail="Failed to register token")

    logger.info("Push token registered for user=%s platform=%s", user_id, platform)
    return {"ok": True, "user_id": user_id, "platform": platform, "id": token_id}


@router.delete("/unregister")
async def unregister_push_token(request: Request):
    """
    Unregister all FCM tokens for the authenticated user (logout flow).

    If `platform` is provided in the body, only that platform's token is removed.
    Otherwise all tokens for the user are removed.
    """
    auth_header = request.headers.get("Authorization")
    firebase_uid = verify_firebase_bearer(auth_header)

    try:
        body = await request.json()
    except Exception:
        body = {}

    user_id = body.get("user_id") or body.get("userId") or firebase_uid
    platform = body.get("platform")
    token = body.get("token")
    if token is not None and (
        not isinstance(token, str)
        or not 1 <= len(token) <= 4096
        or not isinstance(platform, str)
        or platform not in {"web", "ios", "android"}
    ):
        raise HTTPException(422, "A scoped push token and platform are required")

    if firebase_uid != user_id:
        raise HTTPException(
            status_code=403,
            detail="Cannot unregister tokens for another user",
        )

    try:
        service = PushTokensService()
        deleted = await run_in_threadpool(
            service.delete_user_push_tokens,
            user_id=user_id,
            platform=platform,
            **({"token": token} if token is not None else {}),
        )
    except Exception as e:
        logger.error("Push token unregister failed: %s", e)
        raise HTTPException(status_code=500, detail="Failed to unregister token(s)")

    logger.info(
        "Push token(s) unregistered for user=%s platform=%s deleted=%d", user_id, platform, deleted
    )
    return {"ok": True, "user_id": user_id, "deleted": deleted}
