# consent-protocol/api/routes/account.py
"""
Account API Routes
==================

Endpoints for account lifecycle management.

Routes:
    POST /api/account/identity/refresh - Refresh backend identity shadow from Firebase Auth
    GET /api/account/email-aliases - List verified/pending account email aliases
    POST /api/account/email-aliases/verification/start - Start alias verification
    POST /api/account/email-aliases/verification/confirm - Confirm alias verification
    DELETE /api/account/delete - Delete account and all data
    GET /api/account/export - Export encrypted account data bundle

Security:
    Identity refresh requires Firebase auth.
    Email aliases, delete, and export require VAULT_OWNER token.
"""

import logging
from typing import Literal

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel, Field

from api.middleware import require_firebase_auth, require_vault_owner_token
from hushh_mcp.services.account_service import AccountService
from hushh_mcp.services.actor_identity_service import (
    ActorIdentityAliasError,
    ActorIdentityService,
)

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


class EmailAliasVerificationStartRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)


class EmailAliasVerificationConfirmRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    verification_code: str = Field(min_length=1, max_length=64)


def _raise_alias_error(exc: ActorIdentityAliasError) -> None:
    raise HTTPException(
        status_code=exc.status_code,
        detail={"code": exc.code, "message": str(exc)},
    ) from exc


@router.get("/email-aliases")
async def list_email_aliases(token_data: dict = Depends(require_vault_owner_token)):
    """List account-owned verified email aliases."""
    user_id = token_data["user_id"]
    aliases = await ActorIdentityService().list_verified_email_aliases(user_id)
    return {"success": True, "user_id": user_id, "aliases": aliases}


@router.post("/email-aliases/verification/start")
async def start_email_alias_verification(
    payload: EmailAliasVerificationStartRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    """Start verification for an account-owned email alias."""
    user_id = token_data["user_id"]
    try:
        result = await ActorIdentityService().request_email_alias_verification(
            user_id=user_id,
            email=payload.email,
        )
    except ActorIdentityAliasError as exc:
        _raise_alias_error(exc)
    return {"success": True, "user_id": user_id, **result}


@router.post("/email-aliases/verification/confirm")
async def confirm_email_alias_verification(
    payload: EmailAliasVerificationConfirmRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    """Confirm an account-owned email alias verification code."""
    user_id = token_data["user_id"]
    try:
        alias = await ActorIdentityService().confirm_email_alias_verification(
            user_id=user_id,
            email=payload.email,
            verification_code=payload.verification_code,
        )
    except ActorIdentityAliasError as exc:
        _raise_alias_error(exc)
    return {"success": True, "user_id": user_id, "alias": alias}


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


@router.get("/export")
async def export_account_data(token_data: dict = Depends(require_vault_owner_token)):
    """
    Export logged-in user's account data bundle.

    Returns encrypted/private-user-bound payloads only. No plaintext PKM content.
    Requires VAULT_OWNER token.
    """
    user_id = token_data["user_id"]
    logger.info("Account export requested for user %s", user_id)

    service = AccountService()
    result = await service.export_data(user_id)

    if not result["success"]:
        raise HTTPException(status_code=500, detail="Account export failed")

    return result
