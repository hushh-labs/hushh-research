"""
Development-only diagnostics for Firebase Admin verification.
"""

import os

from fastapi import APIRouter, Header, HTTPException

from api.utils.firebase_admin import ensure_firebase_auth_admin
from api.utils.firebase_auth import verify_firebase_bearer

router = APIRouter(prefix="/api/_debug", tags=["Debug"])


def _is_dev() -> bool:
    """Genuinely local only — never a hosted deployment that happens to be named dev.

    This used to be the environment name alone, which was safe only because the dev
    deployment reported `uat`. Now that dev reports `dev`, the name by itself would
    have opened this diagnostic on an internet-reachable service: exactly the
    regression `docs/reference/dev-environment-setup.md` warned about when it said
    the string `dev` must not be used as `ENVIRONMENT`.

    The deploy lane is the signal that separates the two. It is written by the deploy
    workflow for every hosted lane and is absent on a developer's machine, so an
    empty lane is what "local" actually means. The environment name is still required
    as well — this narrows the route, it never widens it.
    """
    from hushh_mcp.services.dev_simulation_guard import deploy_lane

    if deploy_lane():
        return False
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
