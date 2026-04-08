# db/connection.py
"""
Database connection pool management.

This module provides direct PostgreSQL connection via asyncpg using
Supabase's session pooler credentials.

Usage:
    from db.connection import get_pool

    async def my_function():
        pool = await get_pool()
        result = await pool.fetch("SELECT * FROM users")

Connection Method:
    Uses individual DB_* environment variables (shared pooler or Cloud SQL socket):
    - DB_USER: Supabase pooler username (e.g., postgres.project-ref)
    - DB_PASSWORD: Database password
    - DB_HOST: Pooler host (e.g., aws-1-us-east-1.pooler.supabase.com)
    - DB_UNIX_SOCKET: Optional Cloud SQL Unix socket path (/cloudsql/project:region:instance)
    - DB_PORT: Port (default 5432)
    - DB_NAME: Database name (default postgres)
"""

import hashlib
import logging
import os
from typing import Optional
from urllib.parse import quote_plus

import asyncpg
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

# Database connection pool (singleton)
_pool: Optional[asyncpg.Pool] = None


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
            "Set in .env; get from Supabase Dashboard → Project Settings → Database → Connection Pooling."
        )
    if db_unix_socket:
        # Cloud SQL Unix socket path must be provided via query host parameter.
        return f"postgresql://{db_user}:{db_password}@/{db_name}?host={quote_plus(db_unix_socket)}"
    return f"postgresql://{db_user}:{db_password}@{db_host}:{db_port}/{db_name}"


def get_database_ssl():
    """Return ssl config for asyncpg when using Supabase pooler."""
    if os.getenv("DB_UNIX_SOCKET"):
        return None
    db_host = os.getenv("DB_HOST", "")
    if "supabase.com" in db_host or "pooler.supabase" in db_host:
        return "require"
    return None


def _get_database_url() -> str:
    """Internal alias for get_database_url (used by get_pool)."""
    return get_database_url()


async def get_pool() -> asyncpg.Pool:
    """Get or create the connection pool.

    Returns:
        asyncpg.Pool: The database connection pool

    Raises:
        EnvironmentError: If database credentials are not configured
    """
    global _pool

    if _pool is None:
        database_url = _get_database_url()
        ssl_config = get_database_ssl()
        connect_timeout_seconds = _get_connect_timeout_seconds()
        db_host = os.getenv("DB_HOST", "")
        db_unix_socket = os.getenv("DB_UNIX_SOCKET", "")
        db_user = os.getenv("DB_USER", "")
        db_password = os.getenv("DB_PASSWORD", "")
        db_name = os.getenv("DB_NAME", "postgres")
        db_port = int(os.getenv("DB_PORT", "5432"))
        target = db_unix_socket or db_host
        logger.info(f"Connecting to PostgreSQL at {target}...")
        if ssl_config:
            logger.info("SSL enabled for Supabase pooler connection")
        if db_unix_socket:
            _pool = await asyncpg.create_pool(
                user=db_user,
                password=db_password,
                database=db_name,
                host=db_unix_socket,
                port=db_port,
                min_size=2,
                max_size=10,
                timeout=connect_timeout_seconds,
                command_timeout=60,
                max_inactive_connection_lifetime=300,
            )
        else:
            _pool = await asyncpg.create_pool(
                database_url,
                min_size=2,
                max_size=10,
                timeout=connect_timeout_seconds,
                command_timeout=60,
                max_inactive_connection_lifetime=300,
                ssl=ssl_config,
            )
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
