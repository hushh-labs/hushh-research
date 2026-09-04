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
import time
from typing import Any, Literal

from fastapi import APIRouter, Body, Depends, Header, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, ValidationInfo, field_validator

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
    vault_handoff_public_key: str | None = Field(default=None, min_length=40, max_length=64)

    @field_validator("vault_handoff_public_key")
    @classmethod
    def validate_vault_handoff_public_key(cls, value: str | None) -> str | None:
        if value is None:
            return None
        try:
            decoded = base64.b64decode(value, validate=True)
        except (ValueError, TypeError) as exc:
            raise ValueError("vault_handoff_public_key must be base64.") from exc
        if len(decoded) != 32:
            raise ValueError("vault_handoff_public_key must be a 32-byte X25519 key.")
        return value


class TrustedDeviceExchangeRequest(BaseModel):
    code: str = Field(min_length=20, max_length=256)
    code_verifier: str = Field(min_length=43, max_length=128)


class TrustedDeviceVaultHandoffRequest(BaseModel):
    vault_handoff_wrapped_key: str = Field(min_length=40, max_length=64)
    vault_handoff_iv: str = Field(min_length=16, max_length=24)
    vault_handoff_tag: str = Field(min_length=20, max_length=32)
    vault_handoff_sender_public_key: str = Field(min_length=40, max_length=64)
    vault_handoff_alg: Literal["X25519-AES256-GCM"]
    vault_handoff_vault_key_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    vault_handoff_wrapper_id: str = Field(min_length=1, max_length=128)
    vault_handoff_rp_id: str = Field(min_length=1, max_length=253)

    @field_validator(
        "vault_handoff_wrapped_key",
        "vault_handoff_iv",
        "vault_handoff_tag",
        "vault_handoff_sender_public_key",
    )
    @classmethod
    def validate_handoff_base64(cls, value: str, info: ValidationInfo) -> str:
        try:
            decoded = base64.b64decode(value, validate=True)
        except (ValueError, TypeError) as exc:
            raise ValueError("Vault handoff fields must be base64.") from exc
        expected_lengths = {
            "vault_handoff_wrapped_key": 32,
            "vault_handoff_iv": 12,
            "vault_handoff_tag": 16,
            "vault_handoff_sender_public_key": 32,
        }
        expected_length = expected_lengths.get(info.field_name or "")
        if expected_length is None or len(decoded) != expected_length:
            raise ValueError("Vault handoff fields have an invalid byte length.")
        return value


async def _trusted_device_guard(user_id: str | None = None) -> None:
    # user_id is retained for call-site compatibility; enrollment no longer
    # depends on per-account rollout membership.
    del user_id
    if not trusted_devices_enabled():
        raise HTTPException(
            status_code=404,
            detail={
                "code": "TRUSTED_DEVICE_DISABLED",
                "message": "Trusted-device authorization is not enabled.",
            },
        )
    # Enrollment is open to every signed-in account once the feature is enabled.
    # The remaining controls still apply per request: the kill switch above, the
    # browser-session identity check in _verify_browser_enrollment_identity, the
    # verified-email requirement enforced at exchange, and the PKCE-bound
    # one-time code. The former per-account rollout allowlist has been removed.
    return


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
        # This public key is validated and echoed from the authenticated
        # approval request. The browser may use it to seal the locally
        # unlocked vault key directly to Hermes; the server never receives the
        # resulting plaintext.
        "vault_handoff_public_key": payload.vault_handoff_public_key,
    }


@router.post("/trusted-device-authorizations/{authorization_id}/vault-handoff")
async def attach_trusted_device_vault_handoff(
    authorization_id: str,
    payload: TrustedDeviceVaultHandoffRequest,
    firebase_uid: str = Depends(require_firebase_auth),
    authorization: str | None = Header(None, alias="Authorization"),
):
    """Attach ciphertext for atomic delivery through the PKCE exchange."""
    await _trusted_device_guard(firebase_uid)
    browser_uid = await _verify_browser_enrollment_identity(authorization)
    if browser_uid != firebase_uid:
        raise HTTPException(status_code=401, detail="Invalid Firebase ID token")
    try:
        await run_in_threadpool(
            TrustedDeviceService().attach_vault_handoff,
            authorization_id=authorization_id,
            user_id=firebase_uid,
            handoff=payload.model_dump(),
        )
    except TrustedDeviceError as exc:
        _raise_trusted_device_error(exc)
    return {"attached": True}


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
    response: dict[str, Any] = {
        "firebase_custom_token": token,
        "device_id": device["device_id"],
        "user_id": device["user_id"],
        "account_email": account_email,
        "replaced_device_id": device.get("replaced_device_id"),
    }
    if device.get("vault_handoff"):
        response.update(
            authorization_id=device.get("authorization_id"),
            authorization_expires_at=device.get("authorization_expires_at"),
            vault_handoff=device.get("vault_handoff"),
        )
    return response


@router.get("/trusted-devices")
async def list_trusted_devices(firebase_uid: str = Depends(require_firebase_auth)):
    # Recovery remains available after rollout is disabled or membership is
    # removed. The authenticated user can only list their own device records.
    devices = await run_in_threadpool(TrustedDeviceService().list_devices, user_id=firebase_uid)
    return {"devices": devices}


@router.get("/trusted-devices/{device_id}/status")
async def trusted_device_status(
    device_id: str,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Own-device liveness read for the native Hermes runtime.

    Firebase-authed: the device keeps a user-level Firebase session after
    revoke, so a device-token gate would be unreachable exactly when the answer
    is 'revoked'. Fail-closed: a DB error is a 503, never a defaulted 'active'.
    Grants nothing; every vault call still gates on the device-bound owner token
    re-checked against is_trusted_device_active.
    """
    try:
        status = await run_in_threadpool(
            TrustedDeviceService().device_status,
            user_id=firebase_uid,
            device_id=device_id,
        )
    except Exception:
        logger.exception("trusted_device.status_lookup_failed")
        raise HTTPException(
            status_code=503,
            detail={
                "code": "TRUSTED_DEVICE_STATUS_UNAVAILABLE",
                "message": "Trusted-device status is temporarily unavailable.",
            },
        ) from None
    if status is None:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "TRUSTED_DEVICE_UNKNOWN",
                "message": "No such trusted device for this account.",
            },
        )
    return {**status, "server_time_ms": int(time.time() * 1000)}


@router.post("/trusted-devices/{device_id}/seal-ack")
async def trusted_device_seal_ack(
    device_id: str,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Advisory seal confirmation from the native runtime after a remote revoke.

    Firebase-authed only, with NO device signature: the device P-256 key is
    zeroized during seal, so a post-seal signature is unsatisfiable and a static
    one would be replayable. The ack is device-reported telemetry, never proof
    of sealing and never authorization. The server stamps its own sealed_at, can
    only stamp an already-revoked row, and enforcement never consults sealed_at.
    """
    try:
        result = await run_in_threadpool(
            TrustedDeviceService().seal_device,
            user_id=firebase_uid,
            device_id=device_id,
        )
    except Exception:
        logger.exception("trusted_device.seal_ack_failed")
        raise HTTPException(
            status_code=503,
            detail={
                "code": "TRUSTED_DEVICE_STATUS_UNAVAILABLE",
                "message": "Trusted-device status is temporarily unavailable.",
            },
        ) from None
    if result is None:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "TRUSTED_DEVICE_UNKNOWN",
                "message": "No such trusted device for this account.",
            },
        )
    return result


def _heartbeat_snapshot(body: Any) -> dict[str, Any]:
    """Read the telemetry out of a heartbeat body, flat or wrapped.

    The route deliberately does NOT validate the body with a typed model. The
    heartbeat is advisory telemetry whose one load-bearing effect is stamping
    ``last_heartbeat_at``, and the service allow-list (``_safe_heartbeat``)
    already keeps only known scalar fields, truncates text and drops
    out-of-range numbers. A typed model with bounds in front of it turned one
    over-long value into a 422 for the WHOLE beat: a 121-character model id
    made every push fail, the device read as gone in One while it was healthy,
    and the failure was silent because telemetry never raises on the device.
    Sanitising per field costs that field; rejecting per request costs the
    signal.

    Two body shapes are read. Hermes builds from 2026-08-28 (when the
    heartbeat first shipped) to 2026-09-03 posted the snapshot wrapped as
    ``{"heartbeat": {...}}``; later builds post it flat. Top-level keys win
    over the wrapped block on a shared key, and only one level is unwrapped.
    A body that is not an object is an empty reading, which still stamps the
    beat: liveness is the signal, the fields are extras.
    """
    if not isinstance(body, dict):
        return {}
    wrapped = body.get("heartbeat")
    inner = (
        {key: value for key, value in wrapped.items() if key != "heartbeat"}
        if isinstance(wrapped, dict)
        else {}
    )
    flat = {key: value for key, value in body.items() if key != "heartbeat"}
    return {**inner, **flat}


@router.post("/trusted-devices/{device_id}/heartbeat")
async def trusted_device_heartbeat(
    device_id: str,
    payload: Any = Body(default=None),
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Liveness heartbeat from a running trusted device.

    Answers "is this agent reachable right now?", which last_synced_at cannot:
    that column only advances when the device pulls the sync channel, so a
    running-but-idle agent reads as stale.

    Firebase-authed, matching the own-device status read: the device keeps a
    user-level session, and a heartbeat grants nothing, so it needs no device
    signature. Purely advisory telemetry -- the server stamps its own timestamp,
    updates only an active row so a revoked device can never appear live, and
    enforcement never consults it. Trust stays decided by status and
    is_trusted_device_active.
    """
    snapshot = _heartbeat_snapshot(payload)
    try:
        await run_in_threadpool(
            TrustedDeviceService().record_heartbeat,
            user_id=firebase_uid,
            device_id=device_id,
            snapshot=snapshot,
        )
    except Exception:
        logger.exception("trusted_device.heartbeat_failed")
        raise HTTPException(
            status_code=503,
            detail={
                "code": "TRUSTED_DEVICE_STATUS_UNAVAILABLE",
                "message": "Trusted-device status is temporarily unavailable.",
            },
        ) from None
    return {"recorded": True, "server_time_ms": int(time.time() * 1000)}


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


#: The North American reserved fictitious range (+1 555 0100 -- +1 555 0199).
#: A simulation allowlist may contain NOTHING else, so a dev lane can never claim
#: a routable number that belongs to a real person. The UAT and production lanes
#: are unaffected: they are operator-curated and predate this.
_SIMULATION_PHONE_PREFIX = "+1555010"


def _configured_uat_phone_test_numbers() -> set[str]:
    raw = _clean_env("HUSHH_UAT_PHONE_TEST_NUMBERS") or _clean_env("UAT_PHONE_TEST_NUMBERS")
    return _parse_phone_test_numbers(raw)


def _configured_prod_phone_test_numbers() -> set[str]:
    return _parse_phone_test_numbers(_clean_env("HUSHH_PROD_PHONE_TEST_NUMBERS"))


def _configured_dev_phone_test_numbers() -> set[str]:
    """The simulation lane's allowlist, or empty when simulation is not permitted.

    This exists because the dev hub deliberately runs with the **uat** runtime
    identity for behaviour parity, so `_runtime_environment()` reads `uat` on a
    dev box and `uat` on real UAT and cannot separate them. Until this lane
    existed, dev reached the bypass only by being indistinguishable from UAT --
    which is precisely the confusion `dev_simulation_guard` was written to end.

    The guard reads the DEPLOY LANE, which is written per-lane by the deploy
    workflow and stays honest, and it denies when unconfigured. So this branch is
    reachable on a dev deployment and on a developer's box that opted in, and
    nowhere else.
    """
    from hushh_mcp.services.dev_simulation_guard import simulation_permitted

    if not simulation_permitted():
        return set()
    numbers = _parse_phone_test_numbers(_clean_env("HUSHH_DEV_PHONE_TEST_NUMBERS"))
    # Fail loud rather than silently narrowing: an operator who put a real number
    # in a simulation allowlist has made a mistake worth stopping on.
    outside = {n for n in numbers if not n.startswith(_SIMULATION_PHONE_PREFIX)}
    if outside:
        raise RuntimeError(
            "HUSHH_DEV_PHONE_TEST_NUMBERS may only contain reserved fictitious "
            f"numbers ({_SIMULATION_PHONE_PREFIX}xx); refused {sorted(outside)}"
        )
    return numbers


def _configured_phone_test_numbers() -> set[str]:
    environment = _runtime_environment()
    dev_numbers = _configured_dev_phone_test_numbers()
    if dev_numbers:
        # The simulation lane also honours the operator-curated UAT allowlist.
        # Dev ran on that allowlist for as long as its runtime identified as
        # `uat`; the 2026-08-07 dev-identity change silently dropped it, which
        # stranded the numbers people actually use there (founder-reported,
        # 2026-08-21: the standing +1 989 898 9894 / 000000 pair stopped
        # working on dev). The reserved +1 555 0100-0199 range stays the only
        # thing HUSHH_DEV_PHONE_TEST_NUMBERS itself may carry — that guard is
        # untouched — and a uat-sourced number keeps its fixed UAT code on
        # confirm, so merging widens which numbers are claimable in the lane
        # without relaxing how they are claimed.
        return dev_numbers | _configured_uat_phone_test_numbers()
    if environment == "uat":
        return _configured_uat_phone_test_numbers()
    if environment == "production" and _is_truthy_env("HUSHH_PROD_PHONE_TEST_ENABLED"):
        return _configured_prod_phone_test_numbers()
    return set()


def _configured_dev_phone_test_code() -> str:
    from hushh_mcp.services.dev_simulation_guard import simulation_permitted

    return _clean_env("HUSHH_DEV_PHONE_TEST_CODE") if simulation_permitted() else ""


def _dev_phone_code_is_optional() -> bool:
    """In the simulation lane with no code configured, the OTP step is skipped.

    The dev deployment is meant to behave like localhost: it must not block
    end-to-end testing behind a code somebody has to go and set. Requiring one
    meant a manual `gcloud run services update` after **every** dev deploy, since
    the deploy uses `--set-env-vars` and replaces the whole environment — a step
    that would be forgotten, and whose absence looks exactly like a broken lane.

    So no code configured means no code checked. This is a real relaxation and it
    is bounded on three sides, all of which must hold at once:

      * `simulation_permitted()` — an explicit opt-in AND a deploy lane naming a
        development environment. `uat`, `staging` and `production` are refused
        outright, and absence of configuration denies.
      * the allowlist — the code may be skipped ONLY for the reserved fictitious
        range (+1 555 0100-0199), so no real person's number is claimable
        without a code. Operator-curated UAT numbers are also claimable in the
        lane (see `_configured_phone_test_numbers`), but they keep their fixed
        UAT code on confirm — the relaxation never extends to them.
      * the challenge — `_is_valid_uat_phone_test_verification_id` still has to
        pass, so the confirm call must follow a start call for the same number.

    Setting `HUSHH_DEV_PHONE_TEST_CODE` turns the code check back on without any
    other change, which is the escape hatch if dev ever needs to rehearse the
    real OTP flow.
    """
    return bool(_configured_dev_phone_test_numbers()) and not _configured_dev_phone_test_code()


def _configured_uat_phone_test_code() -> str:
    return _clean_env("HUSHH_UAT_PHONE_TEST_CODE") or _clean_env("UAT_PHONE_TEST_CODE")


def _configured_prod_phone_test_code() -> str:
    return _clean_env("HUSHH_PROD_PHONE_TEST_CODE")


def _configured_prod_phone_test_challenge_secret() -> str:
    return _clean_env("HUSHH_PROD_PHONE_TEST_CHALLENGE_SECRET")


def _configured_phone_test_code() -> str:
    environment = _runtime_environment()
    dev_code = _configured_dev_phone_test_code()
    if dev_code:
        return dev_code
    if environment == "uat":
        return _configured_uat_phone_test_code()
    if environment == "production" and _is_truthy_env("HUSHH_PROD_PHONE_TEST_ENABLED"):
        return _configured_prod_phone_test_code()
    return ""


def _phone_test_enabled() -> bool:
    if _runtime_environment() == "production":
        # The simulation lane is never reachable here: `simulation_permitted()`
        # refuses `production` outright, so the dev resolvers return empty and
        # this branch is the only answer production can give.
        return bool(
            _is_truthy_env("HUSHH_PROD_PHONE_TEST_ENABLED")
            and _configured_prod_phone_test_numbers()
            and _configured_prod_phone_test_code()
            and _configured_prod_phone_test_challenge_secret()
        )
    if _dev_phone_code_is_optional():
        return True
    return bool(_configured_phone_test_numbers() and _configured_phone_test_code())


def _phone_test_expected_code(phone_number: str) -> tuple[str, bool]:
    """The (expected_code, code_optional) claim semantics for one allowlisted number.

    The two allowlists keep their own semantics when merged on dev: the code may
    be skipped ONLY for the reserved fictitious range, and an operator-curated
    UAT number keeps its fixed UAT code even inside the simulation lane.
    """
    dev_reserved = phone_number in _configured_dev_phone_test_numbers()
    configured = _configured_phone_test_code()
    expected = configured if dev_reserved else (_configured_uat_phone_test_code() or configured)
    optional = _dev_phone_code_is_optional() and dev_reserved
    return expected, optional


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


_SUBSTRATE_TOMBSTONE_STATUS = "substrate_torn_down"
# Status-scoped reclaim marker for a PARTIAL substrate teardown: it names the survivors
# but never short-circuits a retry (the idempotency guard checks only the status above).
_SUBSTRATE_INCOMPLETE_STATUS = "substrate_teardown_incomplete"


async def _byoc_anchor_without_row(registry: Any, user_id: str) -> dict[str, Any] | None:
    """Rebuild the BYOC coordinates for a person whose registry row is already gone.

    Sources, both of which outlive the row: ``byoc_setup_jobs`` (user -> project; it is
    deleted only after this teardown runs) and the ``deprovision_requested`` tombstone
    that names that project (hushh_id, region, bootstrap account). Returns ``None`` when
    either is missing, which is the pre-existing "nothing BYOC to tear down" answer.
    Never raises.
    """
    try:
        from hushh_mcp.services.byoc_setup_job_service import (  # noqa: PLC0415
            ByocSetupJobRepo,
        )

        job = await ByocSetupJobRepo().get(user_id)
        project = str((job or {}).get("project_id") or "").strip()
        if not project:
            return None
        finder = getattr(registry, "latest_tombstone_for_project", None)
        if finder is None:
            return None
        tomb = await finder(project, status="deprovision_requested")
        hushh_id = str((tomb or {}).get("hushh_id") or "").strip()
        if not tomb or not hushh_id:
            logger.warning(
                "personal_agent.substrate_anchor_missing user=%s project=%s -- "
                "setup job names a project but no deprovision tombstone does",
                user_id,
                project,
            )
            return None
        meta = tomb.get("metadata") or {}
        bootstrap_sa = str(meta.get("user_cloud_bootstrap_sa") or "").strip()
        derived = False
        if not bootstrap_sa:
            # Tombstones written before the bootstrap account was recorded: fall back to
            # the conventional name. A wrong guess fails loudly at token mint and lands
            # in the incomplete marker; it never reads as a clean erase.
            bootstrap_sa = f"one-bootstrap@{project}.iam.gserviceaccount.com"
            derived = True
        logger.info(
            "personal_agent.substrate_anchor_from_tombstone user=%s project=%s "
            "hushh_id=%s derived_bootstrap=%s",
            user_id,
            project,
            hushh_id,
            derived,
        )
        return {
            "deployment_target": "user_gcp",
            "user_cloud_project": project,
            "hushh_id": hushh_id,
            "user_cloud_region": str(meta.get("user_cloud_region") or "").strip() or "us-central1",
            "user_cloud_bootstrap_sa": bootstrap_sa,
        }
    except Exception as exc:  # noqa: BLE001 - deletion must complete regardless
        logger.warning(
            "personal_agent.substrate_anchor_failed user=%s err=%s", user_id, type(exc).__name__
        )
        return None


async def _teardown_byoc_substrate(
    registry: Any, user_id: str, *, row: Any = None
) -> dict[str, Any] | None:
    """Remove what hushh created inside the person's OWN project. Their project
    itself is theirs and is never touched. Returns a summary dict, or None when
    there is nothing BYOC about this row. Never raises.

    Accepts a PRE-FETCHED ``row`` because it now runs AFTER deprovision, and on the
    legacy path deprovision deletes the row -- a re-read would return None and silently
    skip the whole teardown. The caller captures the row before deprovision and passes
    it here."""
    try:
        row = row if row is not None else await registry.get(user_id)
        if not row or str(row.get("deployment_target") or "") != "user_gcp":
            # A pod deleted from the UI earlier has already dropped its registry row.
            # The person's project still holds what the authorize step built (an
            # admin-role bootstrap account, a keyring, an artifact repo), so recover
            # the anchor from their setup job + the deprovision tombstone instead of
            # silently skipping the teardown.
            row = await _byoc_anchor_without_row(registry, user_id)
            if row is None:
                return None
        project = str(row.get("user_cloud_project") or "").strip()
        hushh_id = str(row.get("hushh_id") or "").strip()
        if not project or not hushh_id:
            return None
        region = str(row.get("user_cloud_region") or "").strip() or "us-central1"
        bootstrap_sa = str(row.get("user_cloud_bootstrap_sa") or "").strip()
        if not bootstrap_sa:
            return {"executed": False, "reason": "no bootstrap account on the row"}

        # Idempotency: a retried account deletion must not re-mint a token and re-run a
        # teardown whose resources are already destroyed. The substrate tombstone is the
        # durable "already done" marker, distinct from deprovision's own tombstone (hence
        # the status scope).
        if await registry.tombstone_exists(hushh_id, status=_SUBSTRATE_TOMBSTONE_STATUS):
            return {"executed": False, "reason": "already_torn_down"}

        import asyncio  # noqa: PLC0415

        from hushh_mcp.services.byoc_substrate_teardown import (
            build_gcp_deleter,
            execute_teardown,
            plan_teardown,
            substrate_resources,
        )
        from hushh_mcp.services.user_gcp_bootstrap import mint_bootstrap_token

        token = await asyncio.to_thread(mint_bootstrap_token, bootstrap_sa=bootstrap_sa)
        # bootstrap_sa comes from the row, not derived: it is the account the person
        # actually granted, and the revoke has to name that one to end hushh's access.
        actions = plan_teardown(substrate_resources(hushh_id, project, bootstrap_sa=bootstrap_sa))
        summary = await execute_teardown(
            actions,
            deleter=build_gcp_deleter(token=token, project=project, region=region),
            dry_run=False,
        )
        failed = list(summary.get("failed") or [])
        logger.info(
            "personal_agent.substrate_teardown user=%s project=%s executed=%s actions=%s failed=%d",
            user_id,
            project,
            summary.get("executed"),
            len(summary.get("planned") or []),
            len(failed),
        )
        # Record the substrate-orphan tombstone ONLY when a real teardown ran (both guards
        # were open) AND every resource is confirmed gone. Withholding it on a partial run
        # means a retried deletion re-runs the whole plan, and each already-gone resource
        # resolves as 404-ok, so retry re-attempts exactly the survivors. With the flag
        # off, execute_teardown returns executed=False, nothing was deleted, and no
        # tombstone is written -- so the marker never lies. Best-effort inside the same
        # try: a tombstone failure must never block account deletion.
        if summary.get("executed") and not failed:
            await registry.tombstone(
                hushh_id=hushh_id,
                external_agent_id=None,
                status=_SUBSTRATE_TOMBSTONE_STATUS,
                metadata={
                    "project": project,
                    "region": region,
                    "resources": [a.get("id") for a in actions],
                },
            )
        out: dict[str, Any] = {"executed": bool(summary.get("executed")), "actions": len(actions)}
        if summary.get("executed") and failed:
            trimmed = [
                {"type": f.get("type"), "id": f.get("id"), "reason": f.get("reason")}
                for f in failed
            ]
            logger.error(
                "personal_agent.substrate_teardown_INCOMPLETE user=%s project=%s failed=%d",
                user_id,
                project,
                len(failed),
            )
            # The reclaim marker sits in its OWN try/except: a DB hiccup on this insert
            # must never route to the generic handler and drop the failed subset from
            # the summary -- preserving that subset is the whole point.
            try:
                await registry.tombstone(
                    hushh_id=hushh_id,
                    external_agent_id=None,
                    status=_SUBSTRATE_INCOMPLETE_STATUS,
                    metadata={"project": project, "region": region, "failed": trimmed},
                )
            except Exception:  # noqa: BLE001 - the marker is best-effort; the summary is not
                logger.warning("personal_agent.substrate_incomplete_marker_failed user=%s", user_id)
            out["incomplete"] = True
            out["failed"] = trimmed
        return out
    except Exception as exc:  # noqa: BLE001 - deletion must complete regardless
        logger.warning(
            "personal_agent.substrate_teardown_failed user=%s err=%s",
            user_id,
            type(exc).__name__,
        )
        # Conservative: an exception mid-teardown can never read as clean erase, even
        # when it fired before anything BYOC was confirmed. Over-report, never under.
        return {"executed": False, "reason": type(exc).__name__, "incomplete": True}


def _surface_substrate_teardown(details: dict, pa: Any, user_id: str) -> None:
    """Surface a PARTIAL substrate teardown into the deletion response, loudly.

    The compute result can be clean while resources survive in the person's own
    project, so the incomplete flag must fire from the substrate summary too --
    on BOTH delete-order paths."""
    sub = pa.get("substrate_teardown") if isinstance(pa, dict) else None
    if not (isinstance(sub, dict) and sub.get("incomplete")):
        return
    details["personal_agent_teardown_incomplete"] = True
    if sub.get("failed"):
        details["substrate_teardown_failed"] = sub["failed"]
    logger.error(
        "Account deletion completed but %d substrate resource(s) survive in the "
        "person's project for user=%s (named in the substrate_teardown_incomplete "
        "tombstone, reclaimable)",
        len(sub.get("failed") or []),
        user_id,
    )


async def _deprovision_personal_agent(
    user_id: str, *, revoke: bool = False, defer_row_delete: bool = False
) -> dict[str, Any]:
    """Best-effort teardown of the user's personal agent on account deletion.

    Not flag-gated: it must clean up any existing registry row even if the feature
    was later turned off. A missing row is a safe no-op (nothing to tombstone or
    delete). Never raises; account deletion must complete regardless.

    Legacy order (``revoke=False``, ``defer_row_delete=False``) runs LAST, after the
    deletion cascade has ALREADY wiped consent_audit (which fail-closes the standing
    read) -- so a REVOKED event there would re-create a row for a just-deleted user
    and break erasure. Delete-order V2 runs this FIRST with ``revoke=True`` (the
    cascade has not run yet, so the grant must be revoked explicitly) and
    ``defer_row_delete=True`` (keep the recovery-anchor row through the cascade;
    finalize it afterwards)."""
    normalized_user_id = str(user_id or "").strip()
    if not normalized_user_id:
        return {"status": "skipped"}

    try:
        from hushh_mcp.services.compute_backend import resolve_compute_backend
        from hushh_mcp.services.personal_agent_provisioning_service import (
            PersonalAgentProvisioningService,
        )
        from hushh_mcp.services.personal_agent_registry_repo import (
            PersonalAgentRegistryRepo,
        )

        # Teardown must route to the SAME backend that provisioned the host (else a
        # real host would orphan); resolve_compute_backend defaults to inert NullBackend.
        registry = PersonalAgentRegistryRepo()

        # Capture the row BEFORE deprovision: on the legacy path deprovision deletes it,
        # and the substrate teardown that runs afterward would then re-read None and
        # silently skip -- permanently orphaning the user's KMS key, bucket, SA and mail
        # plumbing in their own project. So a capture FAILURE cannot fall through to None:
        # it flips the order for this call only, running teardown FIRST (its own re-read
        # still sees the row, which the failed read did not delete) so erasure is never
        # silently skipped. The compute-before-substrate order is a 503-avoidance nicety,
        # not a correctness rule, and account deletion has no live user to protect from it.
        try:
            row = await registry.get(normalized_user_id)
            capture_failed = False
        except Exception:  # noqa: BLE001 - deletion must complete regardless
            row, capture_failed = None, True
            logger.warning(
                "personal_agent.row_capture_failed_before_teardown user=%s -- "
                "running substrate teardown first so erasure is not skipped",
                normalized_user_id,
            )

        # ORDER: compute FIRST, then the substrate it referenced. A live pod holds open
        # references to its KMS key, CMEK bucket, runtime service account and signing
        # secret; destroying those under a running pod orphans compute that then 503s.
        # This does NOT re-couple to the grant: deprovision(revoke=True) only writes a
        # REVOKED pkm.read consent event (revoke_standing_pkm_read) -- it never touches
        # the bootstrap-SA serviceAccountTokenCreator binding mint_bootstrap_token uses,
        # so substrate teardown still authenticates after deprovision. Best-effort,
        # summarized, flag-gated; never blocks deletion.
        service = PersonalAgentProvisioningService(
            registry=registry, backend=resolve_compute_backend()
        )
        if capture_failed:
            # No captured row to survive a legacy-path delete -> tear substrate down while
            # the row still exists, then deprovision. Erasure completeness beats ordering.
            substrate = await _teardown_byoc_substrate(registry, normalized_user_id)
            result = await service.deprovision(
                user_id=normalized_user_id, revoke=revoke, defer_row_delete=defer_row_delete
            )
        else:
            result = await service.deprovision(
                user_id=normalized_user_id, revoke=revoke, defer_row_delete=defer_row_delete
            )
            substrate = await _teardown_byoc_substrate(registry, normalized_user_id, row=row)

        out = result if isinstance(result, dict) else {"status": str(result or "deprovisioned")}
        if substrate is not None:
            out["substrate_teardown"] = substrate
        # The cloud-setup job record is keyed by user id and is in no cascade, so
        # deletion orphaned it. This lives HERE, not in _finalize_...: finalize
        # runs only on the delete-order-V2 path, so the legacy path leaked the
        # row (audit follow-up, 2026-08-21). _deprovision runs on BOTH paths.
        try:
            from db.db_client import get_db  # noqa: PLC0415

            get_db().table("byoc_setup_jobs").delete().eq("user_id", normalized_user_id).execute()
        except Exception as job_exc:  # noqa: BLE001 - deletion must complete regardless
            logger.warning(
                "byoc_setup_job cleanup failed on deletion user=%s err=%s",
                normalized_user_id,
                type(job_exc).__name__,
            )
        return out
    except Exception as exc:
        logger.warning(
            "Personal-agent deprovision failed for deleted account user=%s error=%s",
            normalized_user_id,
            type(exc).__name__,
        )
        return {"status": "failed"}


async def _finalize_personal_agent_row_delete(user_id: str) -> None:
    """Delete-order V2: delete the registry recovery-anchor row AFTER the cascade.
    Never raises; a missing row is a safe no-op."""
    normalized_user_id = str(user_id or "").strip()
    if not normalized_user_id:
        return
    try:
        from hushh_mcp.services.compute_backend import resolve_compute_backend
        from hushh_mcp.services.personal_agent_provisioning_service import (
            PersonalAgentProvisioningService,
        )
        from hushh_mcp.services.personal_agent_registry_repo import (
            PersonalAgentRegistryRepo,
        )

        service = PersonalAgentProvisioningService(
            registry=PersonalAgentRegistryRepo(), backend=resolve_compute_backend()
        )
        await service.finalize_row_delete(user_id=normalized_user_id)
    except Exception as exc:
        logger.warning(
            "Personal-agent row-delete finalize failed user=%s error=%s",
            normalized_user_id,
            type(exc).__name__,
        )
    # byoc_setup_jobs cleanup moved to _deprovision_personal_agent so it runs on
    # BOTH the V2 and legacy delete paths (this finalize is V2-only).


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

    # The simulation lane may run without a code at all — see
    # `_dev_phone_code_is_optional`. That relaxation is scoped to the RESERVED
    # fictitious range only; `_phone_test_expected_code` keeps each allowlist's
    # own claim semantics when they are merged on dev. The allowlist and the
    # challenge above still had to pass either way.
    expected_code, code_optional = _phone_test_expected_code(phone_number)
    if not code_optional and not secrets.compare_digest(
        str(payload.verification_code or "").strip(), expected_code
    ):
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

    # Delete-order V2 (directive: delete deprovisions the pod FIRST). Revoke the
    # standing read and tear the host down while the row still names WHERE the pod
    # lives -- BEFORE the data cascade -- and keep the recovery-anchor row through
    # the cascade, finalizing its delete afterwards. Flag-gated; legacy order is the
    # fallback. A missing pod is a safe no-op, so this never blocks deletion.
    from hushh_mcp.runtime_settings import personal_agent_delete_order_v2  # noqa: PLC0415

    pa_first: dict[str, Any] | None = None
    if target == "both" and personal_agent_delete_order_v2():
        pa_first = await _deprovision_personal_agent(user_id, revoke=True, defer_row_delete=True)

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
        if pa_first is not None:
            # V2: the host was torn down FIRST; record it and finalize the recovery
            # row LAST (after the cascade). Surface an unreclaimed orphan loudly --
            # the account still completes, but the billing host stays nameable via
            # the retained tombstone rather than silently swallowed.
            details["personal_agent"] = pa_first.get("status")
            if pa_first.get("unreclaimed") is True:
                details["personal_agent_teardown_incomplete"] = True
                logger.error(
                    "Account deletion completed but the personal-agent host could not be "
                    "torn down; a billing orphan may remain for user=%s (retained in the "
                    "deletion tombstone, nameable for reclaim)",
                    user_id,
                )
            _surface_substrate_teardown(details, pa_first, user_id)
            await _finalize_personal_agent_row_delete(user_id)
        else:
            # Legacy order: deprovision LAST, revoke=False (cascade already wiped audit).
            legacy_pa = await _deprovision_personal_agent(user_id)
            details["personal_agent"] = legacy_pa.get("status")
            _surface_substrate_teardown(details, legacy_pa, user_id)
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
