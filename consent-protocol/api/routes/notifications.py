"""
Push notification token registration for consent (FCM/APNs).

Stores device tokens so the notification worker can send push when consent
requests are created (WhatsApp-style delivery when app is closed).
"""

import base64
import logging
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request

from api.utils.firebase_auth import verify_firebase_bearer
from hushh_mcp.services.push_tokens_service import PushTokensService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/notifications", tags=["Notifications"])

Platform = Literal["web", "ios", "android"]


def _device_fields(body: dict) -> dict:
    fields = {}
    for key in ("device_id", "preview_key_id"):
        if body.get(key) is not None:
            try:
                fields[key] = str(UUID(body[key]))
            except (ValueError, TypeError, AttributeError):
                raise HTTPException(400, "Invalid notification device identity") from None
    public = body.get("preview_public_key")
    if bool(public) != bool(fields.get("preview_key_id")) or (
        public and not fields.get("device_id")
    ):
        raise HTTPException(400, "Preview key and device identity must be supplied together")
    if public:
        try:
            from cryptography.hazmat.primitives.asymmetric.ec import (
                SECP256R1,
                EllipticCurvePublicKey,
            )

            if not isinstance(public, str) or len(public) != 87:
                raise ValueError()
            raw = base64.urlsafe_b64decode(public + "=")
            if base64.urlsafe_b64encode(raw).decode().rstrip("=") != public:
                raise ValueError()
            EllipticCurvePublicKey.from_encoded_point(SECP256R1(), raw)
        except (ValueError, TypeError):
            raise HTTPException(400, "Invalid notification preview key") from None
        fields["preview_public_key"] = public
    return fields


@router.post("/register")
async def register_push_token(request: Request):
    """
    Register FCM or APNs device token for the authenticated user.

    Call after login or when the user grants notification permission.
    One token per installation. Requires Firebase ID token.
    """
    auth_header = request.headers.get("Authorization")
    firebase_uid = verify_firebase_bearer(auth_header)

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    if not isinstance(body, dict):
        raise HTTPException(400, "Invalid JSON body")
    user_id = body.get("user_id") or body.get("userId")
    token = body.get("token")
    platform = body.get("platform", "web")

    if (
        not isinstance(user_id, str)
        or not isinstance(token, str)
        or not token.strip()
        or len(token) > 4096
    ):
        raise HTTPException(
            status_code=400,
            detail="user_id and token are required",
        )
    if firebase_uid != user_id:
        raise HTTPException(
            status_code=403,
            detail="Cannot register token for another user",
        )
    if not isinstance(platform, str) or platform not in ("web", "ios", "android"):
        raise HTTPException(
            status_code=400,
            detail="platform must be one of: web, ios, android",
        )

    device_fields = _device_fields(body)
    try:
        service = PushTokensService()
        token_id = service.upsert_user_push_token(
            user_id=user_id, token=token.strip(), platform=platform, **device_fields
        )
    except Exception as e:
        logger.error("Push token registration failed type=%s", type(e).__name__)
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

    if not isinstance(body, dict):
        raise HTTPException(400, "Invalid JSON body")
    user_id = body.get("user_id") or body.get("userId") or firebase_uid
    platform = body.get("platform")

    if firebase_uid != user_id:
        raise HTTPException(
            status_code=403,
            detail="Cannot unregister tokens for another user",
        )

    if platform is not None and platform not in ("web", "ios", "android"):
        raise HTTPException(400, "Invalid notification platform")
    device_fields = _device_fields({"device_id": body.get("device_id")})
    try:
        service = PushTokensService()
        deleted = service.delete_user_push_tokens(
            user_id=user_id, platform=platform, **device_fields
        )
    except Exception as e:
        logger.error("Push token unregister failed type=%s", type(e).__name__)
        raise HTTPException(status_code=500, detail="Failed to unregister token(s)")

    logger.info(
        "Push token(s) unregistered for user=%s platform=%s deleted=%d", user_id, platform, deleted
    )
    return {"ok": True, "user_id": user_id, "deleted": deleted}
