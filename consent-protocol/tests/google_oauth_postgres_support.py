"""Isolated Google OAuth PostgreSQL fixture schema."""

from __future__ import annotations

import base64
import os
import secrets
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from db.db_client import DatabaseClient
from hushh_mcp.services.google_connection_service import GoogleConnectionService


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
        "434_calendar_guest_photo_access.sql",
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


OWNER = "synthetic-owner"


@pytest.fixture
def pg_service(monkeypatch):
    url = os.getenv("GOOGLE_OAUTH_TEST_DATABASE_URL")
    if not url:
        pytest.skip("requires disposable local PostgreSQL")
    parsed = make_url(url)
    assert not parsed.host and str(parsed.query.get("host", "")).startswith(
        "/tmp/hushh-google-oauth-pg."  # noqa: S108 - explicitly supplied disposable socket
    )
    schema = "google_oauth_test_" + uuid4().hex
    base = create_engine(url)
    with base.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_engine(url, connect_args={"options": f"-csearch_path={schema}"})
    try:
        with engine.begin() as connection:
            install_calendar_schema(connection, OWNER)
        monkeypatch.setenv(
            "GOOGLE_OAUTH_TOKEN_KEY", base64.urlsafe_b64encode(secrets.token_bytes(32)).decode()
        )
        service = GoogleConnectionService(db=DatabaseClient(engine=engine))
        signing_key = secrets.token_bytes(32)
        monkeypatch.setattr(service, "_signing_key", lambda: signing_key)
        monkeypatch.setattr(service, "is_configured", lambda: True)
        monkeypatch.setattr(service, "_client_id", lambda: "synthetic-client")
        monkeypatch.setattr(service, "_client_secret", lambda: "synthetic-secret")
        monkeypatch.setattr(
            service,
            "_userinfo",
            AsyncMock(return_value={"sub": "synthetic-provider", "email": "owner@example.test"}),
        )

        async def token_exchange(_url, payload):
            return {
                "access_token": "synthetic-access-" + payload["code"],
                "refresh_token": "synthetic-refresh-" + payload["code"],
                # This transaction fixture models an accepted incremental
                # Google grant; scope-denial behavior has separate unit tests.
                "scope": "openid email profile "
                "https://www.googleapis.com/auth/calendar.events.readonly "
                "https://www.googleapis.com/auth/calendar.freebusy "
                "https://www.googleapis.com/auth/calendar.calendarlist.readonly "
                "https://www.googleapis.com/auth/contacts.readonly "
                "https://www.googleapis.com/auth/drive.readonly",
                "expires_in": 3600,
            }

        monkeypatch.setattr(service, "_post_form", AsyncMock(side_effect=token_exchange))
        yield service, engine
    finally:
        engine.dispose()
        with base.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        base.dispose()


async def start(service):
    return await service.start_native(user_id=OWNER, service="calendar", access_level="read")


async def finish(connection_service, attempt, code="fresh", **overrides):
    params = {
        "user_id": OWNER,
        "service": "calendar",
        "access_level": "read",
        "server_auth_code": code,
        "state": attempt["state"],
    }
    return await connection_service.complete_native(**(params | overrides))


async def seed_connected_with_sibling(service, engine):
    await finish(service, await start(service), "initial")
    with engine.begin() as connection:
        # Keep the provider connected on Calendar disconnect so the test also
        # proves invalidation when the shared credential generation is unchanged.
        connection.execute(
            text(
                "INSERT INTO google_service_grants(user_id, service, status) VALUES (:owner, 'gmail', 'connected')"
            ),
            {"owner": OWNER},
        )
