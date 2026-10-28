"""Isolated Google OAuth PostgreSQL fixture schema."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from sqlalchemy import text


def install_calendar_schema(connection: Any, owner: str) -> None:
    connection.execute(text("CREATE TABLE actor_profiles (user_id TEXT PRIMARY KEY)"))
    # The shared connector publication guard reads these legacy
    # identities even when this fixture has no private-pod owner.
    connection.execute(
        text("""CREATE TABLE personal_agent_registry (
        user_id TEXT PRIMARY KEY, deployment_target TEXT, backend_metadata JSONB
    )""")
    )
    connection.execute(
        text("""CREATE TABLE kai_gmail_connections (
        user_id TEXT PRIMARY KEY, status TEXT,
        refresh_token_ciphertext TEXT, refresh_token_iv TEXT, refresh_token_tag TEXT,
        access_token_ciphertext TEXT, access_token_iv TEXT, access_token_tag TEXT,
        access_token_expires_at TIMESTAMPTZ, revoked BOOLEAN DEFAULT FALSE,
        auto_sync_enabled BOOLEAN DEFAULT FALSE, send_enabled BOOLEAN DEFAULT FALSE,
        disconnected_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
    )""")
    )
    migration = (
        Path(__file__).parents[1] / "db/migrations/144_google_integrations_calendar_foundation.sql"
    )
    # The exact canonical table shape; only outer transaction markers
    # are removed because this fixture already owns the transaction.
    sql = migration.read_text().replace("BEGIN;", "").replace("COMMIT;", "")
    connection.exec_driver_sql(sql)
    for name in (
        "369_calendar_additional_accounts.sql",
        "433_calendar_guest_photo_access.sql",
    ):
        migration = Path(__file__).parents[1] / "db/migrations" / name
        sql = migration.read_text().replace("BEGIN;", "").replace("COMMIT;", "")
        # This isolated fixture has no account-deletion guard function.
        sql = sql.replace("SELECT install_account_deletion_write_guards();", "")
        connection.exec_driver_sql(sql)
    connection.execute(
        text("INSERT INTO actor_profiles(user_id) VALUES (:owner), ('synthetic-other')"),
        {"owner": owner},
    )
