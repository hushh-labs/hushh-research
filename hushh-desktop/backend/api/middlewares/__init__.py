# api/middlewares/__init__.py
"""
Middleware modules for Hussh Consent Protocol API.

Available middlewares:
- rate_limit: Rate limiting for consent endpoints
- logging: Structured request logging
"""

from .observability import (
    configure_opentelemetry,
    get_request_id,
    get_request_trace_metadata,
    observability_middleware,
)
from .rate_limit import RateLimits, get_rate_limit_key, limiter

__all__ = [
    "limiter",
    "RateLimits",
    "get_rate_limit_key",
    "observability_middleware",
    "get_request_id",
    "get_request_trace_metadata",
    "configure_opentelemetry",
]
