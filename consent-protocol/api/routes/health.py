# api/routes/health.py
"""
Health check endpoints.
"""

import hmac
import logging
import os

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from api.middlewares.rate_limit import limiter
from api.utils.firebase_admin import ensure_firebase_auth_admin, get_firebase_auth_app

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Health"])
NO_STORE_HEADERS = {"Cache-Control": "no-store"}


def _env_truthy(name: str, fallback: str = "false") -> bool:
    raw = str(os.getenv(name, fallback)).strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _is_app_review_mode_enabled() -> bool:
    return _env_truthy("APP_REVIEW_MODE")


def _runtime_profile() -> str:
    return str(os.getenv("APP_RUNTIME_PROFILE", "")).strip().lower()


def _resolve_smoke_overlay_identity(smoke_passphrase: str | None) -> tuple[str, str] | None:
    configured_uid = str(os.getenv("UAT_SMOKE_USER_ID", "")).strip()
    configured_passphrase = str(os.getenv("UAT_SMOKE_PASSPHRASE", "")).strip()
    provided_passphrase = str(smoke_passphrase or "").strip()
    if _runtime_profile() == "production":
        return None
    if not configured_uid or not configured_passphrase or not provided_passphrase:
        return None
    if not hmac.compare_digest(provided_passphrase, configured_passphrase):
        return None
    return configured_uid, "uat_smoke"


@router.get("/")
def health_check():
    """Root health check."""
    return {"status": "ok", "service": "hushh-consent-protocol"}


@router.get("/health")
def health():
    """Detailed health check with agent list."""
    return {"status": "healthy", "agents": ["kai"]}


@router.get("/api/app-config/review-mode")
def app_review_mode_config():
    """Runtime app-review-mode config served from backend env (not frontend build env)."""
    return {"enabled": _is_app_review_mode_enabled()}


@router.post("/api/app-config/review-mode/session")
@limiter.limit("10/minute")
async def issue_app_review_mode_session(request: Request):
    """
    Mint a Firebase custom token for app-review login.

    Security:
    - Enabled only when APP_REVIEW_MODE is true
    - Uses fixed REVIEWER_UID from server env
    - Never returns reviewer password to clients
    """
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    session_subject = "reviewer"
    reviewer_uid = ""
    failure_reason = "missing_reviewer_uid"

    if _is_app_review_mode_enabled():
        reviewer_uid = str(os.getenv("REVIEWER_UID", "")).strip()
    else:
        smoke_overlay = _resolve_smoke_overlay_identity(payload.get("smoke_passphrase"))
        if smoke_overlay:
            reviewer_uid, session_subject = smoke_overlay
            failure_reason = "missing_uat_smoke_user_id"
        else:
            raise HTTPException(
                status_code=403,
                detail="App review mode is disabled",
                headers=NO_STORE_HEADERS,
            )

    if not reviewer_uid:
        logger.error("app_review_mode.session_failed reason=%s", failure_reason)
        raise HTTPException(
            status_code=503,
            detail="Review session identity not configured",
            headers=NO_STORE_HEADERS,
        )

    configured, project_id = ensure_firebase_auth_admin()
    if not configured:
        logger.error("app_review_mode.session_failed reason=firebase_admin_not_configured")
        raise HTTPException(
            status_code=503,
            detail="Firebase Admin not configured",
            headers=NO_STORE_HEADERS,
        )

    try:
        from firebase_admin import auth as firebase_auth

        custom_token = firebase_auth.create_custom_token(
            reviewer_uid,
            app=get_firebase_auth_app(),
        )
        token_str = (
            custom_token.decode("utf-8") if isinstance(custom_token, bytes) else str(custom_token)
        )
    except Exception:
        logger.exception("app_review_mode.session_failed reason=token_mint_error")
        raise HTTPException(
            status_code=500,
            detail="Failed to issue review session token",
            headers=NO_STORE_HEADERS,
        )

    client_ip = request.client.host if request.client else "unknown"
    logger.info(
        "app_review_mode.session_issued reviewer_uid=%s subject=%s project_id=%s client_ip=%s",
        reviewer_uid,
        session_subject,
        project_id or "unknown",
        client_ip,
    )
    return JSONResponse({"token": token_str}, headers=NO_STORE_HEADERS)
