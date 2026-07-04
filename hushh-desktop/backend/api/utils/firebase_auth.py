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
    import base64
    import json
    import time

    # Mitigate clock skew: if the token is issued in the future, wait for the server clock to catch up
    try:
        parts = id_token.split(".")
        if len(parts) >= 2:
            payload_b64 = parts[1]
            payload_b64 += "=" * ((4 - len(payload_b64) % 4) % 4)
            payload = json.loads(base64.urlsafe_b64decode(payload_b64).decode("utf-8"))
            iat = payload.get("iat")
            if iat:
                now = int(time.time())
                skew = iat - now
                if 0 < skew <= 10:
                    logger.info("Clock skew detected (token issued %ds in future). Sleeping %ds to catch up...", skew, skew + 1)
                    time.sleep(skew + 1)
    except Exception as exc:
        logger.debug("Failed to pre-decode token for clock skew check: %s", exc)

    try:
        firebase_app = get_firebase_auth_app()
        decoded = firebase_auth.verify_id_token(id_token, app=firebase_app)
        uid = decoded.get("uid")
        if not isinstance(uid, str) or not uid:
            raise HTTPException(status_code=401, detail="Invalid Firebase ID token")
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
    ) as exc:
        logger.warning("firebase.verify_id_token auth_error: %s (type=%s)", exc, type(exc).__name__)
        raise HTTPException(status_code=401, detail=f"Invalid Firebase ID token: {type(exc).__name__}") from None
    except firebase_auth.CertificateFetchError as exc:
        logger.error("firebase.verify_id_token certificate_fetch_failed: %s", exc)
        raise HTTPException(
            status_code=503,
            detail="Authentication service temporarily unavailable",
        ) from None
    except Exception as exc:
        logger.exception("firebase.verify_id_token unexpected_error: %s", exc)
        raise HTTPException(status_code=500, detail="Internal server error") from None
