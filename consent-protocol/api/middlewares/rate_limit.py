# api/middlewares/rate_limit.py
"""
Rate Limiting Middleware for Hussh Consent Protocol

Implements safe rate limits for the 2-step consent flow:
1. Step 1 (consent_request): 10/min per user
2. Step 2 (consent_action): 20/min per user
3. Token validation: 60/min (higher for polling scenarios)

SCALE SEAM (Agent Architecture Doctrine, AGENTS.md): with no
RATE_LIMIT_STORAGE_URI configured, slowapi uses in-memory storage, so the
effective limit multiplies by gunicorn workers x Cloud Run instances
(2 workers x N instances today). The documented upgrade path is a shared
backend via RATE_LIMIT_STORAGE_URI (e.g. redis://... on Memorystore); the
limits library consumes that URI directly, so the swap is config-only.
Postgres is NOT a supported limits backend, which is why this seam jumps
straight to Redis when cross-instance precision becomes a requirement.
"""

import logging
import os

from fastapi import Request
from slowapi import Limiter
from slowapi.util import get_remote_address

from hushh_mcp.consent.token import validate_token

logger = logging.getLogger(__name__)


def get_rate_limit_key(request: Request) -> str:
    """
    Extract rate limit key from request.

    Reads the user_id decoded by ``observability_middleware`` from
    ``request.state.rate_limit_user_id`` on the normal request path, avoiding
    a second JWT decode. If a caller reaches this function without middleware
    state, validate the bearer token here so authenticated traffic still gets
    the signed user bucket instead of silently falling back to the IP bucket.
    """
    state = getattr(request, "state", None)
    user_id = getattr(state, "rate_limit_user_id", None)
    if user_id:
        return f"user:{user_id}"

    authorization = request.headers.get("Authorization") or request.headers.get("authorization")
    if authorization and authorization.startswith("Bearer "):
        consent_token = authorization.removeprefix("Bearer ").strip()
        if consent_token:
            valid, _reason, payload = validate_token(consent_token)
            if valid and payload and payload.user_id:
                return f"user:{payload.user_id}"

    return get_remote_address(request)


# Rate limiting is enabled by default but disabled under the pytest harness so
# deterministic route tests are not throttled by shared per-key buckets. Real
# environments never set TESTING, so production/UAT keep enforcement on.
_rate_limit_enabled = os.getenv("TESTING", "").strip().lower() not in {"1", "true", "yes"}

# Initialize limiter with custom key function. Storage is per-process memory
# unless RATE_LIMIT_STORAGE_URI points at a shared backend (see module note).
_storage_uri = os.getenv("RATE_LIMIT_STORAGE_URI", "").strip()
if _storage_uri:
    limiter = Limiter(
        key_func=get_rate_limit_key,
        storage_uri=_storage_uri,
        enabled=_rate_limit_enabled,
    )
    logger.info("rate_limit.shared_storage_enabled")
else:
    limiter = Limiter(key_func=get_rate_limit_key, enabled=_rate_limit_enabled)


# Rate limit constants (per minute)
class RateLimits:
    """Safe rate limits for 2-step consent flow."""

    # Step 1: Request consent - conservative limit
    CONSENT_REQUEST = "10/minute"  # noqa: S105

    # Step 2: Approve/deny - slightly higher
    CONSENT_ACTION = "20/minute"  # noqa: S105

    # Scope discovery/search - cheap, higher-frequency read. Given its own bucket
    # so search traffic cannot starve the CONSENT_REQUEST budget. Shares the same
    # RATE_LIMIT_STORAGE_URI seam (Redis-later; in-memory per process when unset).
    SEARCH_SCOPES = "60/minute"  # noqa: S105

    # Token validation - higher for polling (soon replaced by SSE)
    TOKEN_VALIDATION = "60/minute"  # noqa: S105

    # Agent chat - moderate limit
    AGENT_CHAT = "30/minute"  # noqa: S105

    # Global fallback per IP
    GLOBAL_PER_IP = "100/minute"  # noqa: S105


def log_rate_limit_hit(request: Request, limit: str):
    """Log when rate limit is exceeded."""
    key = get_rate_limit_key(request)
    logger.warning(
        "Rate limit exceeded",
        extra={
            "key": key,
            "limit": limit,
            "path": request.url.path,
            "event_type": "rate_limit_exceeded",
        },
    )
