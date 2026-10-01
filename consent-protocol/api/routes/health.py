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
from api.utils.firebase_auth import review_mint_developer_claims

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


def _authenticate_review_identity(
    smoke_passphrase: object,
    requested_uid: object = None,
) -> tuple[str, str] | None:
    """Return ``(uid, subject)`` only for a request that proves a reviewer pair.

    The credential is the configured vault passphrase of the identity being
    minted, which every legitimate caller (reviewer tooling, the native test
    bridge, deploy smoke) already holds from process env or the env resolver.
    A request naming a reviewer uid must match THAT configured pair and carry
    its passphrase. An unknown uid never falls back to another account, even
    when both accounts share a passphrase. A request naming no uid is matched
    on passphrase alone for older clients.
    No passphrase, or one matching no pair, returns None: there is no default
    identity any more. Values are never logged.
    """
    provided = str(smoke_passphrase or "").strip()
    if not provided or _is_production_runtime():
        return None
    configured = _configured_reviewer_identities()
    clean_requested = str(requested_uid or "").strip()
    candidates = (
        tuple(pair for pair in configured if pair[0] == clean_requested)
        if clean_requested
        else configured
    )
    return _match_reviewer_identity(provided, candidates)


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


def _app_review_mode_advertised() -> bool:
    """Whether the app may learn that review mode exists.

    Production never advertises it, even with APP_REVIEW_MODE set: the App
    Store reviewer signs in through the ordinary sign-in flow with a dedicated
    account, and the client must not be able to tell a reviewer apart from
    anyone else. Non-production lanes advertise it exactly as before.
    """
    return _is_app_review_mode_enabled() and not _is_production_runtime()


@router.get("/api/app-config/review-mode")
def app_review_mode_config():
    """Runtime app-review-mode config served from backend env (not frontend build env)."""
    return {"enabled": _app_review_mode_advertised()}


@router.post("/api/app-config/review-mode/session")
@limiter.limit("10/minute")
async def issue_app_review_mode_session(request: Request):
    """
    Mint a Firebase custom token for app-review login.

    Security:
    - Never mints in production. Production refuses with the same response as
      a disabled lane, whatever APP_REVIEW_MODE says.
    - Outside production, requires proof of a configured reviewer pair: the
      request's ``smoke_passphrase`` must equal that pair's vault passphrase,
      compared in constant time. A bare request, or a wrong passphrase, gets
      403 whatever APP_REVIEW_MODE says; the flag only advertises the button.
    - Rate-limited (10/minute per key) like before.
    - Mints only server-configured identities (REVIEWER_UID or
      REVIEWER_COUNTERPART_UID), stamped with the hushh_review_mint lane claim
      so no other lane accepts the session.
    - Never returns any reviewer passphrase to clients, and never logs one
    """
    if _is_production_runtime():
        logger.warning("app_review_mode.session_refused reason=production_runtime")
        raise HTTPException(
            status_code=403,
            detail="App review mode is disabled",
            headers=NO_STORE_HEADERS,
        )

    try:
        payload = await request.json()
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    identity = _authenticate_review_identity(
        payload.get("smoke_passphrase"),
        requested_uid=payload.get("reviewer_uid"),
    )
    if identity is None:
        # Reasons are literal format text, not arguments: the process-wide log
        # redactor (mcp_modules/log_redaction.py) scrubs long underscored
        # argument values as if they were uids.
        if not str(payload.get("smoke_passphrase") or "").strip():
            logger.warning("app_review_mode.session_refused reason=credential_missing")
        elif not _configured_reviewer_identities():
            # Operator signal: this backend holds no reviewer passphrase in its
            # process env, so no request can succeed (see reviewer_mode.sh).
            logger.warning("app_review_mode.session_refused reason=credential_not_configured")
        else:
            logger.warning("app_review_mode.session_refused reason=credential_mismatch")
        raise HTTPException(
            status_code=403,
            detail="Review session credential required",
            headers=NO_STORE_HEADERS,
        )
    reviewer_uid, session_subject = identity

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

        # The claim confines the resulting session to this lane: every other
        # lane sharing the Firebase authority refuses it (api/utils/firebase_auth.py).
        custom_token = firebase_auth.create_custom_token(
            reviewer_uid,
            review_mint_developer_claims(),
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
        "app_review_mode.session_issued reviewer_uid_present=true subject=%s lane=%s "
        "project_id=%s client_ip=%s",
        session_subject,
        review_mint_developer_claims()["hushh_review_mint"],
        project_id or "unknown",
        client_ip,
    )
    return JSONResponse({"token": token_str}, headers=NO_STORE_HEADERS)
