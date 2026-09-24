# api/routes/health.py
"""
Health check endpoints.
"""

import asyncio
import hmac
import logging
import os
from pathlib import Path

from dotenv import dotenv_values
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from api.middlewares.rate_limit import limiter
from api.utils.firebase_admin import ensure_firebase_auth_admin, get_firebase_auth_app
from db.connection import get_pool

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
    return _first_env(REVIEWER_UID_KEY, *DEPRECATED_REVIEWER_UID_KEYS)


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
    """Select a configured identity; a client UID never grants that identity.

    The no-passphrase reviewer button and unmatched-passphrase fallback retain
    the primary identity. A counterpart needs its configured passphrase. When
    the client supplies an expected UID, reject a mismatch instead of silently
    signing it into a different account.
    """
    primary = (_resolve_reviewer_uid(), "reviewer")
    provided_passphrase = str(smoke_passphrase or "").strip()
    matched = (
        _match_reviewer_identity(provided_passphrase, _configured_reviewer_identities())
        if provided_passphrase and not _is_production_runtime()
        else None
    )
    selected = matched or primary
    if requested_uid is not None and str(requested_uid).strip() != selected[0]:
        raise HTTPException(
            status_code=403,
            detail="Reviewer identity mismatch",
            headers=NO_STORE_HEADERS,
        )
    return selected


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


# ── Pod-fleet signal (optional; off unless POD_FLEET_HEALTH_SIGNAL_ENABLED) ──
# Terminal statuses meaning the fleet gave up standing a pod up. NOTHING writes
# ``provisioning_failed`` yet: it is declared ahead of its writer in the read-side
# status map in api/routes/one/personal_agent.py, and
# hushh_mcp/services/personal_agent_provisioning_service.py still only ever writes
# pending / provisioning / provisioned. So on its own this set would count zero
# forever -- a check that reports green because it measures nothing. It is listed
# anyway to match that declared contract (the reconcile sweep already treats it as
# a stalled status), so the write side lands without a second edit here.
POD_FLEET_FAILED_STATUSES = ("provisioning_failed",)

# The failure signature that is real TODAY: a row left wedged in ``provisioning``.
# ``provision()`` records that status before minting the standing read and re-raises
# on failure without clearing it, so a stalled provision is visible as an old
# ``provisioning`` row. Caveat, stated where it lives rather than in a runbook:
# personal_agent_registry.updated_at has no ON UPDATE trigger and
# personal_agent_registry_repo.py never sets it, so it is effectively the row's
# creation time -- meaning a RE-provision of an old row looks wedged for the few
# seconds it is in flight. Accepted, because this signal is reported, never gating.
POD_FLEET_STALE_PROVISIONING_SECONDS = 900

POD_FLEET_FAILED_COUNT_SQL = """
SELECT count(*)
  FROM personal_agent_registry
 WHERE status = ANY($1::text[])
    OR (status = 'provisioning'
        AND updated_at < now() - make_interval(secs => $2::double precision))
"""


async def _pod_fleet_check() -> str | None:
    """Count pods the fleet failed to stand up. ``None`` when the signal is off.

    FAIL-SAFE by construction. Every failure mode -- signal off, missing table
    (``personal_agent_registry`` ships as a dev-only parked migration and does not
    exist in UAT or production), slow query, unavailable pool -- resolves to a
    reported string or ``None``, never to ``ready = False``. A broken fleet check is
    not a broken service.

    That is also why a breached threshold reports ``degraded`` instead of gating:
    the pods are separate hosts, so a fleet-wide pod outage that pulled every
    control-plane instance out of rotation at once would convert a partial failure
    into a total one (AGENTS.md: a component's failure degrades the system rather
    than breaking it). The caller records this result and leaves ``ready`` alone.

    Cost when enabled: one extra pool acquisition and one bounded (<=2s) count
    query per readiness probe. That budget is the reason the signal ships dark.
    """
    # Deferred import, matching _one_runtime_dependency_evidence above: the probe
    # pulls in no personal-agent settings surface until this is actually called.
    from hushh_mcp.runtime_settings import (
        pod_fleet_failed_threshold,
        pod_fleet_health_signal_enabled,
    )

    if not pod_fleet_health_signal_enabled():
        return None

    try:
        pool = await asyncio.wait_for(get_pool(), timeout=2.0)
        async with pool.acquire() as conn:
            raw = await asyncio.wait_for(
                conn.fetchval(
                    POD_FLEET_FAILED_COUNT_SQL,
                    list(POD_FLEET_FAILED_STATUSES),
                    float(POD_FLEET_STALE_PROVISIONING_SECONDS),
                ),
                timeout=2.0,
            )
        failed = int(raw or 0)
    except Exception as exc:
        # Includes UndefinedTableError wherever the parked migration is unapplied.
        logger.warning("health_ready.pod_fleet_unavailable error=%s", type(exc).__name__)
        return "unknown"

    threshold = pod_fleet_failed_threshold()
    if failed > threshold:
        logger.warning("health_ready.pod_fleet_degraded failed=%s threshold=%s", failed, threshold)
        return "degraded"
    return "ok"


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


@router.get("/health/ready")
async def health_ready(request: Request):
    """Readiness probe: checks real dependencies; 503 if the service can't serve.

    Wire this (not ``/health``) as the deploy/load-balancer readiness gate so a
    DB-down instance is pulled from rotation instead of accepting traffic it
    cannot honor. The shared runtime gates on its DB and, in production, Firebase
    Admin. A private pod reports process readiness without hub dependencies.
    The optional pod-fleet signal is reported for the shared runtime but does
    not gate readiness (see :func:`_pod_fleet_check`); it is absent unless
    ``POD_FLEET_HEALTH_SIGNAL_ENABLED`` is on.
    """
    # A private pod has no database credential or fleet registry. Its deploy
    # liveness probe is /health; this endpoint reports process readiness only.
    # Do not turn the hub's database dependency into a pod outage.
    if getattr(request.app.state, "runtime_topology", None) == "private_pod":
        return JSONResponse(
            {"status": "ready", "checks": {"pod_process": "ok"}},
            headers=NO_STORE_HEADERS,
        )

    checks: dict[str, str] = {}
    ready = True

    # Database: a short-timeout SELECT 1 through the shared pool.
    try:
        pool = await asyncio.wait_for(get_pool(), timeout=2.0)
        async with pool.acquire() as conn:
            await asyncio.wait_for(conn.fetchval("SELECT 1"), timeout=2.0)
        checks["database"] = "ok"
    except Exception as exc:
        ready = False
        checks["database"] = "unavailable"
        logger.warning("health_ready.database_unavailable error=%s", type(exc).__name__)

    # Firebase Admin: cached "configured" check (no network round-trip).
    try:
        configured, _ = ensure_firebase_auth_admin()
        if configured:
            checks["firebase_admin"] = "ok"
        else:
            checks["firebase_admin"] = "not_configured"
            if _is_production_runtime():
                ready = False
    except Exception as exc:
        checks["firebase_admin"] = "error"
        if _is_production_runtime():
            ready = False
        logger.warning("health_ready.firebase_check_failed error=%s", type(exc).__name__)

    # Pod fleet: optional and OFF by default. When off this adds no key and issues
    # no query, so the body stays byte-identical to the pre-signal contract. When
    # on it only ever adds a key -- ``ready`` is deliberately never touched here.
    pod_fleet = await _pod_fleet_check()
    if pod_fleet is not None:
        checks["pod_fleet"] = pod_fleet

    body = {"status": "ready" if ready else "not_ready", "checks": checks}
    return JSONResponse(
        body,
        status_code=200 if ready else 503,
        headers=NO_STORE_HEADERS,
    )


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
