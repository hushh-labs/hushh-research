# api/middlewares/rate_limit.py
"""
Rate Limiting Middleware for Hussh Consent Protocol

Implements safe rate limits for the 2-step consent flow:
1. Step 1 (consent_request): 10/min per user
2. Step 2 (consent_action): 20/min per user
3. Token validation: 60/min (higher for polling scenarios)
"""

import logging

from fastapi import Request
from slowapi import Limiter
from slowapi.util import get_remote_address

logger = logging.getLogger(__name__)


def get_rate_limit_key(request: Request) -> str:
    """
    Extract rate limit key from request.
    Uses user_id if authenticated, otherwise falls back to IP.
    """
    # Try to get user_id from request body or headers
    user_id = request.headers.get("X-User-ID")
    if user_id:
        return f"user:{user_id}"

    # Fallback to IP address
    return get_remote_address(request)


# Initialize limiter with custom key function
limiter = Limiter(key_func=get_rate_limit_key)


# Rate limit constants (per minute)
class RateLimits:
    """Safe rate limits for 2-step consent flow."""

    # Step 1: Request consent - conservative limit
    CONSENT_REQUEST = "10/minute"  # noqa: S105

    # Step 2: Approve/deny - slightly higher
    CONSENT_ACTION = "20/minute"  # noqa: S105

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
