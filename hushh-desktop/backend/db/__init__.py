# db/__init__.py
"""
Database modules for Hushh consent protocol.

Provides modular access to:
- connection: Pool management (uses shared pooler method with DB_* env vars)
- consent: Consent event operations
- queries: Pending requests, active tokens, audit log

Connection Method:
    Uses Supabase session pooler with individual environment variables:
    - DB_USER, DB_PASSWORD, DB_HOST, DB_PORT, DB_NAME
"""

from .connection import close_pool, get_database_ssl, get_database_url, get_pool, hash_token
from .consent import insert_event
from .queries import (
    get_active_tokens,
    get_audit_log,
    get_pending_by_request_id,
    get_pending_requests,
    is_token_active,
)

__all__ = [
    # Connection
    "get_pool",
    "close_pool",
    "get_database_url",
    "get_database_ssl",
    "hash_token",
    # Consent events
    "insert_event",
    # Queries
    "get_pending_requests",
    "get_pending_by_request_id",
    "get_active_tokens",
    "is_token_active",
    "get_audit_log",
]
