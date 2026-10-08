"""Real scheduling leases, duplicate prevention and account deletion in isolated PostgreSQL."""

import asyncio
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, text

from hushh_mcp.services.calendar_reminder_store import CalendarReminderStore
from hushh_mcp.services.google_connection_service import GoogleConnectionService
from hushh_mcp.services.push_tokens_service import PushTokensService
from tests.services.test_calendar_reminders import meeting
from tests.services.test_external_connector_lifecycle_postgres import (
    connector_postgres_url,  # noqa: F401 -- shared isolated cluster fixture
)


@pytest.fixture
def reminders(connector_postgres_url, monkeypatch):  # noqa: F811 -- imported pytest fixture
    schema = "calendar_test_" + uuid.uuid4().hex
    admin = create_engine(connector_postgres_url)
    with admin.begin() as conn:
        conn.exec_driver_sql(f'CREATE SCHEMA "{schema}"')
    engine = create_engine(
        connector_postgres_url, connect_args={"options": f"-csearch_path={schema},public"}
    )
    db = SimpleNamespace(engine=engine)
    connections = GoogleConnectionService(db=db)
    monkeypatch.setattr(connections, "_token_key", lambda: b"k" * 32)
    monkeypatch.setattr(
        "hushh_mcp.services.calendar_reminder_store.get_google_connection_service",
        lambda: connections,
    )
    with engine.connect() as conn:
        conn.exec_driver_sql(
            "CREATE TABLE user_push_tokens(id SERIAL PRIMARY KEY,user_id TEXT NOT NULL,token TEXT NOT NULL,platform TEXT NOT NULL,created_at TIMESTAMPTZ,updated_at TIMESTAMPTZ,UNIQUE(user_id,platform))"
        )
        conn.exec_driver_sql("CREATE TABLE actor_profiles(user_id TEXT PRIMARY KEY)")
        conn.exec_driver_sql(
            "CREATE TABLE google_provider_connections(user_id TEXT,provider TEXT,provider_subject TEXT,status TEXT,refresh_token_ciphertext TEXT)"
        )
        conn.exec_driver_sql(
            "CREATE TABLE google_service_grants(user_id TEXT,provider TEXT,service TEXT,status TEXT,scope_csv TEXT)"
        )
        migration = (
            Path(__file__).resolve().parents[2] / "db/migrations/285_calendar_meeting_reminders.sql"
        )
        conn.exec_driver_sql(migration.read_text())
        conn.exec_driver_sql(migration.read_text())
        conn.execute(text("INSERT INTO actor_profiles VALUES ('owner')"))
        conn.execute(
            text(
                "INSERT INTO google_provider_connections VALUES ('owner','google','account-a','connected','refresh-a')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO google_service_grants VALUES ('owner','google','calendar','connected',:scopes)"
            ),
            {"scopes": " ".join(connections.scopes("calendar", "manage"))},
        )
        conn.commit()
    try:
        yield CalendarReminderStore(db=db), engine
    finally:
        engine.dispose()
        with admin.begin() as conn:
            conn.exec_driver_sql(f'DROP SCHEMA "{schema}" CASCADE')
        admin.dispose()


@pytest.mark.asyncio
async def test_device_token_transfers_to_current_owner_even_when_previous_logout_cleanup_was_skipped(
    reminders, monkeypatch
):
    _, engine = reminders
    monkeypatch.setattr(
        "hushh_mcp.services.push_tokens_service.get_db", lambda: SimpleNamespace(engine=engine)
    )
    service = PushTokensService()
    await asyncio.to_thread(service.upsert_user_push_token, "owner-a", "shared-installation", "ios")
    await asyncio.to_thread(service.upsert_user_push_token, "owner-b", "shared-installation", "ios")
    with engine.connect() as conn:
        assert conn.execute(
            text("SELECT user_id FROM user_push_tokens WHERE token='shared-installation'")
        ).scalars().all() == ["owner-b"]
    await asyncio.gather(
        *(
            asyncio.to_thread(service.upsert_user_push_token, owner, "shared-installation", "ios")
            for owner in ["owner-a", "owner-b"]
        )
    )
    with engine.connect() as conn:
        assert (
            conn.execute(
                text("SELECT count(*) FROM user_push_tokens WHERE token='shared-installation'")
            ).scalar()
            == 1
        )


@pytest.mark.asyncio
async def test_reconcile_claim_retry_and_disable_fences(reminders):
    store, engine = reminders
    await store.set_preferences("owner", enabled=True, show_title=True, time_zone="UTC")
    account = (await store.claim_accounts())[0]
    generation = await store.live_generation("owner")
    event = meeting()
    await store.reconcile(account, generation, [event])
    await store.reconcile(account, generation, [event])
    with engine.begin() as conn:
        assert (
            conn.execute(text("SELECT count(*) FROM calendar_reminder_instances")).scalar_one() == 1
        )
        conn.execute(
            text(
                "UPDATE calendar_reminder_instances SET due_at=clock_timestamp(),next_attempt_at=clock_timestamp()"
            )
        )
    first, second = await asyncio.gather(store.claim_due(), store.claim_due())
    jobs = first + second
    assert len(jobs) == 1
    row = jobs[0]
    assert (await store.authorize_send(row, generation))["accepted_targets"] == set()
    await store.settle(row, state="queued", accepted={"accepted-device"})
    with engine.begin() as conn:
        conn.execute(
            text("UPDATE calendar_reminder_instances SET next_attempt_at=clock_timestamp()")
        )
    retry = (await store.claim_due())[0]
    assert (await store.authorize_send(retry, generation))["accepted_targets"] == {
        "accepted-device"
    }
    await store.set_preferences("owner", enabled=False, show_title=True, time_zone="UTC")
    assert await store.authorize_send(retry, generation) is None
    assert await store.claim_due() == []


@pytest.mark.asyncio
async def test_provider_reconnect_gets_new_opaque_id_and_account_erasure_cascades(reminders):
    store, engine = reminders
    await store.set_preferences("owner", enabled=True, show_title=True, time_zone="UTC")
    account = (await store.claim_accounts())[0]
    event = meeting()
    generation = await store.live_generation("owner")
    await store.reconcile(account, generation, [event])
    with engine.begin() as conn:
        original = conn.execute(
            text("SELECT reminder_id FROM calendar_reminder_instances")
        ).scalar_one()
        conn.execute(
            text(
                "UPDATE google_provider_connections SET provider_subject='account-b',refresh_token_ciphertext='refresh-b'"
            )
        )
    await store.reconcile(account, await store.live_generation("owner"), [event])
    with engine.begin() as conn:
        ids = list(
            conn.execute(text("SELECT reminder_id FROM calendar_reminder_instances")).scalars()
        )
        assert len(ids) == 2 and original in ids
        assert await store.resolve("another-owner", str(original)) is None
        conn.execute(text("DELETE FROM actor_profiles WHERE user_id='owner'"))
    with engine.begin() as conn:
        assert (
            conn.execute(text("SELECT count(*) FROM calendar_reminder_instances")).scalar_one() == 0
        )
