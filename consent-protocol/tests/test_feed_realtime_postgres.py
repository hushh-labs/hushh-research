"""Opt-in real PostgreSQL proof using only a newly created disposable database."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

import asyncpg
import pytest
import pytest_asyncio

from db.migration_authority import MigrationMode, apply_manifest_entries, build_manifest_entries

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "db/migrations/313_feed_realtime_changes.sql"
CHANNEL = "one_user_state_changed"


@pytest_asyncio.fixture
async def feed_db():
    source = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not source:
        pytest.skip("Requires explicit local disposable PostgreSQL server")
    # CI shares a SQLAlchemy DSN; asyncpg requires the plain PostgreSQL scheme.
    source = source.replace("postgresql+psycopg2://", "postgresql://", 1)
    parts = urlsplit(source)
    if parts.hostname not in {"localhost", "127.0.0.1", "::1"}:
        pytest.fail("Feed migration proof requires a local disposable server")
    database = "feed_realtime_test_" + uuid4().hex
    admin = await asyncpg.connect(source)
    connections = []
    created = False
    try:
        await admin.execute(f'CREATE DATABASE "{database}"')
        created = True
        url = urlunsplit((parts.scheme, parts.netloc, "/" + database, parts.query, ""))
        for _ in range(2):
            connections.append(await asyncpg.connect(url))
        writer, listener = connections
        await writer.execute("""
          CREATE TABLE feed_events (
            id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL,
            source_domain TEXT NOT NULL, event_type TEXT NOT NULL,
            actor_label TEXT, metadata JSONB NOT NULL DEFAULT '{}', source_row_id TEXT,
            read_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
        """)
        yield writer, listener
    finally:
        for connection in connections:
            await connection.close()
        if created:
            await admin.execute(f'DROP DATABASE "{database}"')
        await admin.close()


async def assert_quiet(queue):
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(queue.get(), 0.1)


@pytest.mark.asyncio
async def test_feed_hints_commit_scope_coalescing_and_every_write(feed_db):
    writer, listener = feed_db
    await writer.execute(MIGRATION.read_text())
    queue = asyncio.Queue()
    await listener.add_listener(
        CHANNEL, lambda _c, _p, _ch, value: queue.put_nowait(json.loads(value))
    )

    async def expect(*owners):
        hints = [await asyncio.wait_for(queue.get(), 2) for _ in owners]
        assert hints == [{"type": "feed_changed", "user_id": owner} for owner in owners]
        await assert_quiet(queue)

    await writer.execute("BEGIN")
    # Direct writes from any producer, even many rows, coalesce by owner. Private
    # metadata and actor text must never appear in the NOTIFY payload.
    await writer.execute("""
      INSERT INTO feed_events(user_id,source_domain,event_type,actor_label,metadata)
      SELECT 'owner','kai','test','private actor','{"private":"secret"}'::jsonb
      FROM generate_series(1, 100);
    """)
    await assert_quiet(queue)
    await writer.execute("COMMIT")
    await expect("owner")
    await writer.execute("UPDATE feed_events SET read_at=now()")
    await expect("owner")
    await writer.execute("UPDATE feed_events SET read_at=read_at")
    await assert_quiet(queue)
    await writer.execute("UPDATE feed_events SET user_id='new-owner'")
    await expect("owner", "new-owner")
    await writer.execute("BEGIN; DELETE FROM feed_events; ROLLBACK")
    await assert_quiet(queue)
    assert await writer.fetchval("SELECT count(*) FROM feed_events") == 100
    await writer.execute("DELETE FROM feed_events")
    await expect("new-owner")


@pytest.mark.asyncio
async def test_feed_trigger_replay_does_not_lock_hot_table_and_rollback_is_narrow(feed_db):
    writer, other = feed_db
    sql = MIGRATION.read_text()
    await writer.execute(sql)
    trigger_oid = await writer.fetchval(
        "SELECT oid FROM pg_trigger WHERE tgname='feed_events_realtime_wake'"
    )
    # A concurrent writer holds the lock that DROP/CREATE TRIGGER would block on.
    await other.execute("BEGIN; LOCK TABLE feed_events IN ROW EXCLUSIVE MODE")
    await writer.execute("SET lock_timeout='100ms'")
    try:
        await writer.execute(sql)
    finally:
        await other.execute("ROLLBACK")
    assert (
        await writer.fetchval("SELECT oid FROM pg_trigger WHERE tgname='feed_events_realtime_wake'")
        == trigger_oid
    )
    await writer.execute("ALTER TABLE feed_events DISABLE TRIGGER feed_events_realtime_wake")
    with pytest.raises(asyncpg.RaiseError, match="unexpected definition"):
        await writer.execute(sql)
    await writer.execute("ROLLBACK")
    await writer.execute("ALTER TABLE feed_events ENABLE TRIGGER feed_events_realtime_wake")
    await writer.execute("""
      CREATE FUNCTION unrelated_feed_projection() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RETURN NEW; END $$;
      CREATE TRIGGER unrelated_feed_projection AFTER INSERT ON feed_events
        FOR EACH ROW EXECUTE FUNCTION unrelated_feed_projection();
      INSERT INTO feed_events(user_id,source_domain,event_type) VALUES('owner','kai','test');
    """)
    rollback = (ROOT / "db/migrations/rollback/313_feed_realtime_changes.rollback.sql").read_text()
    await writer.execute(rollback)
    await writer.execute(rollback)
    assert await writer.fetchval("SELECT count(*) FROM feed_events") == 1
    assert (
        await writer.fetchval(
            "SELECT count(*) FROM pg_trigger WHERE tgname='unrelated_feed_projection'"
        )
        == 1
    )
    assert await writer.fetchval("SELECT to_regprocedure('public.notify_feed_changed()')") is None
    await writer.execute(sql)


@pytest.mark.asyncio
async def test_legacy_288_replay_preserves_future_document_event_and_existing_row(feed_db):
    writer, _ = feed_db
    await writer.execute("""
      CREATE TABLE drive_share_events(event_id UUID DEFAULT gen_random_uuid(), request_id UUID,
        user_id TEXT, event_type TEXT, created_at TIMESTAMPTZ DEFAULT now(),
        CONSTRAINT drive_share_events_event_type_check
        CHECK(event_type IN ('document_share_request','document_share_future_settlement')));
      INSERT INTO drive_share_events(event_type) VALUES('document_share_future_settlement');
      CREATE TABLE drive_share_requests(request_id UUID, user_id TEXT, recipient_user_id TEXT,
        access_stop_requested_at TIMESTAMPTZ);
      CREATE FUNCTION project_drive_event_to_feed(text,uuid,uuid,text,text,timestamptz)
      RETURNS void LANGUAGE plpgsql AS $$ BEGIN
        -- 'document_share_request_sent' is already installed in the projection.
        RETURN;
      END $$;
    """)
    entries = build_manifest_entries(ROOT / "db/migrations", ("288_drive_request_feed_stream.sql",))
    # Negative control: the unchanged historical body rejects an existing future
    # row. The runner must repair replay, not edit or bypass its historical hash.
    with pytest.raises(asyncpg.CheckViolationError):
        await writer.execute(entries[0].sql)
    await writer.execute("ROLLBACK")
    await apply_manifest_entries(writer, entries, mode=MigrationMode.REPLAY)
    constraint_oid = await writer.fetchval(
        "SELECT oid FROM pg_constraint WHERE conname='drive_share_events_event_type_check'"
    )
    await apply_manifest_entries(writer, entries, mode=MigrationMode.REPLAY)
    assert (
        await writer.fetchval(
            "SELECT oid FROM pg_constraint WHERE conname='drive_share_events_event_type_check'"
        )
        == constraint_oid
    )
    assert await writer.fetchval("SELECT count(*) FROM drive_share_events") == 1
    await writer.execute(
        "INSERT INTO drive_share_events(event_type) VALUES('document_share_future_settlement'),('document_share_request_sent')"
    )
    with pytest.raises(asyncpg.CheckViolationError):
        await writer.execute(
            "INSERT INTO drive_share_events(event_type) VALUES('unreviewed_event')"
        )
