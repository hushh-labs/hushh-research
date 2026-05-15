# consent-protocol/api/routes/account.py
"""
Account API Routes
==================

Endpoints for account lifecycle management.

Routes:
    POST /api/account/identity/refresh - Refresh backend identity shadow from Firebase Auth
    POST /api/account/phone/claim - Claim a Firebase-verified phone for the signed-in actor
    GET /api/account/email-aliases - List verified/pending account email aliases
    POST /api/account/email-aliases/verification/start - Start alias verification
    POST /api/account/email-aliases/verification/confirm - Confirm alias verification
    DELETE /api/account/delete - Delete account and all data
    GET /api/account/export - Export encrypted account data bundle

Security:
    Identity refresh and phone claim require Firebase auth.
    Email aliases, delete, and export require VAULT_OWNER token.
"""

import logging
from typing import Any, Literal

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.utils.firebase_admin import get_firebase_auth_app
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


class PhoneClaimRequest(BaseModel):
    phone_id_token: str = Field(min_length=1, max_length=20_000)


def _raise_alias_error(exc: ActorIdentityAliasError) -> None:
    raise HTTPException(
        status_code=exc.status_code,
        detail={"code": exc.code, "message": str(exc)},
    ) from exc


async def _verify_phone_claim_id_token(raw_token: str) -> tuple[str, str | None]:
    normalized_token = str(raw_token or "").strip()
    if not normalized_token:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "PHONE_ID_TOKEN_REQUIRED",
                "message": "A phone verification token is required.",
            },
        )

    try:
        from firebase_admin import auth as firebase_auth

        firebase_app = get_firebase_auth_app()
        decoded = await run_in_threadpool(
            lambda: firebase_auth.verify_id_token(normalized_token, app=firebase_app)
        )
    except Exception as exc:
        logger.info("Phone claim token verification failed: %s", type(exc).__name__)
        raise HTTPException(
            status_code=401,
            detail={
                "code": "INVALID_PHONE_ID_TOKEN",
                "message": "The phone verification token is invalid or expired.",
            },
        ) from exc

    claims: dict[str, Any] = dict(decoded or {})
    firebase_claims = claims.get("firebase")
    sign_in_provider = (
        str(firebase_claims.get("sign_in_provider") or "").strip()
        if isinstance(firebase_claims, dict)
        else ""
    )
    if sign_in_provider != "phone":
        raise HTTPException(
            status_code=401,
            detail={
                "code": "PHONE_ID_TOKEN_PROVIDER_MISMATCH",
                "message": "The phone verification token must come from Firebase phone auth.",
            },
        )

    phone_number = str(claims.get("phone_number") or "").strip()
    if not phone_number:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "PHONE_ID_TOKEN_MISSING_PHONE_NUMBER",
                "message": "The phone verification token does not contain a phone number.",
            },
        )

    phone_session_uid = str(claims.get("uid") or claims.get("sub") or "").strip() or None
    return phone_number, phone_session_uid


async def _delete_firebase_auth_user(user_id: str) -> str:
    """Delete the Firebase Auth identity after backend account data is removed."""
    try:
        from firebase_admin import auth as firebase_auth
    except Exception as exc:
        logger.exception("Firebase Auth SDK unavailable while deleting %s", user_id)
        raise HTTPException(
            status_code=500,
            detail={
                "code": "FIREBASE_AUTH_DELETE_FAILED",
                "message": "Backend account data was deleted, but Firebase Auth identity deletion failed.",
            },
        ) from exc

    try:
        firebase_app = get_firebase_auth_app()
        if firebase_app is None:
            raise RuntimeError("Firebase Admin is not configured")

        await run_in_threadpool(lambda: firebase_auth.delete_user(user_id, app=firebase_app))
        logger.info("Firebase Auth user deleted for %s", user_id)
        return "deleted"
    except firebase_auth.UserNotFoundError:
        logger.info("Firebase Auth user already missing for %s", user_id)
        return "already_missing"
    except Exception as exc:
        logger.exception("Firebase Auth user deletion failed for %s", user_id)
        raise HTTPException(
            status_code=500,
            detail={
                "code": "FIREBASE_AUTH_DELETE_FAILED",
                "message": "Backend account data was deleted, but Firebase Auth identity deletion failed.",
            },
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


@router.post("/phone/claim")
async def claim_account_phone(
    payload: PhoneClaimRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Persist a Firebase phone-auth session as the app-level verified phone claim."""
    phone_number, phone_session_uid = await _verify_phone_claim_id_token(payload.phone_id_token)
    identity = await ActorIdentityService().claim_verified_phone(
        user_id=firebase_uid,
        phone_number=phone_number,
    )
    if not identity:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "PHONE_CLAIM_PERSISTENCE_UNAVAILABLE",
                "message": "Phone verification was accepted but could not be persisted.",
            },
        )

    logger.info(
        "Account phone claim persisted user=%s phone_session_uid_present=%s",
        firebase_uid,
        bool(phone_session_uid),
    )
    return {
        "success": True,
        "user_id": firebase_uid,
        "identity": identity,
        "phone_verified": identity.get("phone_verified") is True,
    }


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

    if result.get("account_deleted") is True:
        firebase_delete_status = await _delete_firebase_auth_user(user_id)
        details = result.get("details")
        if not isinstance(details, dict):
            details = {}
            result["details"] = details
        details["firebase_auth_user"] = firebase_delete_status

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
