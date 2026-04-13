# consent-protocol/server.py
"""
FastAPI Server for Hushh Consent Protocol Agents

Modular architecture with routes organized in api/routes/ directory.
Run with: uvicorn server:app --reload --port 8000
"""

import logging
import os
import time

from dotenv import load_dotenv

# Load .env file before any other imports that might depend on it
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"), override=True)

from fastapi import FastAPI, HTTPException, Request  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import JSONResponse, RedirectResponse  # noqa: E402

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def _env_truthy(name: str, fallback: str = "false") -> bool:
    raw = str(os.getenv(name, fallback)).strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _environment() -> str:
    return str(os.getenv("ENVIRONMENT", "development")).strip().lower()


def _is_production() -> bool:
    return _environment() == "production"


def _require_database_on_startup() -> bool:
    explicit = os.getenv("REQUIRE_DATABASE_ON_STARTUP")
    if explicit is not None:
        return _env_truthy("REQUIRE_DATABASE_ON_STARTUP")
    return _is_production()


REQUIRED_RUNTIME_TABLES = (
    "vault_keys",
    "vault_key_wrappers",
    "consent_audit",
    "user_push_tokens",
    "internal_access_events",
    "runtime_persona_state",
    "ria_pick_uploads",
    "ria_pick_upload_rows",
)


def _is_app_review_mode_enabled() -> bool:
    return _env_truthy("APP_REVIEW_MODE") or _env_truthy("HUSHH_APP_REVIEW_MODE")


def _parse_cors_allowed_origins() -> list[str]:
    explicit = str(os.getenv("CORS_ALLOWED_ORIGINS", "")).strip()
    origins = [item.strip() for item in explicit.split(",") if item.strip()]

    frontend_url = str(os.getenv("FRONTEND_URL", "")).strip()
    if frontend_url and frontend_url not in origins:
        origins.append(frontend_url)

    if origins:
        return origins

    if _is_production():
        return []

    return [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://10.0.0.177:3000",
    ]


# Import route modules
# Import rate limiting
from slowapi import _rate_limit_exceeded_handler  # noqa: E402
from slowapi.errors import RateLimitExceeded  # noqa: E402

from api.middlewares.observability import (  # noqa: E402
    configure_opentelemetry,
    observability_middleware,
)
from api.middlewares.rate_limit import limiter  # noqa: E402
from api.routes import (  # noqa: E402
    account,
    agents,
    consent,
    db_proxy,
    debug_firebase,
    developer,
    health,
    notifications,
    session,
    sse,
)
from db.connection import DatabaseUnavailableError  # noqa: E402
from db.db_client import DatabaseExecutionError  # noqa: E402

# Dynamic root_path for Swagger docs in production
# Set ROOT_PATH env var to your production URL to fix Swagger showing localhost
root_path = os.environ.get("ROOT_PATH", "")

app = FastAPI(
    title="Hushh Consent Protocol API - DIAGNOSTICS",
    description="Agent endpoints for the Hushh Personal Data Agent system",
    version="1.0.0",
    root_path=root_path,
)

app.middleware("http")(observability_middleware)

# Rate limiting
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)  # type: ignore[arg-type]


def _database_error_payload(
    *,
    status_code: int,
    code: str,
    hint: str | None = None,
) -> dict[str, str]:
    payload = {
        "error": "Database is temporarily unavailable."
        if status_code == 503
        else "Database request failed.",
        "code": code,
    }
    if hint:
        payload["hint"] = hint
    return payload


@app.exception_handler(DatabaseUnavailableError)
async def database_unavailable_exception_handler(_request: Request, exc: DatabaseUnavailableError):
    return JSONResponse(
        status_code=exc.status_code,
        content=_database_error_payload(
            status_code=exc.status_code,
            code=exc.code,
            hint=exc.hint,
        ),
    )


@app.exception_handler(DatabaseExecutionError)
async def database_execution_exception_handler(_request: Request, exc: DatabaseExecutionError):
    status_code = getattr(exc, "status_code", 500)
    return JSONResponse(
        status_code=status_code,
        content=_database_error_payload(
            status_code=status_code,
            code=getattr(exc, "code", "DATABASE_EXECUTION_ERROR"),
            hint=getattr(exc, "hint", None),
        ),
    )


# CORS allowlist: explicit origins only (no wildcard regex).
cors_origins = _parse_cors_allowed_origins()
logger.info("cors.allowed_origins_count=%s", len(cors_origins))
if _is_production() and not cors_origins:
    logger.warning("cors.no_allowed_origins_configured_in_production")

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

configure_opentelemetry(app)

from mcp_remote import remote_mcp_app, shutdown_remote_mcp, startup_remote_mcp  # noqa: E402


def _mcp_root_redirect_target(request: Request) -> str:
    query_string = request.scope.get("query_string", b"")
    if isinstance(query_string, bytes) and query_string:
        return f"/mcp/?{query_string.decode('utf-8')}"
    return "/mcp/"


@app.middleware("http")
async def normalize_mcp_root(request: Request, call_next):
    # Keep the redirect relative so Cloud Run preserves the original https scheme.
    if request.url.path == "/mcp":
        return RedirectResponse(url=_mcp_root_redirect_target(request), status_code=307)
    return await call_next(request)


app.mount("/mcp", remote_mcp_app)


# ============================================================================
# REGISTER ROUTERS
# ============================================================================

# Health check routes (/, /health)
app.include_router(health.router)

# Agent chat routes (/api/agents/...)
app.include_router(agents.router)

# Consent management routes (/api/consent/...)
app.include_router(consent.router)

# Session token routes (/api/consent/issue-token, /api/user/lookup, etc.)
app.include_router(session.router)

# Developer API routes (/api/v1/*)
app.include_router(developer.router)

# Database proxy routes (/db/vault/...) - for iOS native app
app.include_router(db_proxy.router)

# SSE routes for real-time consent notifications (/api/consent/events/...)
app.include_router(sse.router)

# Push notification token registration (/api/notifications/register)
app.include_router(notifications.router)

# Dev-only debug routes (/api/_debug/...)
if not _is_production():
    app.include_router(debug_firebase.router)
else:
    logger.info("debug.routes_disabled environment=production")

# Kai investor analysis routes (/api/kai/...) - NEW MODULAR STRUCTURE
# This imports the combined router from the kai package which includes:
# - health, consent, analyze, stream, decisions, preferences
from api.routes.kai import router as kai_router  # noqa: E402
from api.routes.kai.market_insights import (  # noqa: E402
    start_market_insights_background_refresh,
)
from hushh_mcp.services.email_delivery_queue_service import (  # noqa: E402
    shutdown_email_delivery_queue_service,
)
from hushh_mcp.services.gmail_receipts_service import (  # noqa: E402
    shutdown_gmail_receipts_background_sync,
    start_gmail_receipts_background_sync,
)

app.include_router(kai_router)

# Phase 2: Investor Profiles (Public Discovery Layer)
from api.routes import investors  # noqa: E402

app.include_router(investors.router)

# Public tickers search
from api.routes import tickers  # noqa: E402

app.include_router(tickers.router)

# Identity compatibility routes
from api.routes import identity  # noqa: E402

app.include_router(identity.router)

# Phase 7: Personal Knowledge Model (Dynamic Domain Management)
from api.routes import pkm, pkm_routes_shared  # noqa: E402

app.include_router(pkm.router)
app.include_router(pkm_routes_shared.router)

# Legacy world-model compatibility routes mapped to PKM.
from api.routes import world_model  # noqa: E402

app.include_router(world_model.router)

# Account deletion and management
app.include_router(account.router)

from api.routes import iam, invites, marketplace, ria  # noqa: E402

app.include_router(iam.router)
app.include_router(ria.router)
app.include_router(marketplace.router)
app.include_router(invites.router)
logger.info("ria.routes_enabled")

logger.info(
    "🚀 Hushh Consent Protocol server initialized with modular routes - KAI V2 + PHASE 2 + PKM ENABLED"
)


# ============================================================================
# CONSENT NOTIFY LISTENER (event-driven SSE + push)
# ============================================================================


@app.on_event("startup")
async def startup_consent_listener():
    """Start background task that LISTENs to consent_audit_new (NOTIFY)."""
    import asyncio

    from api.consent_listener import run_consent_listener

    asyncio.create_task(run_consent_listener())


@app.on_event("startup")
async def startup_ticker_cache():
    """Preload SEC tickers into an in-memory cache on server startup.

    This avoids a DB roundtrip for each keystroke in the frontend ticker search.
    """
    try:
        from hushh_mcp.services.ticker_cache import ticker_cache

        ticker_cache.load_from_db()
    except Exception as e:
        logger.warning("[startup] Ticker cache preload failed (routes will fall back to DB): %s", e)


@app.on_event("startup")
async def startup_regulated_runtime_guards():
    """Emit explicit startup security warnings for risky production flags."""
    from hushh_mcp.services.ria_verification import (
        validate_regulated_runtime_configuration,
    )

    validate_regulated_runtime_configuration()

    if not _is_production():
        return

    if _is_app_review_mode_enabled():
        logger.warning("security.review_mode_enabled_in_production")
        logger.info("metric.review_mode_enabled environment=production value=1")

    if _env_truthy("DEVELOPER_API_ENABLED", "false"):
        logger.warning("security.developer_api_enabled_in_production")


@app.on_event("startup")
async def startup_required_schema_guard():
    """Fail fast when the runtime database is missing core contract tables."""
    from db.connection import get_pool

    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT table_name
                FROM information_schema.tables
                WHERE table_schema = 'public'
                  AND table_name = ANY($1::text[])
                """,
                list(REQUIRED_RUNTIME_TABLES),
            )
    except Exception as exc:
        if _require_database_on_startup():
            logger.critical(
                "startup.required_schema_guard_db_unavailable environment=%s reason=%s",
                _environment(),
                exc,
            )
            raise
        logger.warning(
            "startup.required_schema_guard_skipped environment=%s reason=%s",
            _environment(),
            exc,
        )
        return

    existing = {row["table_name"] for row in rows}
    missing = [table for table in REQUIRED_RUNTIME_TABLES if table not in existing]
    if missing:
        logger.critical("startup.required_schema_guard_failed missing=%s", missing)
        raise RuntimeError(
            "Required runtime tables are missing: "
            + ", ".join(missing)
            + ". Run `python db/migrate.py --consent`, `python db/migrate.py --iam`, "
            + "or `python db/migrate.py --init` against the active database before starting the server."
        )


@app.on_event("startup")
async def startup_remote_mcp_transport():
    """Start the hosted remote MCP session manager."""
    await startup_remote_mcp()


@app.on_event("shutdown")
async def shutdown_remote_mcp_transport():
    """Stop the hosted remote MCP session manager."""
    await shutdown_remote_mcp()


@app.on_event("startup")
async def startup_market_insights_refresh():
    """Start background market cache refresh loop for public modules."""
    start_market_insights_background_refresh()


@app.on_event("startup")
async def startup_gmail_receipts_sync():
    """Start Gmail catch-up/watch renewal loop for configured runtimes."""
    start_gmail_receipts_background_sync()


@app.on_event("shutdown")
async def shutdown_gmail_receipts_sync():
    """Stop Gmail catch-up/watch renewal loop."""
    await shutdown_gmail_receipts_background_sync()


@app.on_event("shutdown")
async def shutdown_email_delivery_queue():
    """Stop queued outbound email worker tasks."""
    await shutdown_email_delivery_queue_service()


# ============================================================================
# RUN
# ============================================================================


def _require_debug_access() -> None:
    if _is_production():
        raise HTTPException(status_code=404, detail="Not found")


@app.get("/debug/diagnostics", tags=["Debug"])
async def diagnostics():
    """List all registered routes to debug 404s."""
    _require_debug_access()
    routes = []
    for route in app.routes:
        if hasattr(route, "path"):
            routes.append(
                {
                    "path": route.path,
                    "name": route.name,
                    "methods": list(route.methods) if route.methods else [],
                }
            )

    return {
        "status": "ok",
        "timestamp": time.time(),
        "routes_count": len(routes),
        "routes": sorted(routes, key=lambda x: x["path"]),
    }


@app.get("/debug/consent-listener", tags=["Debug"])
async def debug_consent_listener():
    """Consent NOTIFY listener status: listener_active, queue_count, notify_received_count.
    Use to confirm the listener is running and that NOTIFY is being received."""
    _require_debug_access()
    from api.consent_listener import get_consent_listener_status

    return get_consent_listener_status()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000, access_log=False)  # noqa: S104
