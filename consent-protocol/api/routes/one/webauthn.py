"""Server-side WebAuthn / FIDO2 ceremony endpoints (M14).

Real, server-verified passkey + hardware-key (Titan/YubiKey) registration and
authentication — the login-grade counterpart to the existing client-side PRF
vault-unlock flow. Flag-gated by ``WEBAUTHN_ENABLED`` (404 when off).

- register/* require the Firebase-authenticated user (you add a key to *your* account).
- authenticate/* are public (login), rate-limited; verify checks the assertion and,
  when it carries user verification (AAL2+), mints a Firebase custom token the client
  exchanges for a session. Assertions without user verification are reported verified
  but are NOT accepted as a login. Google Titan / YubiKey hardware keys are classified
  (AAL) via their AAGUID (webauthn_aal.py).
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from api.middleware import require_firebase_auth
from api.middlewares.rate_limit import RateLimits, limiter
from api.utils.firebase_admin import ensure_firebase_auth_admin, get_firebase_auth_app
from hushh_mcp.runtime_settings import webauthn_enabled
from hushh_mcp.services.webauthn_repo import WebAuthnChallengeStore, WebAuthnCredentialRepo
from hushh_mcp.services.webauthn_service import WebAuthnService, get_webauthn_settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/webauthn", tags=["webauthn"])


def _require_enabled() -> None:
    if not webauthn_enabled():
        raise HTTPException(status_code=404, detail="webauthn is not available")


def _service() -> WebAuthnService:
    return WebAuthnService(
        credentials=WebAuthnCredentialRepo(),
        challenges=WebAuthnChallengeStore(),
        settings=get_webauthn_settings(),
    )


async def _body(request: Request) -> dict[str, Any]:
    try:
        data = await request.json()
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _options_response(options_json: str) -> Response:
    # begin_* returns a JSON string (py_webauthn options_to_json); pass it through.
    return Response(content=options_json, media_type="application/json")


def _mint_session(*, user_id: str, aal: str, credential_id: str) -> Optional[str]:
    """Mint a Firebase custom token for a passkey/hardware-key login. Best-effort:
    returns None if the Firebase admin app is unavailable, so the endpoint degrades
    to 'verified but no session' rather than failing."""
    try:
        configured, _ = ensure_firebase_auth_admin()
        if not configured:
            return None
        from firebase_admin import auth as firebase_auth

        token = firebase_auth.create_custom_token(
            user_id,
            {"amr": ["webauthn"], "aal": aal, "credId": credential_id},
            app=get_firebase_auth_app(),
        )
        return token.decode("utf-8") if isinstance(token, bytes) else str(token)
    except Exception:  # never leak provider internals; degrade to no-session
        logger.warning("webauthn.session_mint_failed")
        return None


@router.post("/register/options")
@limiter.limit(RateLimits.AGENT_CHAT)
async def register_options(
    request: Request, user_id: str = Depends(require_firebase_auth)
) -> Response:
    """Registration options for `navigator.credentials.create()` (this account)."""
    _require_enabled()
    body = await _body(request)
    user_name = str(body.get("userName") or user_id)
    display_name = body.get("displayName")
    options = await _service().begin_registration(
        user_id=user_id, user_name=user_name, display_name=display_name
    )
    return _options_response(options)


@router.post("/register/verify")
@limiter.limit(RateLimits.AGENT_CHAT)
async def register_verify(
    request: Request, user_id: str = Depends(require_firebase_auth)
) -> dict[str, Any]:
    """Verify the attestation and store the new credential's public key."""
    _require_enabled()
    body = await _body(request)
    credential = body.get("credential") or body
    try:
        result: dict[str, Any] = await _service().finish_registration(
            user_id=user_id, credential=credential, device_label=body.get("deviceLabel")
        )
        return result
    except ValueError as exc:
        raise HTTPException(
            status_code=400, detail={"code": "WEBAUTHN_REGISTER_FAILED", "message": str(exc)}
        ) from exc


@router.post("/authenticate/options")
@limiter.limit(RateLimits.AGENT_CHAT)
async def authenticate_options(request: Request) -> Response:
    """Usernameless authentication options for `navigator.credentials.get()` (login)."""
    _require_enabled()
    return _options_response(await _service().begin_authentication())


@router.post("/authenticate/verify")
@limiter.limit(RateLimits.AGENT_CHAT)
async def authenticate_verify(request: Request) -> dict[str, Any]:
    """Verify a login assertion and, when it carries user verification (AAL2+), mint a
    Firebase custom token the client exchanges for a session. An assertion WITHOUT user
    verification is reported verified but is not accepted as a login (no session)."""
    _require_enabled()
    body = await _body(request)
    credential = body.get("credential") or body
    try:
        result = await _service().finish_authentication(credential=credential)
    except ValueError as exc:
        raise HTTPException(
            status_code=400, detail={"code": "WEBAUTHN_AUTH_FAILED", "message": str(exc)}
        ) from exc
    response: dict[str, Any] = {"verified": True, **result}
    # Login requires user verification (biometric/PIN) -> at least AAL2.
    if not bool(result.get("userVerified")):
        response["session"] = "user_verification_required"
        return response
    custom_token = _mint_session(
        user_id=str(result["userId"]),
        aal=str(result.get("aal") or "AAL2"),
        credential_id=str(result.get("credentialId") or ""),
    )
    response["customToken"] = custom_token
    response["session"] = "minted" if custom_token else "mint_unavailable"
    return response
