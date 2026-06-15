"""
Firebase ID token verification helper.

Used by endpoints that require identity verification (Firebase Auth boundary).
"""

from __future__ import annotations

import logging
import time
from typing import Optional

from fastapi import HTTPException

from api.utils.firebase_admin import ensure_firebase_auth_admin, get_firebase_auth_app

logger = logging.getLogger(__name__)

_TOKEN_USED_TOO_EARLY_RETRY_SECONDS = 12


def _is_token_used_too_early_error(exc: Exception) -> bool:
    return "used too early" in str(exc).lower()


def verify_firebase_bearer(
    authorization: Optional[str],
    *,
    retry_token_used_too_early: bool = False,
) -> str:
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
        deadline = time.monotonic() + _TOKEN_USED_TOO_EARLY_RETRY_SECONDS
        while True:
            try:
                decoded = firebase_auth.verify_id_token(id_token, app=firebase_app)
                break
            except firebase_auth.InvalidIdTokenError as exc:
                if (
                    not retry_token_used_too_early
                    or not _is_token_used_too_early_error(exc)
                    or time.monotonic() >= deadline
                ):
                    raise
                time.sleep(1)
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
