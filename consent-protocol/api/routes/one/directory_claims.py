"""Claim a White Pages listing ("Is this you?").

  GET    /api/one/directory-claims/me  -> the caller's active claim, if any
  POST   /api/one/directory-claims     -> claim a listing (pending until verified)
  DELETE /api/one/directory-claims/me  -> withdraw the active claim

Firebase-authenticated (hussh.ai calls this with the signed-in person's ID
token) and phone-verified. A claim stays pending until an operator verifies it
against the listing's public record; only then do the person's packets show.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException

from api.middleware import require_firebase_auth
from hushh_mcp.services.actor_identity_service import ActorIdentityService
from hushh_mcp.services.directory_claim_service import ClaimError, DirectoryClaimService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/directory-claims", tags=["One Directory Claims"])


def _service() -> DirectoryClaimService:
    return DirectoryClaimService()


async def _require_verified_phone(firebase_uid: str) -> None:
    """Same phone admission as One's browser flow; sync first so a phone verified
    moments ago on hussh.ai counts on the first request."""
    identities = ActorIdentityService()
    try:
        await identities.sync_from_firebase(firebase_uid, force=False)
    except Exception:
        logger.warning("directory_claims.identity_sync_failed")
    identity = (await identities.get_many([firebase_uid])).get(firebase_uid) or {}
    if identity.get("phone_verified") is not True:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "VERIFIED_PHONE_REQUIRED",
                "message": "Verify your phone number to claim a listing.",
            },
        )


@router.get("/me")
async def get_my_claim(firebase_uid: str = Depends(require_firebase_auth)) -> dict[str, Any]:
    return {"claim": await _service().active_claim(user_id=firebase_uid)}


@router.post("")
async def create_claim(
    body: dict[str, Any] = Body(...),
    firebase_uid: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    await _require_verified_phone(firebase_uid)
    try:
        claim = await _service().create_claim(
            user_id=firebase_uid,
            listing_id=body.get("listingId"),
            listing_name=body.get("listingName"),
        )
    except ClaimError as exc:
        status = 409 if exc.code in {"ALREADY_CLAIMED_ANOTHER", "LISTING_ALREADY_VERIFIED"} else 400
        raise HTTPException(
            status_code=status, detail={"code": exc.code, "message": str(exc)}
        ) from None
    return {"claim": claim}


@router.delete("/me")
async def withdraw_my_claim(firebase_uid: str = Depends(require_firebase_auth)) -> dict[str, Any]:
    return {"withdrawn": await _service().withdraw_claim(user_id=firebase_uid)}
