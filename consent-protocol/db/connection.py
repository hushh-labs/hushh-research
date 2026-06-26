# db/connection.py
"""
Database connection pool management.

This module provides a direct PostgreSQL connection pool via asyncpg to
Google Cloud SQL (Postgres). Supabase has been removed; Cloud SQL is the
only runtime datastore.

Connectivity:
    - Local/dev: connect over the Cloud SQL Auth Proxy, which binds a local
      TCP port (DB_HOST=127.0.0.1, DB_PORT=CLOUDSQL_PROXY_PORT). Start it via
      `./bin/hushh terminal backend --mode local --reload` or
      `bash scripts/runtime/run_backend_local.sh local --reload`.
    - Cloud Run/prod: connect over the Cloud SQL Unix socket
      (DB_UNIX_SOCKET=/cloudsql/<project:region:instance>).

Usage:
    from db.connection import get_pool

    async def my_function():
        pool = await get_pool()
        result = await pool.fetch("SELECT * FROM users")

Connection Method:
    Uses individual DB_* environment variables (single source of truth; no
    DATABASE_URL):
    - DB_USER: Cloud SQL database user (e.g., hushh_uat_app)
    - DB_PASSWORD: Database password
    - DB_HOST: Cloud SQL Auth Proxy host (typically 127.0.0.1 in local/dev)
    - DB_PORT: Cloud SQL Auth Proxy port (e.g., 6543; default 5432)
    - DB_UNIX_SOCKET: Cloud SQL Unix socket path for Cloud Run
      (/cloudsql/<project:region:instance>); mutually exclusive with DB_HOST
    - DB_NAME: Database name (default postgres)
    - CLOUDSQL_INSTANCE_CONNECTION_NAME: <project:region:instance> for the proxy
    - CLOUDSQL_PROXY_PORT: Local port the proxy binds (mirrors DB_PORT)
"""

import asyncio
import hashlib
import logging
import os
from typing import Optional
from urllib.parse import quote_plus

import asyncpg
from dotenv import load_dotenv

from hushh_mcp.runtime_settings import hydrate_runtime_environment

load_dotenv()
hydrate_runtime_environment()

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Offline mode helpers — imported from db.offline_db
# ---------------------------------------------------------------------------
def _is_offline_mode() -> bool:
    """Return True when running in air-gapped offline mode."""
    return str(os.getenv("DB_OFFLINE", "0")).strip().lower() in ("1", "true", "yes", "on")


async def _get_offline_pool():
    """Lazy-import and return the offline SQLite-backed pool (awaited)."""
    from db.offline_db import get_offline_pool as _goop

    return await _goop()


_DB_CONNECTION_ERROR_PATTERNS = (
    "connection refused",
    "server closed the connection unexpectedly",
    "could not connect to server",
    "connection reset by peer",
    "terminating connection due to administrator command",
    "connection not open",
    "timeout",
    "timed out",
    "ssl syscall error: eof detected",
)

# Database connection pool (singleton) and its init lock.
# The lock ensures only one coroutine runs the create_pool() call even when
# multiple requests arrive before the pool is ready.
_pool: Optional[asyncpg.Pool] = None
_pool_lock: asyncio.Lock | None = None


def _get_pool_lock() -> asyncio.Lock:
    """Return the per-event-loop pool init lock, creating it on first call."""
    global _pool_lock
    if _pool_lock is None:
        _pool_lock = asyncio.Lock()
    return _pool_lock


class DatabaseUnavailableError(RuntimeError):
    """Raised when the runtime database is temporarily unreachable."""

    def __init__(self, message: str, *, hint: str | None = None):
        self.message = message
        self.hint = hint
        self.code = "DATABASE_UNAVAILABLE"
        self.status_code = 503
        super().__init__(message)


def _is_connection_unavailable_error(exc: BaseException) -> bool:
    current: BaseException | None = exc
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, (ConnectionError, OSError, TimeoutError)):
            return True
        message = str(current).strip().lower()
        if message and any(pattern in message for pattern in _DB_CONNECTION_ERROR_PATTERNS):
            return True
        current = current.__cause__ or current.__context__
    return False


def local_database_unavailable_hint() -> str | None:
    environment = str(os.getenv("ENVIRONMENT", "development")).strip().lower()
    db_host = str(os.getenv("DB_HOST", "")).strip().lower()
    instance = str(os.getenv("CLOUDSQL_INSTANCE_CONNECTION_NAME", "")).strip()
    proxy_port = str(os.getenv("CLOUDSQL_PROXY_PORT") or os.getenv("DB_PORT") or "5432").strip()
    if environment == "production":
        return None
    if db_host not in {"127.0.0.1", "localhost"} or not instance:
        return None
    return (
        "Local backend database tunnel is unavailable. Start the backend with "
        "`./bin/hushh terminal backend --mode local --reload` or "
        f"`bash scripts/runtime/run_backend_local.sh local --reload` so the Cloud SQL proxy "
        f"binds `127.0.0.1:{proxy_port}`."
    )


def format_database_unavailable_details(details: str) -> str:
    hint = local_database_unavailable_hint()
    normalized = str(details).strip()
    if not hint:
        return normalized
    if hint in normalized:
        return normalized
    suffix = f" Hint: {hint}"
    return f"{normalized}{suffix}" if normalized else hint


def _get_connect_timeout_seconds() -> float:
    raw = os.getenv("DB_CONNECT_TIMEOUT_SECONDS", "10").strip()
    try:
        value = float(raw)
    except ValueError:
        logger.warning(
            "Invalid float for DB_CONNECT_TIMEOUT_SECONDS=%r; using default 10.0",
            raw,
        )
        return 10.0
    if value <= 0:
        logger.warning(
            "Out-of-range DB_CONNECT_TIMEOUT_SECONDS=%r; expected > 0. Using default 10.0",
            raw,
        )
        return 10.0
    return value


def _get_pool_int(env_name: str, default: int, *, minimum: int) -> int:
    """Read a positive integer pool-sizing env var with a safe fallback."""
    raw = os.getenv(env_name, str(default)).strip()
    try:
        value = int(raw)
    except ValueError:
        logger.warning("Invalid int for %s=%r; using default %d", env_name, raw, default)
        return default
    if value < minimum:
        logger.warning(
            "Out-of-range %s=%r; expected >= %d. Using default %d",
            env_name,
            raw,
            minimum,
            default,
        )
        return default
    return value


def get_database_url() -> str:
    """
    Build database URL from DB_* environment variables (single source of truth).
    Used by runtime pool, migrations, and scripts. No DATABASE_URL.
    """
    db_user = os.getenv("DB_USER")
    db_password = os.getenv("DB_PASSWORD")
    db_host = os.getenv("DB_HOST")
    db_unix_socket = os.getenv("DB_UNIX_SOCKET")
    db_port = os.getenv("DB_PORT", "5432")
    db_name = os.getenv("DB_NAME", "postgres")
    if not db_user or not db_password or not (db_host or db_unix_socket):
        raise EnvironmentError(
            "Database credentials not set. Required: DB_USER, DB_PASSWORD, and one of DB_HOST/DB_UNIX_SOCKET. "
            "Optional: DB_PORT (default 5432), DB_NAME (default postgres). "
            "Set in .env from the Cloud SQL instance (project:region:instance); locally these point at "
            "the Cloud SQL Auth Proxy on 127.0.0.1:CLOUDSQL_PROXY_PORT."
        )
    if db_unix_socket:
        # Cloud SQL Unix socket path must be provided via query host parameter.
        return f"postgresql://{db_user}:{db_password}@/{db_name}?host={quote_plus(db_unix_socket)}"
    return f"postgresql://{db_user}:{db_password}@{db_host}:{db_port}/{db_name}"


def get_database_ssl():
    """Return ssl config for asyncpg.

    Cloud SQL is reached either over the Cloud SQL Auth Proxy (local TCP,
    already encrypted by the proxy) or over a Unix socket (Cloud Run); in both
    cases asyncpg needs no extra SSL config. An explicit DB_SSLMODE=require can
    still force TLS for any other remote host.
    """
    if os.getenv("DB_UNIX_SOCKET"):
        return None
    if str(os.getenv("DB_SSLMODE", "")).strip().lower() == "require":
        return "require"
    return None


def _get_database_url() -> str:
    """Internal alias for get_database_url (used by get_pool)."""
    return get_database_url()


async def get_pool() -> asyncpg.Pool:
    """Get or create the connection pool.

    Thread-safe via an asyncio.Lock: concurrent coroutines that arrive before
    the pool is ready all wait on the lock, then the first one creates the
    pool and the rest return the already-created instance.

    Returns:
        asyncpg.Pool: The database connection pool

    Raises:
        EnvironmentError: If database credentials are not configured
    """
    global _pool

    # ── Offline mode: return SQLite-backed pool instead of PostgreSQL ──
    if _is_offline_mode():
        if _pool is not None:
            return _pool
        _pool = await _get_offline_pool()
        return _pool

    if _pool is not None:
        return _pool

    async with _get_pool_lock():
        # Re-check inside the lock: another coroutine may have created the
        # pool while we were waiting.
        if _pool is not None:
            return _pool

        database_url = _get_database_url()
        ssl_config = get_database_ssl()
        connect_timeout_seconds = _get_connect_timeout_seconds()
        # Pool sizing is env-tunable. The previous fixed max_size=10 was easily
        # exhausted when a few slow endpoints held connections, causing other
        # requests to block on acquire() until they hit the connect timeout and
        # 500'd. A larger ceiling plus a warm floor removes that cliff.
        pool_min_size = _get_pool_int("DB_POOL_MIN_SIZE", 2, minimum=0)
        pool_max_size = _get_pool_int("DB_POOL_MAX_SIZE", 20, minimum=1)
        if pool_max_size < pool_min_size:
            pool_max_size = pool_min_size
        db_host = os.getenv("DB_HOST", "")
        db_unix_socket = os.getenv("DB_UNIX_SOCKET", "")
        db_user = os.getenv("DB_USER", "")
        db_password = os.getenv("DB_PASSWORD", "")
        db_name = os.getenv("DB_NAME", "postgres")
        db_port = int(os.getenv("DB_PORT", "5432"))
        target = db_unix_socket or db_host
        logger.info(f"Connecting to PostgreSQL (Cloud SQL) at {target}...")
        if ssl_config:
            logger.info("SSL enabled for database connection")
        try:
            if db_unix_socket:
                _pool = await asyncpg.create_pool(
                    user=db_user,
                    password=db_password,
                    database=db_name,
                    host=db_unix_socket,
                    port=db_port,
                    min_size=pool_min_size,
                    max_size=pool_max_size,
                    timeout=connect_timeout_seconds,
                    command_timeout=60,
                    max_inactive_connection_lifetime=300,
                )
            else:
                _pool = await asyncpg.create_pool(
                    database_url,
                    min_size=pool_min_size,
                    max_size=pool_max_size,
                    timeout=connect_timeout_seconds,
                    command_timeout=60,
                    max_inactive_connection_lifetime=300,
                    ssl=ssl_config,
                )
        except Exception as exc:
            if _is_connection_unavailable_error(exc):
                raise DatabaseUnavailableError(
                    "Database is temporarily unavailable.",
                    hint=local_database_unavailable_hint(),
                ) from exc
            raise
        logger.info(
            f"PostgreSQL pool created: min={_pool.get_min_size()}, max={_pool.get_max_size()}"
        )
    return _pool


async def close_pool():
    """Close the connection pool."""
    global _pool
    if _pool:
        await _pool.close()
        _pool = None
        logger.info("PostgreSQL connection pool closed")


def hash_token(token: str) -> str:
    """SHA-256 hash of consent token for storage."""
    return hashlib.sha256(token.encode()).hexdigest()
