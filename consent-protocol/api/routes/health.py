# api/routes/health.py
"""
Health check endpoints.
"""

import hmac
import logging
import os
from pathlib import Path

from dotenv import dotenv_values
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from api.middlewares.rate_limit import limiter
from api.utils.firebase_admin import ensure_firebase_auth_admin, get_firebase_auth_app

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Health"])
NO_STORE_HEADERS = {"Cache-Control": "no-store"}
REVIEWER_UID_KEY = "REVIEWER_UID"
REVIEWER_VAULT_PASSPHRASE_KEY = "REVIEWER_VAULT_PASSPHRASE"  # noqa: S105
# Second non-production fixture for two-person proofs. No deprecated aliases.
REVIEWER_COUNTERPART_UID_KEY = "REVIEWER_COUNTERPART_UID"
REVIEWER_COUNTERPART_VAULT_PASSPHRASE_KEY = "REVIEWER_COUNTERPART_VAULT_PASSPHRASE"  # noqa: S105
DEPRECATED_REVIEWER_UID_KEYS = ("UAT_SMOKE_USER_ID", "KAI_TEST_USER_ID")
DEPRECATED_REVIEWER_PASSPHRASE_KEYS = (  # noqa: S105
    "UAT_SMOKE_PASSPHRASE",
    "KAI_TEST_PASSPHRASE",
)


def _env_truthy(name: str, fallback: str = "false") -> bool:
    raw = str(os.getenv(name, fallback)).strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _is_app_review_mode_enabled() -> bool:
    return _env_truthy("APP_REVIEW_MODE")


def _runtime_profile() -> str:
    return str(os.getenv("APP_RUNTIME_PROFILE", "")).strip().lower()


def _is_production_runtime() -> bool:
    environment = str(os.getenv("ENVIRONMENT", "")).strip().lower()
    return _runtime_profile() == "production" or environment == "production"


def _first_env(*keys: str) -> str:
    for key in keys:
        value = str(os.getenv(key, "")).strip()
        if value:
            return value
    if not _is_production_runtime():
        try:
            env_local = Path(__file__).resolve().parents[2] / ".env.local"
            if env_local.is_file():
                vals = dotenv_values(str(env_local))
                for key in keys:
                    val = str(vals.get(key, "")).strip()
                    if val:
                        return val
        except Exception:
            pass
    return ""


def _resolve_reviewer_uid() -> str:
    # The local reviewer-mode script writes the canonical UID to this ignored
    # overlay. Runtime dotenv loading uses override=False, so an older .env
    # value can otherwise mint the wrong Firebase subject despite preflight.
    # Never prefer the overlay in production or outside explicit review mode.
    return _review_mode_overlay_uid() or _first_env(REVIEWER_UID_KEY, *DEPRECATED_REVIEWER_UID_KEYS)


def _review_mode_overlay_uid() -> str:
    if not _is_app_review_mode_enabled() or _is_production_runtime():
        return ""
    try:
        overlay = Path(__file__).resolve().parents[2] / ".env.local"
        values = dotenv_values(str(overlay)) if overlay.is_file() else {}
        if str(values.get("APP_REVIEW_MODE", "")).strip().lower() not in {"1", "true", "yes", "on"}:
            return ""
        return str(values.get(REVIEWER_UID_KEY, "")).strip()
    except Exception:
        return ""


def _resolve_reviewer_vault_passphrase() -> str:
    return _first_env(REVIEWER_VAULT_PASSPHRASE_KEY, *DEPRECATED_REVIEWER_PASSPHRASE_KEYS)


def _resolve_reviewer_counterpart_uid() -> str:
    return _first_env(REVIEWER_COUNTERPART_UID_KEY)


def _resolve_reviewer_counterpart_vault_passphrase() -> str:
    return _first_env(REVIEWER_COUNTERPART_VAULT_PASSPHRASE_KEY)


def _configured_reviewer_identities() -> tuple[tuple[str, str, str], ...]:
    """Every fully configured (uid, passphrase, subject) pair, primary first.

    A pair missing either half is skipped, so an unset counterpart leaves the
    primary-only behaviour unchanged. Values are never logged.
    """
    candidates = (
        (_resolve_reviewer_uid(), _resolve_reviewer_vault_passphrase(), "reviewer_smoke"),
        (
            _resolve_reviewer_counterpart_uid(),
            _resolve_reviewer_counterpart_vault_passphrase(),
            "reviewer_counterpart_smoke",
        ),
    )
    return tuple(pair for pair in candidates if pair[0] and pair[1])


def _match_reviewer_identity(
    provided_passphrase: str,
    identities: tuple[tuple[str, str, str], ...],
) -> tuple[str, str] | None:
    """Return ``(uid, subject)`` for the first pair whose passphrase matches.

    Compared as UTF-8 bytes: ``hmac.compare_digest`` raises on non-ASCII
    ``str`` input, which would turn a wrong passphrase into a 500.
    """
    provided = provided_passphrase.encode("utf-8")
    for configured_uid, configured_passphrase, subject in identities:
        if hmac.compare_digest(provided, configured_passphrase.encode("utf-8")):
            return configured_uid, subject
    return None


def _resolve_smoke_overlay_identity(smoke_passphrase: str | None) -> tuple[str, str] | None:
    provided_passphrase = str(smoke_passphrase or "").strip()
    if _is_production_runtime():
        return None
    if not provided_passphrase:
        return None
    return _match_reviewer_identity(provided_passphrase, _configured_reviewer_identities())


def _select_review_mode_identity(
    smoke_passphrase: str | None,
    requested_uid: str | None = None,
) -> tuple[str, str]:
    """Pick the identity a review-mode session mints.

    Returns ``(uid, subject)``. The primary reviewer is minted exactly as
    before this pair existed: for no passphrase (the App Store reviewer
    button), for production (where the bypass is ignored, as documented), for
    a backend holding no configured pair (the localhost overlay carries only
    APP_REVIEW_MODE and REVIEWER_UID), and for a passphrase that matches no
    pair. The counterpart pair only adds a second match: a passphrase equal to
    a configured pair's mints that pair's uid. In non-production, a requested_uid
    matching a configured reviewer pair mints that pair directly. Values are never logged.
    """
    primary = (_resolve_reviewer_uid(), "reviewer")
    configured = _configured_reviewer_identities()
    if requested_uid and not _is_production_runtime():
        clean_requested = str(requested_uid).strip()
        for candidate_uid, _, subject in configured:
            if candidate_uid == clean_requested:
                return candidate_uid, subject
    provided_passphrase = str(smoke_passphrase or "").strip()
    if not provided_passphrase or _is_production_runtime():
        return primary
    matched = _match_reviewer_identity(provided_passphrase, configured)
    return matched or primary


def _one_runtime_dependency_evidence() -> dict[str, str | bool | None]:
    """Expose dependency-only readiness without probing a model or credentials."""
    from hushh_mcp.runtime_readiness import runtime_dependency_evidence

    return runtime_dependency_evidence()


def _agent_roster() -> list[str]:
    """Report the runtime roster without importing the expensive ADK tree."""
    from hushh_mcp.runtime_settings import pod_mode, pod_turn_enabled

    if pod_mode():
        return ["one"] if pod_turn_enabled() else []
    return ["one", "kai", "nav"]


def _agent_model() -> dict[str, object]:
    roster = _agent_roster()
    return {
        "primary": "one" if "one" in roster else None,
        "specialists": [name for name in roster if name != "one"],
    }


@router.get("/")
def health_check():
    """Root health check."""
    return {"status": "ok", "service": "hushh-consent-protocol"}


@router.get("/health")
def health():
    """Detailed health check with the roster this process can actually serve."""
    return {
        "status": "healthy",
        "agents": _agent_roster(),
        "agent_model": _agent_model(),
        "one_runtime": _one_runtime_dependency_evidence(),
    }


#: Capabilities a screen can ask about before offering an action that needs one.
#: Deliberately short: this is the set the UI actually branches on, not every
#: provider the backend talks to.
_REPORTED_CAPABILITIES = ("vertex_ai", "voice", "maps")


@router.get("/health/capabilities")
def capability_health():
    """Per-capability availability for the app to degrade against.

    Served SEPARATELY from ``/health`` on purpose. That payload is asserted by
    whole-dict equality in its tests and read by scripts/env/doctor.sh, so
    adding fields there to carry this would break existing consumers for no
    benefit. The two answer different questions anyway: /health is "is this
    service up", this is "which features can it currently deliver".

    The body is safe to serve to a browser. It carries availability only -- no
    provider name, status code, project number or error text, because none of
    that belongs in front of a person.
    """
    from hushh_mcp.runtime_providers.capability_health import public_snapshot

    capabilities = public_snapshot(_REPORTED_CAPABILITIES)
    return {
        # The app itself is healthy whenever this endpoint answers at all. A
        # provider being down degrades capabilities, never the service.
        "app": "healthy",
        "capabilities": capabilities,
        "degraded": sorted(name for name, status in capabilities.items() if status != "available"),
    }


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
    - Enabled when APP_REVIEW_MODE is true, or (outside production) when the
      request carries a passphrase matching a configured reviewer pair
    - Mints only server-configured identities: REVIEWER_UID by default, or the
      pair (primary or REVIEWER_COUNTERPART_UID) whose passphrase matches
    - With review mode on, a passphrase matching no pair mints the primary,
      unchanged from before the counterpart pair existed
    - Never returns any reviewer passphrase to clients, and never logs one
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
        reviewer_uid, session_subject = _select_review_mode_identity(
            payload.get("smoke_passphrase"),
            requested_uid=payload.get("reviewer_uid"),
        )
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

    # ── Offline mode: skip Firebase Admin SDK, return local token ──
    query_params = dict(request.query_params)
    is_offline = str(query_params.get("local", "0")).strip() == "1"
    if is_offline:
        return JSONResponse(
            {
                "token": "offline-local-token",
                "offline": True,
                "reviewer_uid": reviewer_uid,
            },
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
        "app_review_mode.session_issued reviewer_uid_present=true subject=%s project_id=%s client_ip=%s",
        session_subject,
        project_id or "unknown",
        client_ip,
    )
    return JSONResponse({"token": token_str}, headers=NO_STORE_HEADERS)
