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

from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

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

# Phase 7: World Model (Dynamic Domain Management)
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

# iAlphabets: A-Z stock trading game
from api.routes.ialphabets import router as ialphabets_router  # noqa: E402

app.include_router(ialphabets_router)
logger.info("ialphabets.routes_enabled")

logger.info(
    "🚀 Hushh Consent Protocol server initialized with modular routes - KAI V2 + PHASE 2 + WORLD MODEL ENABLED"
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
    if not _is_production():
        return

    if _is_app_review_mode_enabled():
        logger.warning("security.review_mode_enabled_in_production")
        logger.info("metric.review_mode_enabled environment=production value=1")

    if _env_truthy("DEVELOPER_API_ENABLED", "false"):
        logger.warning("security.developer_api_enabled_in_production")


@app.on_event("startup")
async def startup_market_insights_refresh():
    """Start background market cache refresh loop for public modules."""
    start_market_insights_background_refresh()


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

    uvicorn.run(app, host="0.0.0.0", port=8000)  # noqa: S104
