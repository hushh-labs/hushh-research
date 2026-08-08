"""
Firebase ID token verification helper.

Used by endpoints that require identity verification (Firebase Auth boundary).
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import HTTPException

from api.utils.firebase_admin import ensure_firebase_auth_admin, get_firebase_auth_app

logger = logging.getLogger(__name__)


def verify_firebase_bearer(authorization: Optional[str]) -> str:
    """
    Verify `Authorization: Bearer <firebaseIdToken>` and return UID.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Authorization header")

    configured, _ = ensure_firebase_auth_admin()
    if not configured:
        # Backend misconfiguration (common in local dev)
        raise HTTPException(status_code=500, detail="Firebase Admin not configured")

    id_token = authorization.removeprefix("Bearer ").strip()
    if not id_token:
        raise HTTPException(status_code=401, detail="Missing bearer token")

    from firebase_admin import auth as firebase_auth

    try:
        firebase_app = get_firebase_auth_app()
        # check_revoked=True rejects tokens from disabled accounts or sessions
        # that were force-revoked (e.g. remote sign-out / device loss), instead of
        # honoring them until natural ~1h expiry. The revoked/disabled cases are
        # already handled in the except block below.
        decoded = firebase_auth.verify_id_token(id_token, app=firebase_app, check_revoked=True)
        uid = decoded.get("uid")
        if not isinstance(uid, str) or not uid:
            raise HTTPException(status_code=401, detail="Invalid Firebase ID token")

        device_id = str(decoded.get("trusted_device_id") or "").strip()
        if device_id:
            # A trusted-device Firebase session remains valid only while its
            # server-side device registration is active. This check is
            # independent of rollout flags so disabling enrollment cannot
            # accidentally preserve a revoked device session.
            from hushh_mcp.services.trusted_device_service import TrustedDeviceService

            try:
                active = TrustedDeviceService().is_active_device(
                    user_id=uid,
                    device_id=device_id,
                )
            except Exception:
                logger.exception(
                    "firebase.trusted_device_status_unavailable uid=%s device_id=%s",
                    uid,
                    device_id,
                )
                raise HTTPException(
                    status_code=503,
                    detail="Trusted-device status temporarily unavailable",
                ) from None
            if not active:
                raise HTTPException(
                    status_code=401,
                    detail="Trusted-device session is no longer active",
                )
        return uid
    except HTTPException:
        raise
    except ValueError as exc:
        logger.warning("firebase.verify_id_token value_error: %s", exc)
        raise HTTPException(status_code=401, detail="Invalid Firebase ID token") from None
    except (
        firebase_auth.InvalidIdTokenError,
        firebase_auth.ExpiredIdTokenError,
        firebase_auth.RevokedIdTokenError,
        firebase_auth.UserDisabledError,
        # check_revoked=True looks the user up, so a just-deleted account's
        # replayed token raises this. It is a 401 (sign in again), not a 500.
        firebase_auth.UserNotFoundError,
    ):
        raise HTTPException(status_code=401, detail="Invalid Firebase ID token") from None
    except firebase_auth.CertificateFetchError as exc:
        logger.error("firebase.verify_id_token certificate_fetch_failed: %s", exc)
        raise HTTPException(
            status_code=503,
            detail="Authentication service temporarily unavailable",
        ) from None
    except Exception as exc:
        logger.exception("firebase.verify_id_token unexpected_error: %s", exc)
        raise HTTPException(status_code=500, detail="Internal server error") from None
