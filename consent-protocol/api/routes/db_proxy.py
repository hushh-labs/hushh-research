# api/routes/db_proxy.py
"""
⚠️ DEPRECATED ⚠️ - Minimal SQL Proxy for iOS Native App.

🔒 SECURITY UPDATE 🔒
As of this update, all routes now require Firebase authentication.
This addresses the previous security vulnerabilities.

Legacy Description:
This module provides a thin database access layer for the iOS native app.
All consent protocol logic runs locally on iOS - this only executes SQL operations.

Security:
- All routes now require Firebase ID token authentication
- Only pre-defined operations allowed (no raw SQL)
- All connections use Cloud SQL session pooler (DB_*); SSL required
"""

import asyncio
import logging
import os
import re
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from api.middleware import require_firebase_auth, verify_user_id_match
from api.utils.firebase_admin import get_firebase_auth_app
from hushh_mcp.consent.token import validate_token_with_db
from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.actor_identity_service import ActorIdentityService
from hushh_mcp.services.support_email_service import AccountNoticeKind, get_support_email_service
from hushh_mcp.services.vault_keys_service import VaultKeysService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/db", tags=["Database Proxy (DEPRECATED)"])
MIN_VAULT_WRITE_CLIENT_VERSION = os.getenv("MIN_VAULT_WRITE_CLIENT_VERSION", "2.0.0")
ENFORCE_VAULT_WRITE_CLIENT_VERSION = os.getenv(
    "ENFORCE_VAULT_WRITE_CLIENT_VERSION", "true"
).strip().lower() not in {"0", "false", "no"}
# The phone shadow is advisory metadata on the vault bootstrap response. It
# must not hold the authenticated setup/vault admission path while its separate
# async database pool cold-starts through Cloud SQL.
VAULT_BOOTSTRAP_PHONE_SHADOW_TIMEOUT_SECONDS = 2.0


def _require_matching_vault_owner(vault_owner_token: dict, user_id: str) -> None:
    if str(vault_owner_token.get("user_id") or "") != user_id:
        raise HTTPException(
            status_code=403, detail="VAULT_OWNER token userId does not match requested userId"
        )


def _is_passkey_method(method: str) -> bool:
    return method in {"generated_default_web_prf", "generated_default_native_passkey_prf"}


async def _send_vault_change_notice(user_id: str, kind: AccountNoticeKind) -> None:
    """Best effort after commit; no client event can request an account notice."""
    try:
        app = get_firebase_auth_app()
        if app is None:
            raise RuntimeError("account lookup unavailable")
        from firebase_admin import auth as firebase_auth

        account = await run_in_threadpool(firebase_auth.get_user, user_id, app=app)
        if not getattr(account, "email_verified", False) or not getattr(account, "email", None):
            logger.warning(
                "account_security_email.skipped reason=verified_email_required kind=%s", kind
            )
            return
        await run_in_threadpool(
            get_support_email_service().send_account_notice,
            kind=kind,
            to_email=str(account.email),
        )
        logger.info("account_security_email.accepted kind=%s", kind)
    except Exception as exc:
        logger.error(
            "account_security_email.failed kind=%s error_type=%s", kind, type(exc).__name__
        )


def _mask_user_id(user_id: str) -> str:
    if not user_id:
        return "<unknown>"
    if len(user_id) <= 8:
        return user_id
    return f"{user_id[:4]}...{user_id[-4:]}"


def _parse_semver(value: str) -> tuple[int, int, int] | None:
    match = re.match(r"^\s*(\d+)\.(\d+)\.(\d+)", value or "")
    if not match:
        return None
    return int(match.group(1)), int(match.group(2)), int(match.group(3))


def _check_client_version_or_raise(http_request: Request) -> None:
    if not ENFORCE_VAULT_WRITE_CLIENT_VERSION:
        return

    client_version = (
        http_request.headers.get("x-hushh-client-version")
        or http_request.headers.get("x-client-version")
        or ""
    ).strip()
    parsed_client = _parse_semver(client_version)
    parsed_min = _parse_semver(MIN_VAULT_WRITE_CLIENT_VERSION)
    if parsed_min is None:
        return
    if parsed_client is None or parsed_client < parsed_min:
        raise HTTPException(
            status_code=426,
            detail={
                "error": "Client upgrade required",
                "code": "CLIENT_UPGRADE_REQUIRED",
                "minimum_version": MIN_VAULT_WRITE_CLIENT_VERSION,
            },
        )


def _raise_database_http_exception(exc: Exception) -> None:
    if exc.__class__.__name__ == "DatabaseUnavailableError":
        status_code = getattr(exc, "status_code", 503)
        code = getattr(exc, "code", "DATABASE_UNAVAILABLE")
        hint = getattr(exc, "hint", None)
        raise HTTPException(
            status_code=status_code,
            detail={
                "error": "Database is temporarily unavailable.",
                "code": code,
                **({"hint": hint} if hint else {}),
            },
        ) from exc
    if exc.__class__.__name__ == "DatabaseExecutionError":
        status_code = getattr(exc, "status_code", 500)
        hint = getattr(exc, "hint", None)
        raise HTTPException(
            status_code=status_code,
            detail={
                "error": "Database is temporarily unavailable."
                if status_code == 503
                else "Database error",
                "code": getattr(exc, "code", "DATABASE_EXECUTION_ERROR"),
                **({"hint": hint} if hint else {}),
            },
        ) from exc
    raise HTTPException(status_code=500, detail="Database error") from exc


async def require_vault_owner_consent_header(
    hushh_consent: str | None = Header(None, alias="X-Hushh-Consent"),
) -> dict:
    """Require a VAULT_OWNER token in the explicit dual-auth consent header."""
    raw_header = (hushh_consent or "").strip()
    if not raw_header:
        raise HTTPException(
            status_code=401,
            detail="Missing X-Hushh-Consent header",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = raw_header.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(
            status_code=401,
            detail="Missing X-Hushh-Consent bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    valid, reason, token_obj = await validate_token_with_db(token, ConsentScope.VAULT_OWNER)
    if not valid or token_obj is None:
        logger.warning("db_proxy.token_invalid reason=%s", reason)
        raise HTTPException(
            status_code=401,
            detail="Invalid or expired consent token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    scope = getattr(token_obj, "scope", None)
    return {
        "user_id": token_obj.user_id,
        "agent_id": getattr(token_obj, "agent_id", None),
        "scope": getattr(token_obj, "scope_str", None) or getattr(scope, "value", scope),
        "token": token,
        "token_obj": token_obj,
    }


# ============================================================================
# Request/Response Models
# ============================================================================


class VaultCheckRequest(BaseModel):
    userId: str


class VaultCheckResponse(BaseModel):
    hasVault: bool


class VaultBootstrapStateRequest(BaseModel):
    userId: str | None = None


class OneChatOnboardingState(BaseModel):
    """Bounded chat-onboarding progress. Deliberately has no free-form field."""

    version: Literal[1] = 1
    status: Literal["in_progress", "completed"]
    answered: list[Literal["name", "focus", "tone"]] = Field(default_factory=list, max_length=3)
    skipped: list[Literal["name", "focus", "tone"]] = Field(default_factory=list, max_length=3)
    completedOn: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    tipDismissedOn: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")


class VaultBootstrapStateResponse(BaseModel):
    userId: str
    hasVault: bool
    vaultStatus: str
    firstLoginAt: int | None = None
    lastLoginAt: int | None = None
    loginCount: int
    setupCompleted: bool | None = None
    setupSkipped: bool | None = None
    setupCompletedAt: int | None = None
    navSetupCompletedAt: int | None = None
    navSetupSkippedAt: int | None = None
    # Root-setup marker set. It contains completed capability ids plus bounded
    # non-capability prerequisites such as the explicit Connections choice.
    # Empty means no setup marker has settled yet.
    setupCapabilityIds: list[str] = []
    # Capabilities the person explicitly declined (e.g. dismissed a connect
    # prompt). Never includes "connections" -- that prerequisite is mandatory.
    # Distinct from setupCapabilityIds, which only ever records completions.
    setupCapabilityDeclinedIds: list[str] = []
    setupCapabilitiesUpdatedAt: int | None = None
    # One's chat onboarding progress: question ids answered/skipped and two
    # calendar dates. Never an answer value; those live in encrypted memory.
    oneChatOnboarding: OneChatOnboardingState | None = None
    setupStateUpdatedAt: int | None = None
    # A strict, non-secret Connections preference. BYOK remains pending until
    # the person finishes setup and stores the actual key in their vault.
    oneRuntimeSetupChoice: Literal["hushh_managed_vertex", "byok_pending_vault"] | None = None
    # Redacted, resumable onboarding goal. It deliberately contains no voice
    # transcript, credentials, or page content.
    onboardingJourneyVersion: int | None = None
    onboardingPhase: str | None = None
    onboardingActiveCapability: str | None = None
    onboardingResumeRoute: str | None = None
    onboardingCallbackState: str | None = None
    # Opaque browser-generated correlation id for an external connector
    # attempt. This is deliberately not an OAuth state/code/token and cannot
    # identify an account outside the current authenticated journey.
    onboardingCallbackAttemptId: str | None = None
    onboardingJourneyUpdatedAt: int | None = None
    # Verified-phone claim folded in from the cached actor-identity shadow so a
    # single session-bootstrap call resolves both vault presence and the phone
    # mandate. None means "unknown" (e.g. shadow lookup failed); the client then
    # falls back to its own identity read rather than treating it as unverified.
    phoneVerified: bool | None = None


class VaultPreStateUpdateRequest(BaseModel):
    userId: str | None = None
    setupCompleted: bool | None = None
    setupSkipped: bool | None = None
    setupCompletedAt: int | None = None
    navSetupCompletedAt: int | None = None
    navSetupSkippedAt: int | None = None
    # Replace the stored setup capability set. None leaves it unchanged.
    setupCapabilityIds: list[str] | None = None
    # Replace the stored declined-capability set. None leaves it unchanged.
    setupCapabilityDeclinedIds: list[str] | None = None
    # Replace the chat onboarding progress record. None leaves it unchanged.
    oneChatOnboarding: OneChatOnboardingState | None = None
    oneRuntimeSetupChoice: Literal["hushh_managed_vertex", "byok_pending_vault"] | None = None
    onboardingJourneyVersion: int | None = Field(default=None, ge=1, le=1)
    onboardingPhase: str | None = Field(default=None, max_length=32)
    onboardingActiveCapability: str | None = Field(default=None, max_length=32)
    onboardingResumeRoute: str | None = Field(default=None, max_length=128)
    onboardingCallbackState: str | None = Field(default=None, max_length=16)
    onboardingCallbackAttemptId: str | None = Field(default=None, max_length=96)
    # Optional optimistic-concurrency guard for resumable setup transitions.
    expectedOnboardingJourneyUpdatedAt: int | None = None
    # Callback settlement must match the durable external attempt as well as
    # the observed revision, so an old callback cannot settle a replacement.
    expectedOnboardingCallbackAttemptId: str | None = Field(default=None, max_length=96)


class VaultGetRequest(BaseModel):
    userId: str


class VaultWrapperData(BaseModel):
    method: str
    wrapperId: str | None = None
    encryptedVaultKey: str
    salt: str
    iv: str
    passkeyCredentialId: str | None = None
    passkeyPrfSalt: str | None = None
    passkeyRpId: str | None = None
    passkeyProvider: str | None = None
    passkeyDeviceLabel: str | None = None
    passkeyLastUsedAt: int | None = None


class VaultStateData(BaseModel):
    vaultKeyHash: str
    primaryMethod: str
    primaryWrapperId: str | None = None
    recoveryEncryptedVaultKey: str
    recoverySalt: str
    recoveryIv: str
    wrappers: list[VaultWrapperData]


class VaultSetupStateRequest(BaseModel):
    userId: str
    vaultKeyHash: str
    primaryMethod: str
    primaryWrapperId: str | None = None
    recoveryEncryptedVaultKey: str
    recoverySalt: str
    recoveryIv: str
    wrappers: list[VaultWrapperData]


class VaultWrapperUpsertRequest(BaseModel):
    userId: str
    vaultKeyHash: str
    method: str
    wrapperId: str | None = None
    encryptedVaultKey: str
    salt: str
    iv: str
    passkeyCredentialId: str | None = None
    passkeyPrfSalt: str | None = None
    passkeyRpId: str | None = None
    passkeyProvider: str | None = None
    passkeyDeviceLabel: str | None = None
    passkeyLastUsedAt: int | None = None


class VaultWrapperDeleteRequest(BaseModel):
    userId: str
    vaultKeyHash: str
    method: str
    wrapperId: str | None = None
    fallbackPrimaryMethod: str | None = "passphrase"
    fallbackPrimaryWrapperId: str | None = "default"


class VaultPrimaryMethodSetRequest(BaseModel):
    userId: str
    primaryMethod: str
    primaryWrapperId: str | None = None


class SuccessResponse(BaseModel):
    success: bool


class VaultIntegrityResponse(BaseModel):
    valid: bool
    hasVault: bool
    wrapperCount: int
    hasPassphraseWrapper: bool
    primaryMethodEnrolled: bool
    methods: list[str]


# ============================================================================
# Vault Endpoints (Minimal SQL Operations)
# ============================================================================

# NOTE: /food/get and /professional/get removed; domain data is via PKM.


@router.post("/vault/check", response_model=VaultCheckResponse)
async def vault_check(
    request: VaultCheckRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """
    Check if a vault exists for the user.

    ⚠️ DEPRECATED: Use modern vault endpoints instead.

    SECURITY: Requires Firebase authentication. User can only check their own vault.
    """
    # Verify user is checking their own vault
    verify_user_id_match(firebase_uid, request.userId)

    try:
        service = VaultKeysService()
        # Read-only existence check: this is the unlock-screen hot path, so it
        # must avoid the login-marker upsert in _ensure_user_entry_sync (which
        # adds extra write round-trips). Login tracking still happens via
        # /vault/bootstrap-state on the session bootstrap path.
        has_vault = await service.check_vault_exists(request.userId, ensure_entry=False)
        return VaultCheckResponse(hasVault=has_vault)

    except Exception as e:
        logger.error(f"vault/check error: {e}")
        _raise_database_http_exception(e)


@router.post("/vault/bootstrap-state", response_model=VaultBootstrapStateResponse)
async def vault_bootstrap_state(
    request: VaultBootstrapStateRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """
    Ensure authenticated user has placeholder/active entry and return DB-first
    pre-vault onboarding/tour state.
    """
    user_id = request.userId or firebase_uid
    verify_user_id_match(firebase_uid, user_id)

    try:
        service = VaultKeysService()
        state = await service.get_pre_vault_state(user_id)
        # `update_pre_vault_state` already returns the serialized vault row,
        # including its authoritative status. A second vault/wrapper lookup
        # added avoidable latency to every setup transition and could make the
        # native request appear hung. The frontend's bootstrap contract already
        # defines an active status as a present vault.
        has_vault = state.get("vaultStatus") == "active"

        # Fold the verified-phone claim in from the cached actor-identity shadow
        # (a pure DB read, no Firebase round-trip) so the client can resolve the
        # phone mandate from this same bootstrap call. Best-effort: a lookup
        # failure leaves phoneVerified=None and the client falls back to its own
        # identity read instead of being wrongly treated as unverified.
        phone_verified: bool | None = None
        try:
            identities = await asyncio.wait_for(
                ActorIdentityService().get_many([user_id]),
                timeout=VAULT_BOOTSTRAP_PHONE_SHADOW_TIMEOUT_SECONDS,
            )
            identity = identities.get(user_id)
            if identity is not None:
                phone_verified = identity.get("phone_verified") is True
        except TimeoutError:
            logger.warning(
                "vault/bootstrap-state phone-shadow lookup timed out user=%s",
                _mask_user_id(user_id),
            )
        except Exception as identity_error:
            logger.warning(
                "vault/bootstrap-state phone-shadow lookup failed user=%s error=%s",
                _mask_user_id(user_id),
                type(identity_error).__name__,
            )

        return VaultBootstrapStateResponse(
            userId=user_id,
            hasVault=has_vault,
            vaultStatus=state.get("vaultStatus") or "active",
            firstLoginAt=state.get("firstLoginAt"),
            lastLoginAt=state.get("lastLoginAt"),
            loginCount=int(state.get("loginCount") or 0),
            setupCompleted=state.get("setupCompleted"),
            setupSkipped=state.get("setupSkipped"),
            setupCompletedAt=state.get("setupCompletedAt"),
            navSetupCompletedAt=state.get("navSetupCompletedAt"),
            navSetupSkippedAt=state.get("navSetupSkippedAt"),
            setupCapabilityIds=state.get("setupCapabilityIds") or [],
            setupCapabilityDeclinedIds=state.get("setupCapabilityDeclinedIds") or [],
            oneChatOnboarding=state.get("oneChatOnboarding"),
            setupCapabilitiesUpdatedAt=state.get("setupCapabilitiesUpdatedAt"),
            setupStateUpdatedAt=state.get("setupStateUpdatedAt"),
            oneRuntimeSetupChoice=state.get("oneRuntimeSetupChoice"),
            onboardingJourneyVersion=state.get("onboardingJourneyVersion"),
            onboardingPhase=state.get("onboardingPhase"),
            onboardingActiveCapability=state.get("onboardingActiveCapability"),
            onboardingResumeRoute=state.get("onboardingResumeRoute"),
            onboardingCallbackState=state.get("onboardingCallbackState"),
            onboardingCallbackAttemptId=state.get("onboardingCallbackAttemptId"),
            onboardingJourneyUpdatedAt=state.get("onboardingJourneyUpdatedAt"),
            phoneVerified=phone_verified,
        )
    except ValueError as exc:
        if str(exc) == "stale onboarding journey":
            raise HTTPException(
                status_code=409,
                detail={
                    "error": "Setup changed in another session.",
                    "code": "STALE_ONBOARDING_JOURNEY",
                },
            )
        raise HTTPException(
            status_code=400, detail={"error": "Validation error", "code": "VAULT_VALIDATION_ERROR"}
        )
    except Exception as e:
        logger.error("vault/bootstrap-state error user=%s", _mask_user_id(user_id), exc_info=True)
        _raise_database_http_exception(e)


@router.post("/vault/pre-vault-state", response_model=VaultBootstrapStateResponse)
async def vault_pre_vault_state(
    request: VaultPreStateUpdateRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """
    Update DB-first pre-vault onboarding/tour state for the authenticated user.
    """
    user_id = request.userId or firebase_uid
    verify_user_id_match(firebase_uid, user_id)

    try:
        service = VaultKeysService()
        state = await service.update_pre_vault_state(
            user_id=user_id,
            setup_completed=request.setupCompleted,
            setup_skipped=request.setupSkipped,
            setup_completed_at=request.setupCompletedAt,
            nav_setup_completed_at=request.navSetupCompletedAt,
            nav_setup_skipped_at=request.navSetupSkippedAt,
            setup_capability_ids=request.setupCapabilityIds,
            setup_capability_declined_ids=request.setupCapabilityDeclinedIds,
            one_chat_onboarding=(
                request.oneChatOnboarding.model_dump()
                if request.oneChatOnboarding is not None
                else None
            ),
            one_runtime_setup_choice=request.oneRuntimeSetupChoice,
            onboarding_journey_version=request.onboardingJourneyVersion,
            onboarding_phase=request.onboardingPhase,
            onboarding_active_capability=request.onboardingActiveCapability,
            onboarding_resume_route=request.onboardingResumeRoute,
            onboarding_callback_state=request.onboardingCallbackState,
            onboarding_callback_attempt_id=request.onboardingCallbackAttemptId,
            expected_onboarding_journey_updated_at=request.expectedOnboardingJourneyUpdatedAt,
            expected_onboarding_callback_attempt_id=request.expectedOnboardingCallbackAttemptId,
        )
        has_vault = await service.check_vault_exists(user_id, ensure_entry=False)

        return VaultBootstrapStateResponse(
            userId=user_id,
            hasVault=has_vault,
            vaultStatus=state.get("vaultStatus") or "active",
            firstLoginAt=state.get("firstLoginAt"),
            lastLoginAt=state.get("lastLoginAt"),
            loginCount=int(state.get("loginCount") or 0),
            setupCompleted=state.get("setupCompleted"),
            setupSkipped=state.get("setupSkipped"),
            setupCompletedAt=state.get("setupCompletedAt"),
            navSetupCompletedAt=state.get("navSetupCompletedAt"),
            navSetupSkippedAt=state.get("navSetupSkippedAt"),
            setupCapabilityIds=state.get("setupCapabilityIds") or [],
            setupCapabilityDeclinedIds=state.get("setupCapabilityDeclinedIds") or [],
            oneChatOnboarding=state.get("oneChatOnboarding"),
            setupCapabilitiesUpdatedAt=state.get("setupCapabilitiesUpdatedAt"),
            setupStateUpdatedAt=state.get("setupStateUpdatedAt"),
            oneRuntimeSetupChoice=state.get("oneRuntimeSetupChoice"),
            onboardingJourneyVersion=state.get("onboardingJourneyVersion"),
            onboardingPhase=state.get("onboardingPhase"),
            onboardingActiveCapability=state.get("onboardingActiveCapability"),
            onboardingResumeRoute=state.get("onboardingResumeRoute"),
            onboardingCallbackState=state.get("onboardingCallbackState"),
            onboardingCallbackAttemptId=state.get("onboardingCallbackAttemptId"),
            onboardingJourneyUpdatedAt=state.get("onboardingJourneyUpdatedAt"),
        )
    except ValueError as exc:
        if str(exc) == "stale onboarding journey":
            raise HTTPException(
                status_code=409,
                detail={
                    "error": "Setup changed in another session.",
                    "code": "STALE_ONBOARDING_JOURNEY",
                },
            )
        raise HTTPException(
            status_code=400, detail={"error": "Validation error", "code": "VAULT_VALIDATION_ERROR"}
        )
    except Exception as e:
        logger.error("vault/pre-vault-state error user=%s", _mask_user_id(user_id), exc_info=True)
        _raise_database_http_exception(e)


@router.post("/vault/get", response_model=VaultStateData)
async def vault_get(
    request: VaultGetRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """
    Get encrypted vault key data for the user.

    ⚠️ DEPRECATED: Use modern vault endpoints instead.

    SECURITY: Requires Firebase authentication. User can only get their own vault.
    """
    # Verify user is getting their own vault
    verify_user_id_match(firebase_uid, request.userId)

    try:
        service = VaultKeysService()
        vault_data = await service.get_vault_state(request.userId)

        if not vault_data:
            raise HTTPException(status_code=404, detail="Vault not found")

        return VaultStateData(**vault_data)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"vault/get error: {e}")
        _raise_database_http_exception(e)


@router.post("/vault/setup", response_model=SuccessResponse)
async def vault_setup(
    http_request: Request,
    request: VaultSetupStateRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """
    Store encrypted vault key data.

    ⚠️ DEPRECATED: Use modern vault endpoints instead.

    SECURITY: Requires Firebase authentication. User can only setup their own vault.
    """
    # Verify user is setting up their own vault
    verify_user_id_match(firebase_uid, request.userId)
    _check_client_version_or_raise(http_request)
    methods = [wrapper.method for wrapper in request.wrappers]
    logger.info(
        "vault/setup request user=%s wrappers=%s methods=%s primary=%s",
        _mask_user_id(request.userId),
        len(request.wrappers),
        methods,
        request.primaryMethod,
    )

    try:
        service = VaultKeysService()
        await service.setup_vault_state(
            user_id=request.userId,
            vault_key_hash=request.vaultKeyHash,
            primary_method=request.primaryMethod,
            recovery_encrypted_vault_key=request.recoveryEncryptedVaultKey,
            recovery_salt=request.recoverySalt,
            recovery_iv=request.recoveryIv,
            wrappers=[wrapper.model_dump() for wrapper in request.wrappers],
            primary_wrapper_id=request.primaryWrapperId,
        )
        try:
            await ActorIdentityService().sync_from_firebase(firebase_uid, force=False)
        except Exception as identity_error:
            logger.debug(
                "vault/setup identity shadow sync skipped for %s: %s",
                _mask_user_id(request.userId),
                identity_error,
            )
        return SuccessResponse(success=True)

    except ValueError as e:
        message = str(e)
        if "Active vault already exists" in message:
            raise HTTPException(
                status_code=409,
                detail={
                    "error": message,
                    "code": "VAULT_ALREADY_EXISTS",
                },
            )
        if "primaryMethod + primaryWrapperId" in message:
            raise HTTPException(
                status_code=400,
                detail={
                    "error": message,
                    "code": "VAULT_PRIMARY_WRAPPER_NOT_FOUND",
                },
            )
        raise HTTPException(
            status_code=400, detail={"error": message, "code": "VAULT_VALIDATION_ERROR"}
        )
    except Exception as e:
        logger.error(
            "vault/setup error user=%s wrappers=%s methods=%s: %s",
            _mask_user_id(request.userId),
            len(request.wrappers),
            methods,
            e,
        )
        _raise_database_http_exception(e)


@router.post("/vault/wrapper/upsert", response_model=SuccessResponse)
async def vault_wrapper_upsert(
    http_request: Request,
    request: VaultWrapperUpsertRequest,
    firebase_uid: str = Depends(require_firebase_auth),
    vault_owner_token: dict = Depends(require_vault_owner_consent_header),
):
    """Add or update a single vault wrapper for an enrolled method."""
    verify_user_id_match(firebase_uid, request.userId)
    _require_matching_vault_owner(vault_owner_token, request.userId)
    _check_client_version_or_raise(http_request)
    logger.info(
        "vault/wrapper/upsert request user=%s method=%s",
        _mask_user_id(request.userId),
        request.method,
    )

    try:
        service = VaultKeysService()
        prior_state = await service.get_vault_state(request.userId)
        previous_wrapper = next(
            (
                wrapper
                for wrapper in (prior_state or {}).get("wrappers", [])
                if wrapper.get("method") == request.method
                and (wrapper.get("wrapperId") or "default") == (request.wrapperId or "default")
            ),
            None,
        )
        await service.upsert_wrapper(
            user_id=request.userId,
            vault_key_hash=request.vaultKeyHash,
            method=request.method,
            wrapper_id=request.wrapperId,
            encrypted_vault_key=request.encryptedVaultKey,
            salt=request.salt,
            iv=request.iv,
            passkey_credential_id=request.passkeyCredentialId,
            passkey_prf_salt=request.passkeyPrfSalt,
            passkey_rp_id=request.passkeyRpId,
            passkey_provider=request.passkeyProvider,
            passkey_device_label=request.passkeyDeviceLabel,
            passkey_last_used_at=request.passkeyLastUsedAt,
        )
        if _is_passkey_method(request.method) and previous_wrapper is None:
            await _send_vault_change_notice(request.userId, "passkey_added")
        elif (
            request.method == "passphrase"
            and previous_wrapper is not None
            and any(
                previous_wrapper.get(field) != value
                for field, value in (
                    ("encryptedVaultKey", request.encryptedVaultKey),
                    ("salt", request.salt),
                    ("iv", request.iv),
                )
            )
        ):
            await _send_vault_change_notice(request.userId, "passphrase_changed")
        return SuccessResponse(success=True)

    except ValueError as e:
        message = str(e)
        if (
            "requires passkey credential metadata including rp id" in message
            or "wrapper rp id is not allowed for this environment" in message
        ):
            raise HTTPException(
                status_code=400,
                detail={"error": message, "code": "VAULT_PASSKEY_RP_MISMATCH"},
            )
        raise HTTPException(
            status_code=400, detail={"error": message, "code": "VAULT_VALIDATION_ERROR"}
        )
    except Exception as e:
        logger.error(
            "vault/wrapper/upsert error user=%s method=%s: %s",
            _mask_user_id(request.userId),
            request.method,
            e,
        )
        _raise_database_http_exception(e)


@router.post("/vault/wrapper/delete", response_model=SuccessResponse)
async def vault_wrapper_delete(
    http_request: Request,
    request: VaultWrapperDeleteRequest,
    firebase_uid: str = Depends(require_firebase_auth),
    vault_owner_token: dict = Depends(require_vault_owner_consent_header),
):
    """Remove an enrolled non-passphrase vault wrapper."""
    verify_user_id_match(firebase_uid, request.userId)
    _require_matching_vault_owner(vault_owner_token, request.userId)
    _check_client_version_or_raise(http_request)
    logger.info(
        "vault/wrapper/delete request user=%s method=%s",
        _mask_user_id(request.userId),
        request.method,
    )

    try:
        service = VaultKeysService()
        await service.delete_wrapper(
            user_id=request.userId,
            vault_key_hash=request.vaultKeyHash,
            method=request.method,
            wrapper_id=request.wrapperId,
            fallback_primary_method=request.fallbackPrimaryMethod,
            fallback_primary_wrapper_id=request.fallbackPrimaryWrapperId,
        )
        if _is_passkey_method(request.method):
            await _send_vault_change_notice(request.userId, "passkey_removed")
        return SuccessResponse(success=True)

    except ValueError as e:
        message = str(e)
        code = "VAULT_VALIDATION_ERROR"
        if "vaultKeyHash mismatch" in message:
            code = "VAULT_KEY_HASH_MISMATCH"
        elif "Vault wrapper not found" in message:
            code = "VAULT_WRAPPER_NOT_FOUND"
        elif "Passphrase wrapper cannot be removed" in message:
            code = "VAULT_PASSPHRASE_REQUIRED"
        elif "Fallback primary method/wrapper" in message:
            code = "VAULT_PRIMARY_WRAPPER_NOT_FOUND"
        raise HTTPException(status_code=400, detail={"error": message, "code": code})
    except Exception as e:
        logger.error(
            "vault/wrapper/delete error user=%s method=%s: %s",
            _mask_user_id(request.userId),
            request.method,
            e,
        )
        _raise_database_http_exception(e)


@router.post("/vault/primary/set", response_model=SuccessResponse)
async def vault_primary_set(
    http_request: Request,
    request: VaultPrimaryMethodSetRequest,
    firebase_uid: str = Depends(require_firebase_auth),
    vault_owner_token: dict = Depends(require_vault_owner_consent_header),
):
    """Set default vault unlock method among already enrolled wrappers."""
    verify_user_id_match(firebase_uid, request.userId)
    _require_matching_vault_owner(vault_owner_token, request.userId)
    _check_client_version_or_raise(http_request)
    logger.info(
        "vault/primary/set request user=%s primary=%s",
        _mask_user_id(request.userId),
        request.primaryMethod,
    )

    try:
        service = VaultKeysService()
        await service.set_primary_method(
            user_id=request.userId,
            primary_method=request.primaryMethod,
            primary_wrapper_id=request.primaryWrapperId,
        )
        return SuccessResponse(success=True)

    except ValueError as e:
        message = str(e)
        if "Primary method/wrapper must be an enrolled wrapper" in message:
            raise HTTPException(
                status_code=400,
                detail={"error": message, "code": "VAULT_PRIMARY_WRAPPER_NOT_FOUND"},
            )
        raise HTTPException(
            status_code=400, detail={"error": message, "code": "VAULT_VALIDATION_ERROR"}
        )
    except Exception as e:
        logger.error(
            "vault/primary/set error user=%s primary=%s: %s",
            _mask_user_id(request.userId),
            request.primaryMethod,
            e,
        )
        _raise_database_http_exception(e)


@router.post("/vault/integrity", response_model=VaultIntegrityResponse)
async def vault_integrity(
    request: VaultGetRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """
    Validate vault invariants for the authenticated user.
    Intended for internal/dev diagnostics.
    """
    verify_user_id_match(firebase_uid, request.userId)

    try:
        service = VaultKeysService()
        vault_state = await service.get_vault_state(request.userId)
        if not vault_state:
            return VaultIntegrityResponse(
                valid=False,
                hasVault=False,
                wrapperCount=0,
                hasPassphraseWrapper=False,
                primaryMethodEnrolled=False,
                methods=[],
            )

        wrappers = vault_state.get("wrappers") or []
        methods = sorted(
            {
                (wrapper.get("method") or "").strip()
                for wrapper in wrappers
                if isinstance(wrapper, dict)
            }
        )
        has_passphrase = "passphrase" in methods
        primary_method = (vault_state.get("primaryMethod") or "passphrase").strip()
        primary_enrolled = primary_method in methods
        valid = len(methods) > 0 and has_passphrase and primary_enrolled

        return VaultIntegrityResponse(
            valid=valid,
            hasVault=True,
            wrapperCount=len(wrappers),
            hasPassphraseWrapper=has_passphrase,
            primaryMethodEnrolled=primary_enrolled,
            methods=methods,
        )
    except Exception as e:
        logger.error("vault/integrity error user=%s: %s", _mask_user_id(request.userId), e)
        _raise_database_http_exception(e)


# ============================================================================
# Vault Status Endpoint (Token-Enforced Metadata)
# ============================================================================


async def validate_vault_owner_token(consent_token: str, user_id: str) -> None:
    """Validate VAULT_OWNER consent token with DB-backed revocation check."""
    if not consent_token:
        raise HTTPException(
            status_code=401,
            detail="Missing consent token. Vault owner must provide VAULT_OWNER token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    valid, reason, token_obj = await validate_token_with_db(consent_token, ConsentScope.VAULT_OWNER)

    if not valid:
        logger.warning("db_proxy.validate_vault_owner_token.invalid reason=%s", reason)
        raise HTTPException(
            status_code=401,
            detail="Invalid or expired consent token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if token_obj is None:
        logger.error("Consent token validated but payload missing")
        raise HTTPException(
            status_code=401,
            detail="Invalid consent token: missing token payload",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if token_obj.scope != ConsentScope.VAULT_OWNER:
        logger.warning(
            f"Insufficient scope: {token_obj.scope.value} (requires {ConsentScope.VAULT_OWNER.value})"
        )
        raise HTTPException(
            status_code=403,
            detail=f"Insufficient scope: {token_obj.scope.value}. VAULT_OWNER scope required.",
        )

    if str(token_obj.user_id) != user_id:
        logger.warning(f"Token userId mismatch: {token_obj.user_id} != {user_id}")
        raise HTTPException(status_code=403, detail="Token userId does not match requested userId")

    logger.info("vault_owner.token_validated")


@router.post("/vault/status")
async def get_vault_status(
    request: Request,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """
    Get status for all vault domains.
    Returns metadata without encrypted data.

    SECURITY: Requires Firebase authentication AND VAULT_OWNER token.
    """
    try:
        body = await request.json()
        user_id = body.get("userId")
        consent_token = body.get("consentToken")

        if not user_id:
            raise HTTPException(status_code=400, detail="userId is required")

        # Verify user is getting their own vault status
        verify_user_id_match(firebase_uid, user_id)

        # Use VaultKeysService (handles consent validation internally)
        service = VaultKeysService()
        await validate_vault_owner_token(consent_token, user_id)
        status = await service.get_vault_status(user_id, consent_token)

        return status

    except ValueError:
        raise HTTPException(status_code=401, detail="Unauthorized")
    except HTTPException:
        raise
    except Exception:
        logger.error("vault.status.error", exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error")
