"""
Development-only diagnostics for Firebase Admin verification.
"""

import os

from fastapi import APIRouter, Header, HTTPException

from api.utils.firebase_admin import ensure_firebase_auth_admin
from api.utils.firebase_auth import verify_firebase_bearer

router = APIRouter(prefix="/api/_debug", tags=["Debug"])


def _is_dev() -> bool:
    env = (os.environ.get("ENVIRONMENT") or "").lower()
    return env in ("dev", "development", "local")


@router.get("/firebase")
async def debug_firebase(authorization: str = Header(..., description="Bearer Firebase ID token")):
    """
    Validate backend Firebase Admin config + Firebase ID token verification.
    Only available in development.
    """
    if not _is_dev():
        raise HTTPException(status_code=404, detail="Not found")

    configured, project_id = ensure_firebase_auth_admin()
    if not configured:
        raise HTTPException(status_code=500, detail="Firebase Admin not configured")

    uid = verify_firebase_bearer(authorization)
    return {"ok": True, "uid": uid, "firebase_project_id": project_id}
