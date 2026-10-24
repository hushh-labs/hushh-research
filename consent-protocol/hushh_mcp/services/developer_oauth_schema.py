"""Dialect-specific bootstrap schema; release migrations remain authoritative."""

from __future__ import annotations

import os

from db.db_client import DatabaseClient

_OFFLINE_STATEMENTS = [
    """CREATE TABLE IF NOT EXISTS developer_oauth_clients (
                    app_id TEXT PRIMARY KEY, client_id TEXT NOT NULL UNIQUE,
                    client_secret_hash TEXT NOT NULL, client_secret_prefix TEXT NOT NULL,
                    redirect_uris TEXT NOT NULL, created_at INTEGER NOT NULL,
                    secret_rotated_at INTEGER NOT NULL, revoked_at INTEGER,
                    allowed_grant_types TEXT NOT NULL DEFAULT '[\"authorization_code\",\"refresh_token\"]',
                    mcp_execution_mode TEXT NOT NULL DEFAULT 'execute')""",
    """CREATE TABLE IF NOT EXISTS developer_oauth_authorizations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_ref TEXT NOT NULL UNIQUE,
                    code_hash TEXT UNIQUE, app_id TEXT NOT NULL, client_id TEXT NOT NULL,
                    redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL,
                    subject_firebase_uid TEXT, requested_scope TEXT NOT NULL,
                    state TEXT, status TEXT NOT NULL, expires_at INTEGER NOT NULL,
                    created_at INTEGER NOT NULL, consumed_at INTEGER)""",
    """CREATE TABLE IF NOT EXISTS developer_oauth_tokens (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL UNIQUE,
                    token_prefix TEXT NOT NULL, token_kind TEXT NOT NULL, app_id TEXT NOT NULL,
                    subject_firebase_uid TEXT, authorization_id INTEGER,
                    scopes TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
                    revoked_at INTEGER, last_used_at INTEGER,
                    grant_type TEXT NOT NULL DEFAULT 'authorization_code',
                    mcp_execution_mode TEXT NOT NULL DEFAULT 'execute')""",
    """CREATE TABLE IF NOT EXISTS developer_oauth_audit_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL,
                    client_id TEXT, subject_firebase_uid TEXT, event_type TEXT NOT NULL,
                    created_at INTEGER NOT NULL)""",
]

_POSTGRES_STATEMENTS = [
    """CREATE TABLE IF NOT EXISTS developer_oauth_clients (
                    app_id TEXT PRIMARY KEY REFERENCES developer_apps(app_id) ON DELETE CASCADE,
                    client_id TEXT NOT NULL UNIQUE, client_secret_hash TEXT NOT NULL,
                    client_secret_prefix TEXT NOT NULL, redirect_uris JSONB NOT NULL DEFAULT '[]'::jsonb,
                    created_at BIGINT NOT NULL, secret_rotated_at BIGINT NOT NULL, revoked_at BIGINT,
                    allowed_grant_types JSONB NOT NULL DEFAULT '[\"authorization_code\",\"refresh_token\"]'::jsonb,
                    mcp_execution_mode TEXT NOT NULL DEFAULT 'execute')""",
    """CREATE TABLE IF NOT EXISTS developer_oauth_authorizations (
                    id BIGSERIAL PRIMARY KEY, transaction_ref TEXT NOT NULL UNIQUE,
                    code_hash TEXT UNIQUE, app_id TEXT NOT NULL REFERENCES developer_apps(app_id) ON DELETE CASCADE,
                    client_id TEXT NOT NULL REFERENCES developer_oauth_clients(client_id) ON DELETE CASCADE,
                    redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL,
                    subject_firebase_uid TEXT, requested_scope TEXT NOT NULL,
                    state TEXT, status TEXT NOT NULL, expires_at BIGINT NOT NULL,
                    created_at BIGINT NOT NULL, consumed_at BIGINT)""",
    """CREATE TABLE IF NOT EXISTS developer_oauth_tokens (
                    id BIGSERIAL PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
                    token_prefix TEXT NOT NULL, token_kind TEXT NOT NULL,
                    app_id TEXT NOT NULL REFERENCES developer_apps(app_id) ON DELETE CASCADE,
                    subject_firebase_uid TEXT,
                    authorization_id BIGINT REFERENCES developer_oauth_authorizations(id) ON DELETE SET NULL,
                    scopes JSONB NOT NULL DEFAULT '["mcp:tools"]'::jsonb,
                    created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL,
                    revoked_at BIGINT, last_used_at BIGINT,
                    grant_type TEXT NOT NULL DEFAULT 'authorization_code',
                    mcp_execution_mode TEXT NOT NULL DEFAULT 'execute',
                    CONSTRAINT developer_oauth_token_kind_check CHECK (token_kind IN ('access', 'refresh')))""",
    """CREATE TABLE IF NOT EXISTS developer_oauth_audit_events (
                    id BIGSERIAL PRIMARY KEY, app_id TEXT NOT NULL,
                    client_id TEXT, subject_firebase_uid TEXT,
                    event_type TEXT NOT NULL, created_at BIGINT NOT NULL)""",
]


def apply_developer_oauth_schema(db: DatabaseClient) -> None:
    offline = str(os.getenv("DB_OFFLINE", "0")).strip().lower() in {"1", "true", "yes", "on"}
    statements = _OFFLINE_STATEMENTS if offline else _POSTGRES_STATEMENTS
    for statement in statements:
        db.execute_raw(statement, {})
    if str(os.getenv("DB_OFFLINE", "0")).strip().lower() not in {"1", "true", "yes", "on"}:
        # Migration 105 is authoritative. These additive statements keep a
        # newly booted service safe against a narrowly lagging database.
        db.execute_raw(
            "ALTER TABLE developer_oauth_tokens ALTER COLUMN subject_firebase_uid DROP NOT NULL",
            {},
        )
        db.execute_raw(
            "ALTER TABLE developer_oauth_tokens ADD COLUMN IF NOT EXISTS grant_type TEXT NOT NULL DEFAULT 'authorization_code'",
            {},
        )
        db.execute_raw(
            'ALTER TABLE developer_oauth_clients ADD COLUMN IF NOT EXISTS allowed_grant_types JSONB NOT NULL DEFAULT \'["authorization_code","refresh_token"]\'::jsonb',
            {},
        )
        db.execute_raw(
            "ALTER TABLE developer_oauth_clients ADD COLUMN IF NOT EXISTS mcp_execution_mode TEXT NOT NULL DEFAULT 'execute'",
            {},
        )
        db.execute_raw(
            "ALTER TABLE developer_oauth_tokens ADD COLUMN IF NOT EXISTS mcp_execution_mode TEXT NOT NULL DEFAULT 'execute'",
            {},
        )
    if str(os.getenv("DB_OFFLINE", "0")).lower() in {"1", "true", "yes", "on"}:
        for table, column, definition in (
            (
                "developer_oauth_clients",
                "registration_method",
                "TEXT NOT NULL DEFAULT 'portal'",
            ),
            (
                "developer_oauth_clients",
                "token_endpoint_auth_method",
                "TEXT NOT NULL DEFAULT 'client_secret_basic'",
            ),
            ("developer_oauth_authorizations", "resource", "TEXT"),
            ("developer_oauth_tokens", "resource", "TEXT"),
        ):
            columns = db.execute_raw(f"PRAGMA table_info({table})", {}).data
            if column not in {row["name"] for row in columns}:
                db.execute_raw(f"ALTER TABLE {table} ADD COLUMN {column} {definition}", {})
