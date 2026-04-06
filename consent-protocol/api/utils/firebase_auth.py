"""
Firebase ID token verification helper.

Used by endpoints that require identity verification (Firebase Auth boundary).
"""

from __future__ import annotations

from typing import Optional

from fastapi import HTTPException

from api.utils.firebase_admin import ensure_firebase_admin, get_firebase_auth_app


def verify_firebase_bearer(authorization: Optional[str]) -> str:
    """
    Verify `Authorization: Bearer <firebaseIdToken>` and return UID.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Authorization header")

    configured, _ = ensure_firebase_admin()
    if not configured:
        # Backend misconfiguration (common in local dev)
        raise HTTPException(status_code=500, detail="Firebase Admin not configured")

    id_token = authorization.removeprefix("Bearer ").strip()
    if not id_token:
        raise HTTPException(status_code=401, detail="Missing bearer token")

    try:
        from firebase_admin import auth as firebase_auth

        firebase_app = get_firebase_auth_app()
        decoded = firebase_auth.verify_id_token(id_token, app=firebase_app)
        uid = decoded.get("uid")
        if not isinstance(uid, str) or not uid:
            raise HTTPException(status_code=401, detail="Invalid Firebase ID token")
        return uid
    except HTTPException:
        raise
    except Exception:
        # Do not leak details
        raise HTTPException(status_code=401, detail="Invalid Firebase ID token")
