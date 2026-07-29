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

import base64
import hashlib
import hmac
import logging
import os
import re
import secrets
from typing import Any, Literal

from fastapi import APIRouter, Body, Depends, Header, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.utils.firebase_admin import get_firebase_auth_app
from hushh_mcp.services.account_service import AccountService
from hushh_mcp.services.actor_identity_service import (
    ActorIdentityAliasError,
    ActorIdentityService,
)
from hushh_mcp.services.trusted_device_service import (
    TrustedDeviceError,
    TrustedDeviceService,
    trusted_devices_enabled,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/account", tags=["Account"])


class TrustedDeviceAuthorizationRequest(BaseModel):
    redirect_uri: str = Field(min_length=8, max_length=2048)
    code_challenge: str = Field(min_length=43, max_length=128)
    code_challenge_method: Literal["S256"] = "S256"
    device_public_key: str = Field(min_length=80, max_length=2048)
    device_name: str = Field(min_length=1, max_length=100)
    platform: Literal["macos"]
    state: str = Field(min_length=16, max_length=512)
    replaces_device_id: str | None = Field(default=None, min_length=24, max_length=96)


class TrustedDeviceExchangeRequest(BaseModel):
    code: str = Field(min_length=20, max_length=256)
    code_verifier: str = Field(min_length=43, max_length=128)


def _trusted_device_allowlist() -> set[str]:
    return {
        value.strip()
        for value in str(os.getenv("HUSSH_TRUSTED_DEVICE_UAT_ALLOWLIST") or "").split(",")
        if value.strip()
    }


async def _trusted_device_guard(user_id: str | None = None) -> None:
    if not trusted_devices_enabled():
        raise HTTPException(
            status_code=404,
            detail={
                "code": "TRUSTED_DEVICE_DISABLED",
                "message": "Trusted-device authorization is not enabled.",
            },
        )
    allowlist = _trusted_device_allowlist()
    if not allowlist:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "TRUSTED_DEVICE_NOT_ALLOWED",
                "message": "Trusted-device enrollment is not available for this account.",
            },
        )
    # The unauthenticated PKCE exchange is guarded by possession of the
    # one-time code and verifier; the allowlist was enforced when that code was
    # created. Every signed-in entrypoint fails closed when rollout membership
    # is absent or does not match.
    if not user_id:
        return
    if user_id in allowlist:
        return

    allowed_emails = {value.lower() for value in allowlist if "@" in value}
    firebase_email = ""
    if allowed_emails:
        app = get_firebase_auth_app()
        if app is not None:
            try:
                from firebase_admin import auth as firebase_auth

                record = await run_in_threadpool(firebase_auth.get_user, user_id, app=app)
                if bool(getattr(record, "email_verified", False)):
                    firebase_email = str(getattr(record, "email", "") or "").strip().lower()
            except Exception:
                logger.exception("trusted_device.allowlist_identity_lookup_failed")
    if firebase_email not in allowed_emails:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "TRUSTED_DEVICE_NOT_ALLOWED",
                "message": "This account is not in the trusted-device rollout.",
            },
        )


def _raise_trusted_device_error(exc: TrustedDeviceError) -> None:
    raise HTTPException(
        status_code=exc.status_code,
        detail={"code": exc.code, "message": exc.message},
    ) from exc


async def _verify_browser_enrollment_identity(authorization: str | None) -> str:
    """Reject a device-minted Firebase session from approving another device."""
    raw_header = str(authorization or "").strip()
    if not raw_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid Firebase ID token")
    raw_token = raw_header.removeprefix("Bearer ").strip()
    try:
        from firebase_admin import auth as firebase_auth

        claims = await run_in_threadpool(
            firebase_auth.verify_id_token,
            raw_token,
            app=get_firebase_auth_app(),
            check_revoked=True,
        )
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Invalid Firebase ID token") from exc
    if str(claims.get("trusted_device_id") or "").strip():
        raise HTTPException(
            status_code=403,
            detail={
                "code": "TRUSTED_DEVICE_BROWSER_APPROVAL_REQUIRED",
                "message": "Approve a trusted device from your signed-in browser session.",
            },
        )
    return str(claims.get("uid") or claims.get("sub") or "").strip()


async def _verified_account_email(user_id: str) -> str:
    """Return the server-verified display identity for a trusted device.

    Hermes stores this value locally only to make an already-authorized account
    recognizable.  It is intentionally obtained from Firebase after the
    one-time code is consumed; a browser query parameter or client-supplied
    label must never become identity authority.
    """
    app = get_firebase_auth_app()
    if app is None:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "FIREBASE_ADMIN_UNAVAILABLE",
                "message": "Verified account identity is unavailable.",
            },
        )
    try:
        from firebase_admin import auth as firebase_auth

        record = await run_in_threadpool(firebase_auth.get_user, user_id, app=app)
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "TRUSTED_DEVICE_ACCOUNT_LOOKUP_FAILED",
                "message": "Verified account identity is unavailable.",
            },
        ) from exc
    email = str(getattr(record, "email", "") or "").strip()
    if not email or not bool(getattr(record, "email_verified", False)):
        raise HTTPException(
            status_code=403,
            detail={
                "code": "TRUSTED_DEVICE_VERIFIED_EMAIL_REQUIRED",
                "message": "A verified email address is required to connect a trusted device.",
            },
        )
    return email


async def _verified_account_phone(user_id: str) -> None:
    """Require the same durable phone admission claim as One's browser flow."""
    identity = (await ActorIdentityService().get_many([user_id])).get(user_id) or {}
    if identity.get("phone_verified") is not True:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "TRUSTED_DEVICE_VERIFIED_PHONE_REQUIRED",
                "message": "A verified phone number is required to connect a trusted device.",
            },
        )


@router.post("/trusted-device-authorizations")
async def create_trusted_device_authorization(
    payload: TrustedDeviceAuthorizationRequest,
    firebase_uid: str = Depends(require_firebase_auth),
    authorization: str | None = Header(None, alias="Authorization"),
):
    """Approve a PKCE-bound Hermes installation for the signed-in account."""
    await _trusted_device_guard(firebase_uid)
    # Fail before persisting an authorization/device record when the account
    # cannot later be shown as a verified local identity in Hermes.
    await _verified_account_email(firebase_uid)
    await _verified_account_phone(firebase_uid)
    browser_uid = await _verify_browser_enrollment_identity(authorization)
    if browser_uid != firebase_uid:
        raise HTTPException(status_code=401, detail="Invalid Firebase ID token")
    try:
        device_authorization = await run_in_threadpool(
            TrustedDeviceService().create_authorization,
            user_id=firebase_uid,
            redirect_uri=payload.redirect_uri,
            code_challenge=payload.code_challenge,
            device_public_key=payload.device_public_key,
            device_name=payload.device_name,
            platform=payload.platform,
            state=payload.state,
            replaces_device_id=payload.replaces_device_id,
        )
    except TrustedDeviceError as exc:
        _raise_trusted_device_error(exc)
    return {
        "authorization_id": device_authorization.authorization_id,
        "device_id": device_authorization.device_id,
        "redirect_uri": device_authorization.redirect_uri,
        "redirect_url": device_authorization.redirect_url,
        "expires_at": device_authorization.expires_at,
        "replaces_device_id": device_authorization.replaces_device_id,
    }


@router.post("/trusted-device-authorizations/exchange")
async def exchange_trusted_device_authorization(payload: TrustedDeviceExchangeRequest):
    """Consume a one-time PKCE code and mint a Firebase custom token."""
    await _trusted_device_guard()
    try:
        device = await run_in_threadpool(
            TrustedDeviceService().exchange_authorization,
            code=payload.code,
            code_verifier=payload.code_verifier,
        )
    except TrustedDeviceError as exc:
        _raise_trusted_device_error(exc)

    app = get_firebase_auth_app()
    if app is None:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "FIREBASE_ADMIN_UNAVAILABLE",
                "message": "Identity token issuance is unavailable.",
            },
        )
    try:
        from firebase_admin import auth as firebase_auth

        account_email = await _verified_account_email(str(device["user_id"]))
        custom_token = await run_in_threadpool(
            firebase_auth.create_custom_token,
            device["user_id"],
            {"trusted_device_id": device["device_id"]},
            app=app,
        )
    except Exception:
        logger.exception("trusted_device.custom_token_failed")
        raise HTTPException(
            status_code=500,
            detail={
                "code": "TRUSTED_DEVICE_TOKEN_ISSUANCE_FAILED",
                "message": "The trusted-device identity token could not be issued.",
            },
        )
    token = custom_token.decode("utf-8") if isinstance(custom_token, bytes) else str(custom_token)
    return {
        "firebase_custom_token": token,
        "device_id": device["device_id"],
        "user_id": device["user_id"],
        "account_email": account_email,
        "replaced_device_id": device.get("replaced_device_id"),
    }


@router.get("/trusted-devices")
async def list_trusted_devices(firebase_uid: str = Depends(require_firebase_auth)):
    # Recovery remains available after rollout is disabled or membership is
    # removed. The authenticated user can only list their own device records.
    devices = await run_in_threadpool(TrustedDeviceService().list_devices, user_id=firebase_uid)
    return {"devices": devices}


@router.post("/trusted-devices/{device_id}/challenge")
async def create_trusted_device_challenge(
    device_id: str,
    firebase_uid: str = Depends(require_firebase_auth),
):
    await _trusted_device_guard(firebase_uid)
    try:
        return await run_in_threadpool(
            TrustedDeviceService().create_challenge,
            user_id=firebase_uid,
            device_id=device_id,
        )
    except TrustedDeviceError as exc:
        _raise_trusted_device_error(exc)


@router.delete("/trusted-devices/{device_id}")
async def revoke_trusted_device(
    device_id: str,
    firebase_uid: str = Depends(require_firebase_auth),
):
    # Revocation is a recovery operation, not an enrollment operation. Keep it
    # available even when the feature flag or rollout allowlist is withdrawn.
    revoked = await run_in_threadpool(
        TrustedDeviceService().revoke_device,
        user_id=firebase_uid,
        device_id=device_id,
    )
    if not revoked:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "TRUSTED_DEVICE_NOT_FOUND",
                "message": "The trusted device was not found or was already revoked.",
            },
        )

    # Device owner capabilities use a device-specific agent id. Persisting a
    # newer REVOKED row makes DB-backed token validation fail across instances.
    from hushh_mcp.consent.token import revoke_token
    from hushh_mcp.services.consent_db import ConsentDBService

    consent_service = ConsentDBService()
    agent_id = f"device:{device_id}"
    active_tokens = await consent_service.get_active_internal_tokens(
        firebase_uid, agent_id=agent_id, scope="vault.owner"
    )
    for token_row in active_tokens:
        token_id = str(token_row.get("token_id") or "")
        if token_id:
            revoke_token(token_id)
            await consent_service.insert_internal_event(
                user_id=firebase_uid,
                agent_id=agent_id,
                scope="vault.owner",
                action="REVOKED",
                token_id=token_id,
                metadata={"reason": "trusted_device_revoked"},
            )
    return {"success": True, "device_id": device_id}


@router.post("/identity/refresh")
async def refresh_account_identity(
    firebase_uid: str = Depends(require_firebase_auth),
    force: bool = True,
):
    """Refresh the backend account identity shadow from Firebase Auth.

    When ``force`` is false the cached identity shadow is returned if it is
    fresh, avoiding a synchronous Firebase Auth round-trip and DB upsert. This
    keeps read-only callers (such as the phone-mandate guard) fast while
    callers that need guaranteed freshness keep the default forced refresh.
    """
    identity = await ActorIdentityService().sync_from_firebase(firebase_uid, force=force)
    return {
        "success": True,
        "user_id": firebase_uid,
        "identity": identity,
    }


class AvatarUploadRequest(BaseModel):
    image_data_url: str = Field(min_length=32, max_length=600_000)


# Client uploads a small, already-resized (~256px) image as a data URL.
_AVATAR_DATA_URL_PATTERN = re.compile(r"^data:image/(png|jpe?g|webp);base64,")
_AVATAR_MAX_DECODED_BYTES = 300 * 1024


@router.post("/avatar")
async def upload_account_avatar(
    request: AvatarUploadRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Store an app-owned avatar override for the signed-in actor.

    The stored data URL takes precedence over the Firebase photo on reads and
    survives Firebase identity syncs.
    """
    data_url = request.image_data_url.strip()
    if not _AVATAR_DATA_URL_PATTERN.match(data_url):
        raise HTTPException(
            status_code=400,
            detail={
                "code": "AVATAR_INVALID_DATA_URL",
                "message": "Avatar must be a PNG, JPEG, or WebP image data URL.",
            },
        )

    encoded_payload = data_url.split(",", 1)[1]
    try:
        decoded = base64.b64decode(encoded_payload, validate=True)
    except (ValueError, TypeError) as exc:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "AVATAR_INVALID_BASE64",
                "message": "Avatar image data is not valid base64.",
            },
        ) from exc

    if len(decoded) > _AVATAR_MAX_DECODED_BYTES:
        raise HTTPException(
            status_code=413,
            detail={
                "code": "AVATAR_TOO_LARGE",
                "message": "Avatar image exceeds the 300KB limit.",
            },
        )

    identity = await ActorIdentityService().set_custom_photo_url(
        firebase_uid, request.image_data_url
    )
    if not identity:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "AVATAR_PERSISTENCE_UNAVAILABLE",
                "message": "Avatar was accepted but could not be persisted.",
            },
        )
    return {"success": True, "identity": identity}


@router.delete("/avatar")
async def delete_account_avatar(
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Clear the app-owned avatar override, reverting to the Firebase photo."""
    identity = await ActorIdentityService().set_custom_photo_url(firebase_uid, None)
    if not identity:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "AVATAR_PERSISTENCE_UNAVAILABLE",
                "message": "Avatar removal could not be persisted.",
            },
        )
    return {"success": True, "identity": identity}


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


def _runtime_environment() -> str:
    return (_clean_env("ENVIRONMENT") or _clean_env("HUSHH_DEPLOY_ENV")).lower()


def _is_truthy_env(name: str) -> bool:
    return _clean_env(name).lower() in {"1", "true", "yes", "on", "enabled"}


def _is_uat_environment() -> bool:
    return _runtime_environment() == "uat"


def _normalize_phone_number(raw_phone: str) -> str:
    cleaned = re.sub(r"[^\d+]", "", str(raw_phone or "").strip())
    if cleaned.startswith("00"):
        cleaned = f"+{cleaned[2:]}"
    if cleaned and not cleaned.startswith("+"):
        cleaned = f"+{cleaned}"
    if cleaned.count("+") > 1 or ("+" in cleaned[1:]):
        return ""
    return cleaned


def _parse_phone_test_numbers(raw: str) -> set[str]:
    if not raw:
        return set()
    return {
        normalized
        for normalized in (_normalize_phone_number(part) for part in re.split(r"[,;\n]+", raw))
        if normalized
    }


def _configured_uat_phone_test_numbers() -> set[str]:
    raw = _clean_env("HUSHH_UAT_PHONE_TEST_NUMBERS") or _clean_env("UAT_PHONE_TEST_NUMBERS")
    return _parse_phone_test_numbers(raw)


def _configured_prod_phone_test_numbers() -> set[str]:
    return _parse_phone_test_numbers(_clean_env("HUSHH_PROD_PHONE_TEST_NUMBERS"))


def _configured_phone_test_numbers() -> set[str]:
    environment = _runtime_environment()
    if environment == "uat":
        return _configured_uat_phone_test_numbers()
    if environment == "production" and _is_truthy_env("HUSHH_PROD_PHONE_TEST_ENABLED"):
        return _configured_prod_phone_test_numbers()
    return set()


def _configured_uat_phone_test_code() -> str:
    return _clean_env("HUSHH_UAT_PHONE_TEST_CODE") or _clean_env("UAT_PHONE_TEST_CODE")


def _configured_prod_phone_test_code() -> str:
    return _clean_env("HUSHH_PROD_PHONE_TEST_CODE")


def _configured_prod_phone_test_challenge_secret() -> str:
    return _clean_env("HUSHH_PROD_PHONE_TEST_CHALLENGE_SECRET")


def _configured_phone_test_code() -> str:
    environment = _runtime_environment()
    if environment == "uat":
        return _configured_uat_phone_test_code()
    if environment == "production" and _is_truthy_env("HUSHH_PROD_PHONE_TEST_ENABLED"):
        return _configured_prod_phone_test_code()
    return ""


def _phone_test_enabled() -> bool:
    if _runtime_environment() == "production":
        return bool(
            _is_truthy_env("HUSHH_PROD_PHONE_TEST_ENABLED")
            and _configured_prod_phone_test_numbers()
            and _configured_prod_phone_test_code()
            and _configured_prod_phone_test_challenge_secret()
        )
    return bool(_configured_phone_test_numbers() and _configured_phone_test_code())


def _phone_test_challenge_key() -> str:
    environment = _runtime_environment()
    if environment == "production" and _is_truthy_env("HUSHH_PROD_PHONE_TEST_ENABLED"):
        return _configured_prod_phone_test_challenge_secret()
    return (
        _clean_env("HUSHH_UAT_PHONE_TEST_CHALLENGE_SECRET")
        or _clean_env("APP_SIGNING_KEY")
        or _configured_uat_phone_test_code()
    )


def _create_uat_phone_test_verification_id(phone_number: str) -> str:
    digest = hmac.new(
        _phone_test_challenge_key().encode("utf-8"),
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
    """Start an environment-gated fixed-code phone verification challenge."""
    del firebase_uid
    phone_number = _normalize_phone_number(payload.phone_number)
    enabled = _phone_test_enabled()
    eligible = enabled and phone_number in _configured_phone_test_numbers()

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
    """Persist an environment-gated fixed-code phone verification claim."""
    phone_number = _normalize_phone_number(payload.phone_number)
    configured_code = _configured_phone_test_code()

    if not _phone_test_enabled() or phone_number not in _configured_phone_test_numbers():
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
        # SECURITY: do not reflect the internal error string in the HTTP response.
        # The service-layer error may include persona names, DB state, or persona IDs.
        logger.error("account.delete_failed user=%s error=%s", user_id, result.get("error"))
        raise HTTPException(status_code=500, detail="Account deletion failed")

    if target == "both" and result.get("account_deleted") is True:
        details = result.get("details")
        if not isinstance(details, dict):
            details = {}
        firebase_auth_status = await _delete_firebase_auth_user(user_id)
        details["firebase_auth_user"] = firebase_auth_status
        details[
            "firebase_phone_orphan_user"
        ] = await _delete_safe_phone_only_firebase_user_by_phone(
            phone_number=verified_phone_number,
            protected_uid=user_id,
        )
        # Fail-loud on Firebase identity orphan: the encrypted account is already
        # gone, so we keep the 200, but surface the incomplete cleanup so callers can
        # alert/retry instead of silently treating the identity as removed.
        if firebase_auth_status == "failed":
            details["firebase_auth_user_deletion_incomplete"] = True
            logger.error(
                "Account deletion completed in DB but Firebase Auth identity remains "
                "orphaned for user=%s",
                user_id,
            )
        result["details"] = details

    return result


@router.post("/reset")
async def reset_account(
    token_data: dict = Depends(require_vault_owner_token),
):
    """
    Reset the logged-in user's One account to a fresh, just-onboarded state.

    Clears all personal data (PKM, finance, Gmail, connected systems, consents, KYC,
    location, marketplace, relationships) while KEEPING the One identity: the Firebase
    user, the encrypted vault keys + unlock methods, and the actor profile spine. The
    user re-runs onboarding on next login. Requires VAULT_OWNER token.
    """
    user_id = token_data["user_id"]
    logger.warning("Account reset requested for user %s", user_id)

    service = AccountService()
    result = await service.reset_account(user_id)

    if not result.get("success"):
        raise HTTPException(status_code=500, detail="Account reset failed")

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
