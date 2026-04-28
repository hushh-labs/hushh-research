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
- All connections use Supabase session pooler (DB_*); SSL required
"""

import logging
import os
import re

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from api.middleware import require_firebase_auth, verify_user_id_match
from db.connection import DatabaseUnavailableError
from db.db_client import DatabaseExecutionError
from hushh_mcp.consent.token import validate_token_with_db
from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.vault_keys_service import VaultKeysService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/db", tags=["Database Proxy (DEPRECATED)"])
MIN_VAULT_WRITE_CLIENT_VERSION = os.getenv("MIN_VAULT_WRITE_CLIENT_VERSION", "2.0.0")
ENFORCE_VAULT_WRITE_CLIENT_VERSION = os.getenv(
    "ENFORCE_VAULT_WRITE_CLIENT_VERSION", "true"
).strip().lower() not in {"0", "false", "no"}


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
    if isinstance(exc, DatabaseUnavailableError):
        raise HTTPException(
            status_code=exc.status_code,
            detail={
                "error": "Database is temporarily unavailable.",
                "code": exc.code,
                **({"hint": exc.hint} if exc.hint else {}),
            },
        ) from exc
    if isinstance(exc, DatabaseExecutionError):
        status_code = getattr(exc, "status_code", 500)
        raise HTTPException(
            status_code=status_code,
            detail={
                "error": "Database is temporarily unavailable."
                if status_code == 503
                else "Database error",
                "code": getattr(exc, "code", "DATABASE_EXECUTION_ERROR"),
                **({"hint": getattr(exc, "hint", None)} if getattr(exc, "hint", None) else {}),
            },
        ) from exc


# ============================================================================
# Request/Response Models
# ============================================================================


class VaultCheckRequest(BaseModel):
    userId: str


class VaultCheckResponse(BaseModel):
    hasVault: bool


class VaultBootstrapStateRequest(BaseModel):
    userId: str | None = None


class VaultBootstrapStateResponse(BaseModel):
    userId: str
    hasVault: bool
    vaultStatus: str
    firstLoginAt: int | None = None
    lastLoginAt: int | None = None
    loginCount: int
    preOnboardingCompleted: bool | None = None
    preOnboardingSkipped: bool | None = None
    preOnboardingCompletedAt: int | None = None
    preNavTourCompletedAt: int | None = None
    preNavTourSkippedAt: int | None = None
    preStateUpdatedAt: int | None = None


class VaultPreStateUpdateRequest(BaseModel):
    userId: str | None = None
    preOnboardingCompleted: bool | None = None
    preOnboardingSkipped: bool | None = None
    preOnboardingCompletedAt: int | None = None
    preNavTourCompletedAt: int | None = None
    preNavTourSkippedAt: int | None = None


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
        has_vault = await service.check_vault_exists(request.userId)
        return VaultCheckResponse(hasVault=has_vault)

    except Exception as e:
        logger.error(f"vault/check error: {e}")
        _raise_database_http_exception(e)
        raise HTTPException(status_code=500, detail="Database error")


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
        has_vault = await service.check_vault_exists(user_id, ensure_entry=False)

        return VaultBootstrapStateResponse(
            userId=user_id,
            hasVault=has_vault,
            vaultStatus=state.get("vaultStatus") or "active",
            firstLoginAt=state.get("firstLoginAt"),
            lastLoginAt=state.get("lastLoginAt"),
            loginCount=int(state.get("loginCount") or 0),
            preOnboardingCompleted=state.get("preOnboardingCompleted"),
            preOnboardingSkipped=state.get("preOnboardingSkipped"),
            preOnboardingCompletedAt=state.get("preOnboardingCompletedAt"),
            preNavTourCompletedAt=state.get("preNavTourCompletedAt"),
            preNavTourSkippedAt=state.get("preNavTourSkippedAt"),
            preStateUpdatedAt=state.get("preStateUpdatedAt"),
        )
    except ValueError as e:
        raise HTTPException(
            status_code=400, detail={"error": str(e), "code": "VAULT_VALIDATION_ERROR"}
        )
    except Exception as e:
        logger.error("vault/bootstrap-state error user=%s: %s", _mask_user_id(user_id), e)
        _raise_database_http_exception(e)
        raise HTTPException(status_code=500, detail="Database error")


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
            pre_onboarding_completed=request.preOnboardingCompleted,
            pre_onboarding_skipped=request.preOnboardingSkipped,
            pre_onboarding_completed_at=request.preOnboardingCompletedAt,
            pre_nav_tour_completed_at=request.preNavTourCompletedAt,
            pre_nav_tour_skipped_at=request.preNavTourSkippedAt,
        )
        has_vault = await service.check_vault_exists(user_id, ensure_entry=False)

        return VaultBootstrapStateResponse(
            userId=user_id,
            hasVault=has_vault,
            vaultStatus=state.get("vaultStatus") or "active",
            firstLoginAt=state.get("firstLoginAt"),
            lastLoginAt=state.get("lastLoginAt"),
            loginCount=int(state.get("loginCount") or 0),
            preOnboardingCompleted=state.get("preOnboardingCompleted"),
            preOnboardingSkipped=state.get("preOnboardingSkipped"),
            preOnboardingCompletedAt=state.get("preOnboardingCompletedAt"),
            preNavTourCompletedAt=state.get("preNavTourCompletedAt"),
            preNavTourSkippedAt=state.get("preNavTourSkippedAt"),
            preStateUpdatedAt=state.get("preStateUpdatedAt"),
        )
    except ValueError as e:
        raise HTTPException(
            status_code=400, detail={"error": str(e), "code": "VAULT_VALIDATION_ERROR"}
        )
    except Exception as e:
        logger.error("vault/pre-vault-state error user=%s: %s", _mask_user_id(user_id), e)
        _raise_database_http_exception(e)
        raise HTTPException(status_code=500, detail="Database error")


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
        raise HTTPException(status_code=500, detail="Database error")


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
        return SuccessResponse(success=True)

    except ValueError as e:
        message = str(e)
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
        raise HTTPException(status_code=500, detail="Database error")


@router.post("/vault/wrapper/upsert", response_model=SuccessResponse)
async def vault_wrapper_upsert(
    http_request: Request,
    request: VaultWrapperUpsertRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Add or update a single vault wrapper for an enrolled method."""
    verify_user_id_match(firebase_uid, request.userId)
    _check_client_version_or_raise(http_request)
    logger.info(
        "vault/wrapper/upsert request user=%s method=%s",
        _mask_user_id(request.userId),
        request.method,
    )

    try:
        service = VaultKeysService()
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
        raise HTTPException(status_code=500, detail="Database error")


@router.post("/vault/primary/set", response_model=SuccessResponse)
async def vault_primary_set(
    http_request: Request,
    request: VaultPrimaryMethodSetRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Set default vault unlock method among already enrolled wrappers."""
    verify_user_id_match(firebase_uid, request.userId)
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
        raise HTTPException(status_code=500, detail="Database error")


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
        raise HTTPException(status_code=500, detail="Database error")


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
        logger.warning(f"Invalid consent token: {reason}")
        raise HTTPException(
            status_code=401,
            detail=f"Invalid consent token: {reason}",
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

    logger.info(f"✅ VAULT_OWNER token validated for {user_id}")


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

    except ValueError as e:
        # Consent validation errors
        raise HTTPException(status_code=401, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ Vault status error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
