# consent-protocol/api/routes/account.py
"""
Account API Routes
==================

Endpoints for account lifecycle management.

Routes:
    POST /api/account/identity/refresh - Refresh backend identity shadow from Firebase Auth
    DELETE /api/account/delete - Delete account and all data

Security:
    Identity refresh requires Firebase auth.
    Delete requires VAULT_OWNER token.
"""

import logging
from typing import Literal

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel, Field

from api.middleware import require_firebase_auth, require_vault_owner_token
from hushh_mcp.services.account_service import AccountService
from hushh_mcp.services.actor_identity_service import ActorIdentityService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/account", tags=["Account"])


@router.post("/identity/refresh")
async def refresh_account_identity(
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Refresh the backend account identity shadow from Firebase Auth."""
    identity = await ActorIdentityService().sync_from_firebase(firebase_uid, force=True)
    return {
        "success": True,
        "user_id": firebase_uid,
        "identity": identity,
    }


class DeleteAccountRequest(BaseModel):
    target: Literal["investor", "ria", "both"] = Field(
        default="both",
        description="Delete only the investor persona, only the RIA persona, or the full account.",
    )


@router.delete("/delete")
async def delete_account(
    payload: DeleteAccountRequest | None = Body(default=None),
    token_data: dict = Depends(require_vault_owner_token),
):
    """
    Delete logged-in user's account and ALL data.

    Requires VAULT_OWNER token (Unlock to Delete).
    This action is irreversible.
    """
    user_id = token_data["user_id"]
    target = payload.target if payload else "both"
    logger.warning("⚠️ DELETE ACCOUNT REQUESTED for user %s target=%s", user_id, target)

    service = AccountService()
    result = await service.delete_account(user_id, target=target)

    if not result["success"]:
        raise HTTPException(status_code=500, detail=f"Deletion failed: {result.get('error')}")

    return result
