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

import hashlib
import hmac
import logging
import os
import re
import secrets
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


class UatPhoneTestStartRequest(BaseModel):
    phone_number: str = Field(min_length=3, max_length=32)


class UatPhoneTestConfirmRequest(BaseModel):
    phone_number: str = Field(min_length=3, max_length=32)
    verification_code: str = Field(min_length=1, max_length=16)
    verification_id: str = Field(min_length=1, max_length=256)


def _clean_env(name: str) -> str:
    return str(os.getenv(name) or "").strip()


def _is_uat_environment() -> bool:
    environment = (_clean_env("ENVIRONMENT") or _clean_env("HUSHH_DEPLOY_ENV")).lower()
    return environment == "uat"


def _normalize_phone_number(raw_phone: str) -> str:
    cleaned = re.sub(r"[^\d+]", "", str(raw_phone or "").strip())
    if cleaned.startswith("00"):
        cleaned = f"+{cleaned[2:]}"
    if cleaned and not cleaned.startswith("+"):
        cleaned = f"+{cleaned}"
    if cleaned.count("+") > 1 or ("+" in cleaned[1:]):
        return ""
    return cleaned


def _configured_uat_phone_test_numbers() -> set[str]:
    raw = _clean_env("HUSHH_UAT_PHONE_TEST_NUMBERS") or _clean_env("UAT_PHONE_TEST_NUMBERS")
    if not raw:
        return set()
    return {
        normalized
        for normalized in (_normalize_phone_number(part) for part in re.split(r"[,;\n]+", raw))
        if normalized
    }


def _configured_uat_phone_test_code() -> str:
    return _clean_env("HUSHH_UAT_PHONE_TEST_CODE") or _clean_env("UAT_PHONE_TEST_CODE")


def _uat_phone_test_enabled() -> bool:
    return _is_uat_environment() and bool(
        _configured_uat_phone_test_numbers() and _configured_uat_phone_test_code()
    )


def _uat_phone_test_challenge_key() -> str:
    return (
        _clean_env("HUSHH_UAT_PHONE_TEST_CHALLENGE_SECRET")
        or _clean_env("APP_SIGNING_KEY")
        or _configured_uat_phone_test_code()
    )


def _create_uat_phone_test_verification_id(phone_number: str) -> str:
    digest = hmac.new(
        _uat_phone_test_challenge_key().encode("utf-8"),
        phone_number.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"uat-test-phone:{digest}"


def _is_valid_uat_phone_test_verification_id(phone_number: str, verification_id: str) -> bool:
    expected = _create_uat_phone_test_verification_id(phone_number)
    return secrets.compare_digest(str(verification_id or "").strip(), expected)


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
    normalized_user_id = str(user_id or "").strip()
    if not normalized_user_id:
        return "skipped"

    try:
        from firebase_admin import auth as firebase_auth

        firebase_app = get_firebase_auth_app()
        await run_in_threadpool(
            lambda: firebase_auth.delete_user(normalized_user_id, app=firebase_app)
        )
        return "deleted"
    except Exception as exc:
        if exc.__class__.__name__ == "UserNotFoundError":
            return "not_found"
        logger.warning(
            "Firebase Auth user deletion failed for deleted account user=%s error=%s",
            normalized_user_id,
            type(exc).__name__,
        )
        return "failed"


def _firebase_user_provider_ids(user_record: Any) -> set[str]:
    provider_data = getattr(user_record, "provider_data", None) or []
    provider_ids: set[str] = set()
    for provider in provider_data:
        provider_id = str(getattr(provider, "provider_id", "") or "").strip()
        if provider_id:
            provider_ids.add(provider_id)
    return provider_ids


def _is_safe_phone_only_firebase_user(user_record: Any, expected_phone: str) -> bool:
    phone_number = str(getattr(user_record, "phone_number", "") or "").strip()
    if phone_number != str(expected_phone or "").strip():
        return False

    email = str(getattr(user_record, "email", "") or "").strip()
    if email:
        return False

    provider_ids = _firebase_user_provider_ids(user_record)
    return not provider_ids or provider_ids.issubset({"phone"})


async def _delete_safe_phone_only_firebase_user(
    *,
    uid: str | None,
    phone_number: str | None,
    protected_uid: str | None = None,
) -> str:
    normalized_uid = str(uid or "").strip()
    normalized_phone = str(phone_number or "").strip()
    normalized_protected_uid = str(protected_uid or "").strip()
    if not normalized_uid or not normalized_phone:
        return "skipped"
    if normalized_protected_uid and normalized_uid == normalized_protected_uid:
        return "protected_primary_uid"

    try:
        from firebase_admin import auth as firebase_auth

        firebase_app = get_firebase_auth_app()
        user_record = await run_in_threadpool(
            lambda: firebase_auth.get_user(normalized_uid, app=firebase_app)
        )
        if not _is_safe_phone_only_firebase_user(user_record, normalized_phone):
            return "not_phone_only"
        await run_in_threadpool(lambda: firebase_auth.delete_user(normalized_uid, app=firebase_app))
        return "deleted"
    except Exception as exc:
        if exc.__class__.__name__ == "UserNotFoundError":
            return "not_found"
        logger.warning(
            "Safe phone-only Firebase user cleanup failed uid=%s error=%s",
            normalized_uid,
            type(exc).__name__,
        )
        return "failed"


async def _delete_safe_phone_only_firebase_user_by_phone(
    *,
    phone_number: str | None,
    protected_uid: str | None = None,
) -> str:
    normalized_phone = str(phone_number or "").strip()
    normalized_protected_uid = str(protected_uid or "").strip()
    if not normalized_phone:
        return "skipped"

    try:
        from firebase_admin import auth as firebase_auth

        firebase_app = get_firebase_auth_app()
        user_record = await run_in_threadpool(
            lambda: firebase_auth.get_user_by_phone_number(normalized_phone, app=firebase_app)
        )
        uid = str(getattr(user_record, "uid", "") or "").strip()
        if normalized_protected_uid and uid == normalized_protected_uid:
            return "protected_primary_uid"
        if not _is_safe_phone_only_firebase_user(user_record, normalized_phone):
            return "not_phone_only"
        await run_in_threadpool(lambda: firebase_auth.delete_user(uid, app=firebase_app))
        return "deleted"
    except Exception as exc:
        if exc.__class__.__name__ == "UserNotFoundError":
            return "not_found"
        logger.warning(
            "Safe phone-only Firebase user cleanup by phone failed phone_present=%s error=%s",
            bool(normalized_phone),
            type(exc).__name__,
        )
        return "failed"


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
    phone_session_cleanup = await _delete_safe_phone_only_firebase_user(
        uid=phone_session_uid,
        phone_number=phone_number,
        protected_uid=firebase_uid,
    )
    return {
        "success": True,
        "user_id": firebase_uid,
        "identity": identity,
        "phone_verified": identity.get("phone_verified") is True,
        "phone_session_cleanup": phone_session_cleanup,
    }


@router.post("/phone/uat-test/start")
async def start_uat_test_phone_verification(
    payload: UatPhoneTestStartRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Start a UAT-only fixed-code phone verification challenge for allowlisted numbers."""
    del firebase_uid
    phone_number = _normalize_phone_number(payload.phone_number)
    enabled = _uat_phone_test_enabled()
    eligible = enabled and phone_number in _configured_uat_phone_test_numbers()

    if not eligible:
        return {
            "success": True,
            "eligible": False,
            "reason": "uat_phone_test_not_configured_or_not_allowlisted",
        }

    return {
        "success": True,
        "eligible": True,
        "verification_id": _create_uat_phone_test_verification_id(phone_number),
    }


@router.post("/phone/uat-test/confirm")
async def confirm_uat_test_phone_verification(
    payload: UatPhoneTestConfirmRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Persist a UAT-only fixed-code phone verification claim for an allowlisted number."""
    phone_number = _normalize_phone_number(payload.phone_number)
    configured_code = _configured_uat_phone_test_code()

    if not _uat_phone_test_enabled() or phone_number not in _configured_uat_phone_test_numbers():
        raise HTTPException(
            status_code=403,
            detail={
                "code": "UAT_PHONE_TEST_NOT_ALLOWLISTED",
                "message": "This phone number is not allowlisted for UAT test verification.",
            },
        )

    if not _is_valid_uat_phone_test_verification_id(phone_number, payload.verification_id):
        raise HTTPException(
            status_code=401,
            detail={
                "code": "UAT_PHONE_TEST_INVALID_CHALLENGE",
                "message": "The UAT phone verification challenge is invalid.",
            },
        )

    if not secrets.compare_digest(str(payload.verification_code or "").strip(), configured_code):
        raise HTTPException(
            status_code=401,
            detail={
                "code": "UAT_PHONE_TEST_INVALID_CODE",
                "message": "The UAT phone verification code is invalid.",
            },
        )

    identity = await ActorIdentityService().claim_verified_phone(
        user_id=firebase_uid,
        phone_number=phone_number,
        source="uat_test_phone_claim",
    )
    if not identity:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "UAT_PHONE_TEST_PERSISTENCE_UNAVAILABLE",
                "message": "Phone verification was accepted but could not be persisted.",
            },
        )

    logger.info("UAT phone test claim persisted user=%s", firebase_uid)
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
    verified_phone_number: str | None = None
    if target == "both":
        try:
            identity = (await ActorIdentityService().get_many([user_id])).get(user_id)
            if identity and identity.get("phone_verified") is True:
                verified_phone_number = str(identity.get("phone_number") or "").strip() or None
        except Exception as exc:
            logger.warning(
                "Could not prefetch verified phone before account deletion user=%s error=%s",
                user_id,
                type(exc).__name__,
            )

    service = AccountService()
    result = await service.delete_account(user_id, target=target)

    if not result["success"]:
        raise HTTPException(status_code=500, detail="Account deletion failed")

    if target == "both" and result.get("account_deleted") is True:
        details = result.get("details")
        if not isinstance(details, dict):
            details = {}
        details["firebase_auth_user"] = await _delete_firebase_auth_user(user_id)
        details[
            "firebase_phone_orphan_user"
        ] = await _delete_safe_phone_only_firebase_user_by_phone(
            phone_number=verified_phone_number,
            protected_uid=user_id,
        )
        result["details"] = details

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
