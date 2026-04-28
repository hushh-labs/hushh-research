# api/middlewares/__init__.py
"""
Middleware modules for Hussh Consent Protocol API.

Available middlewares:
- rate_limit: Rate limiting for consent endpoints
- logging: Structured request logging
"""

from .observability import configure_opentelemetry, get_request_id, observability_middleware
from .rate_limit import get_rate_limit_key, limiter

__all__ = [
    "limiter",
    "get_rate_limit_key",
    "observability_middleware",
    "get_request_id",
    "configure_opentelemetry",
]
