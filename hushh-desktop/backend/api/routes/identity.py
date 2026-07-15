# api/routes/identity.py
"""Deprecated identity routes.

Legacy identity APIs are intentionally disabled during regulated cutover.
Routes are kept for one compatibility release and return 410 Gone.
"""

from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/identity", tags=["Identity Resolution"])

_DEPRECATION_DETAIL = {
    "error_code": "IDENTITY_ROUTES_DEPRECATED",
    "message": "Identity routes are deprecated and disabled in this release.",
}


def _raise_deprecated() -> None:
    raise HTTPException(status_code=410, detail=_DEPRECATION_DETAIL)


@router.get("/auto-detect")
async def auto_detect_investor():
    _raise_deprecated()


@router.post("/confirm")
async def confirm_identity():
    _raise_deprecated()


@router.get("/status")
async def get_identity_status():
    _raise_deprecated()


@router.post("/profile")
async def get_encrypted_profile():
    _raise_deprecated()


@router.delete("/profile")
async def delete_identity():
    _raise_deprecated()
