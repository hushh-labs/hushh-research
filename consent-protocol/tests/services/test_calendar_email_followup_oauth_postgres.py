"""Successful B/C Mail OAuth and opt-in on a disposable PostgreSQL server."""

from __future__ import annotations

import base64
import secrets
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

import pytest
from fastapi import Response
from sqlalchemy import create_engine, text

from api.routes.one import calendar_email_followups as routes
from db.db_client import DatabaseClient
from hushh_mcp.services import calendar_email_followup_account as account
from hushh_mcp.services import owner_placement_guard
from hushh_mcp.services.calendar_email_followup_crypto import FollowupCipher
from hushh_mcp.services.calendar_email_followup_store import (
    CalendarEmailFollowupStore,
    FollowupStateError,
)
from hushh_mcp.services.google_connection_service import GoogleConnectionService
from tests.google_oauth_postgres_support import OWNER, install_calendar_schema
from tests.services.test_external_connector_lifecycle_postgres import (
    connector_postgres_url,  # noqa: F401
)

MIGRATIONS = Path(__file__).resolve().parents[2] / "db" / "migrations"
REDIRECT = "https://api.uat.hushh.ai/one/profile/google/oauth/return"
CALENDAR_SCOPES = (
    "https://www.googleapis.com/auth/calendar.events.readonly "
    "https://www.googleapis.com/auth/calendar.freebusy "
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly"
)
MAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"


@pytest.fixture
def followup_pg(connector_postgres_url, monkeypatch):  # noqa: F811 - imported pytest fixture
    # The parent fixture attests a disposable server. Give each test its own
    # database because the SQL grant fence resolves public schema objects.
    database = "calendar_followup_" + uuid4().hex
    admin = create_engine(connector_postgres_url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}"')
    engine = create_engine(
        connector_postgres_url.set(database=database), connect_args={"options": "-ctimezone=UTC"}
    )
    with engine.begin() as connection:
        connection.exec_driver_sql("CREATE EXTENSION IF NOT EXISTS pgcrypto")
        install_calendar_schema(connection, OWNER)
        connection.exec_driver_sql(
            "ALTER TABLE kai_gmail_connections ADD COLUMN google_sub TEXT, ADD COLUMN scope_csv TEXT"
        )
        connection.exec_driver_sql("""CREATE TABLE system_push_outbox (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_kind TEXT NOT NULL CHECK (source_kind IN
          ('share','location_request','circle_member','connection_request')),
        source_id UUID NOT NULL, source_revision TEXT NOT NULL DEFAULT '',
        recipient_user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
          ('pending','leased','sent','suppressed','failed')),
        attempts SMALLINT NOT NULL DEFAULT 0, due_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '1 day',
        lease_id UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(source_kind,source_id,source_revision,recipient_user_id))""")
        connection.exec_driver_sql("""CREATE TABLE feed_events (
        id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL,
        source_domain TEXT NOT NULL CHECK (source_domain IN
          ('consent','location','kai','kyc','connected_systems','connections','pwm')),
        event_type TEXT NOT NULL, actor_label TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        source_row_id TEXT, read_at TIMESTAMPTZ, dismissed_at TIMESTAMPTZ,
        dismissal_token UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now())""")
        connection.exec_driver_sql("""CREATE TABLE conversations (
        id UUID PRIMARY KEY, participant_a_user_id TEXT, participant_b_user_id TEXT)""")
        connection.exec_driver_sql("""CREATE TABLE messages (
        id UUID PRIMARY KEY, conversation_id UUID, sender_user_id TEXT,
        deleted_for_recipient_at TIMESTAMPTZ, deleted_for_everyone_at TIMESTAMPTZ)""")
        connection.exec_driver_sql("""CREATE UNIQUE INDEX feed_events_source_idempotency
        ON feed_events(user_id,source_domain,event_type,source_row_id)
        WHERE source_row_id IS NOT NULL""")
        for name in (
            "442_calendar_mail_read_grant.sql",
            "443_calendar_email_followups.sql",
            "444_calendar_email_followup_delivery.sql",
        ):
            sql = (MIGRATIONS / name).read_text().replace("BEGIN;", "").replace("COMMIT;", "")
            sql = sql.replace("SELECT install_account_deletion_write_guards();", "")
            connection.exec_driver_sql(sql)
    monkeypatch.setenv("CALENDAR_EMAIL_FOLLOWUPS", "true")
    monkeypatch.setenv("CALENDAR_EMAIL_FOLLOWUP_DRAIN_ENABLED", "true")
    monkeypatch.setattr(owner_placement_guard, "admit_hub_content", AsyncMock())
    monkeypatch.setenv(
        "GOOGLE_OAUTH_TOKEN_KEY", base64.urlsafe_b64encode(secrets.token_bytes(32)).decode()
    )
    service = GoogleConnectionService(db=DatabaseClient(engine=engine))
    monkeypatch.setattr(service, "_signing_key", lambda: b"synthetic-signing-key" * 2)
    monkeypatch.setattr(service, "is_configured", lambda: True)
    monkeypatch.setattr(service, "_client_id", lambda: "synthetic-client")
    monkeypatch.setattr(service, "_client_secret", lambda: "synthetic-secret")
    monkeypatch.setattr(service, "_redirect_uri", lambda value: value or REDIRECT)
    monkeypatch.setattr(service, "_userinfo", AsyncMock())
    monkeypatch.setattr(service, "_post_form", AsyncMock())
    cipher = FollowupCipher(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())
    store = CalendarEmailFollowupStore(db=SimpleNamespace(engine=engine), cipher=cipher)
    monkeypatch.setattr(routes, "get_google_connection_service", lambda: service)
    monkeypatch.setattr(routes, "CalendarEmailFollowupStore", lambda: store)
    monkeypatch.setattr(account, "get_google_connection_service", lambda: service)
    try:
        yield service, store, engine
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f'DROP DATABASE "{database}" WITH (FORCE)')
        admin.dispose()


async def _add_calendar(service: GoogleConnectionService, subject: str, email: str) -> str:
    service._userinfo.return_value = {"sub": subject, "email": email}
    service._post_form.return_value = {
        "access_token": "synthetic-calendar-access-" + subject,
        "refresh_token": "synthetic-calendar-refresh-" + subject,
        "scope": CALENDAR_SCOPES,
        "expires_in": 3600,
    }
    started = await service.start_native(
        user_id=OWNER, service="calendar", access_level="read", calendar_additional=True
    )
    finished = await service.complete_native(
        user_id=OWNER,
        service="calendar",
        access_level="read",
        server_auth_code="synthetic-calendar-code",
        state=started["state"],
    )
    return finished["completed_account_id"]


async def _connect_mail(service: GoogleConnectionService, account_id: str, subject: str):
    service._userinfo.return_value = {"sub": subject, "email": subject + "@example.test"}
    service._post_form.return_value = {
        "access_token": "synthetic-mail-access-" + subject,
        "refresh_token": "synthetic-mail-refresh-" + subject,
        "scope": CALENDAR_SCOPES + " " + MAIL_SCOPE,
        "expires_in": 3600,
    }
    started = await routes.start_selected_mail(
        routes.MailConnectStart(user_id=OWNER, account_id=account_id, redirect_uri=REDIRECT),
        firebase_uid=OWNER,
    )
    state = parse_qs(urlparse(started["authorize_url"]).query)["state"][0]
    return await routes.complete_selected_mail(
        routes.MailConnectComplete(
            user_id=OWNER,
            account_id=account_id,
            code="synthetic-mail-code",
            state=state,
            redirect_uri=REDIRECT,
        ),
        firebase_uid=OWNER,
    )


def test_followup_migrations_roll_back_without_live_state(followup_pg):
    _, _, engine = followup_pg
    with engine.begin() as connection:
        for name in (
            "444_calendar_email_followup_delivery.rollback.sql",
            "443_calendar_email_followups.rollback.sql",
            "442_calendar_mail_read_grant.rollback.sql",
        ):
            sql = (MIGRATIONS / "rollback" / name).read_text()
            connection.exec_driver_sql(sql.replace("BEGIN;", "").replace("COMMIT;", ""))
        assert (
            connection.execute(
                text("SELECT to_regclass('calendar_email_followup_monitors')")
            ).scalar()
            is None
        )
        assert (
            connection.execute(
                text("""SELECT 1 FROM information_schema.columns
            WHERE table_name='google_calendar_additional_accounts'
              AND column_name='gmail_read_enabled'""")
            ).scalar()
            is None
        )


@pytest.mark.asyncio
async def test_account_b_c_connect_opt_in_switch_refresh_and_revoke(followup_pg):
    service, store, engine = followup_pg
    b = await _add_calendar(service, "synthetic-b", "b@example.test")
    c = await _add_calendar(service, "synthetic-c", "c@example.test")
    assert b != c and b != "default" and c != "default"
    with engine.begin() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM kai_gmail_connections WHERE user_id=:owner"),
                {"owner": OWNER},
            ).scalar_one()
            == 0
        )
    assert not await account.selected_mail_status(user_id=OWNER, account_id=b)
    assert not await account.selected_mail_status(user_id=OWNER, account_id=c)

    assert (await _connect_mail(service, b, "synthetic-b"))["completed_account_id"] == b
    assert await account.selected_mail_status(user_id=OWNER, account_id=b)
    assert not await account.selected_mail_status(user_id=OWNER, account_id=c)
    assert (await _connect_mail(service, c, "synthetic-c"))["completed_account_id"] == c
    assert await account.selected_mail_status(user_id=OWNER, account_id=c)
    assert (await account.open_selected_mail_grant(user_id=OWNER, account_id=b)).account_id == b

    historical = datetime(2026, 10, 1, tzinfo=UTC)
    for selected in (b, c):
        result = await routes.preferences(
            routes.PreferenceChange(
                user_id=OWNER,
                account_id=selected,
                enabled=True,
                historical_start_at=historical,
                time_zone="Asia/Kolkata",
            ),
            response=Response(),
            firebase_uid=OWNER,
            owner={"user_id": OWNER},
        )
        assert result["monitoring_enabled"] is True
    b_monitor = await store.monitor(user_id=OWNER, account_id=b)
    c_monitor = await store.monitor(user_id=OWNER, account_id=c)
    assert b_monitor and c_monitor
    # A dropdown switch performs reads only; both separate opt-ins survive.
    assert (
        await routes.status(routes._Selection(user_id=OWNER, account_id=c), firebase_uid=OWNER)
    )["monitoring_enabled"]
    assert (
        await routes.status(routes._Selection(user_id=OWNER, account_id=b), firebase_uid=OWNER)
    )["monitoring_enabled"]

    before = await account.open_selected_mail_grant(user_id=OWNER, account_id=b)
    with engine.begin() as connection:
        connection.execute(
            text("""UPDATE google_calendar_additional_accounts SET
        access_token_expires_at=NOW()-interval '1 minute' WHERE user_id=:owner AND account_id=:account"""),
            {"owner": OWNER, "account": b},
        )
    service._post_form.return_value = {
        "access_token": "synthetic-refreshed-access",
        "expires_in": 3600,
        "scope": CALENDAR_SCOPES + " " + MAIL_SCOPE,
    }
    await service.access_token(user_id=OWNER, service="gmail", access_level="read", account_id=b)
    await before.require_current()
    assert (await store.monitor(user_id=OWNER, account_id=b)).generation == b_monitor.generation

    await service.disconnect_service(user_id=OWNER, service="gmail", account_id=b)
    assert not await account.selected_mail_status(user_id=OWNER, account_id=b)
    assert await store.monitor(user_id=OWNER, account_id=b) is None
    assert (await store.monitor(user_id=OWNER, account_id=c)).generation == c_monitor.generation
    with pytest.raises(account.SelectedMailAccessError, match="mail_grant_changed"):
        await before.require_current()
    # An opt-in request that captured B's former grant before disconnect
    # cannot recreate an enabled monitor after the revoke transaction commits.
    with pytest.raises(FollowupStateError, match="monitor_changed"):
        await store.configure(
            user_id=OWNER,
            account_id=b,
            enabled=True,
            grant_epoch_digest=before.epoch_digest,
            provider_subject_sha256=before.provider_subject_sha256,
            mail_generation=before.mail_generation,
            calendar_connected_at=before.calendar_connected_at,
            calendar_grant_revision=before.calendar_grant_revision,
            historical_start_at=historical,
            time_zone="Asia/Kolkata",
            notifications_enabled=False,
        )
    assert await store.monitor(user_id=OWNER, account_id=b) is None

    c_grant = await account.open_selected_mail_grant(user_id=OWNER, account_id=c)
    with engine.begin() as connection:
        connection.execute(
            text("""UPDATE google_calendar_additional_accounts SET
        provider_subject='synthetic-replacement' WHERE user_id=:owner AND account_id=:account"""),
            {"owner": OWNER, "account": c},
        )
    with pytest.raises(account.SelectedMailAccessError, match="mail_grant_changed"):
        await c_grant.require_current()
    assert not await account.selected_mail_status(user_id=OWNER, account_id=c)
    # Withdrawal is account scoped even after a changed provider identity.
    disabled = await routes.preferences(
        routes.PreferenceChange(user_id=OWNER, account_id=c, enabled=False),
        response=Response(),
        firebase_uid=OWNER,
        owner={"user_id": OWNER},
    )
    assert disabled["monitoring_enabled"] is False
    assert await store.monitor(user_id=OWNER, account_id=c) is None
