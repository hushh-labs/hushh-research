"""Drive sharing and Drive questions are written into the Feed.

Real isolated PostgreSQL. The guarantees under test: every Drive event reaches
its addressee's Feed as a connected_systems row naming the other person; the
row carries only the closed type, request id and status word (no file, purpose
or question text); a Feed failure can never fail the share; replay is
idempotent and backfills recent events once.
"""

# ruff: noqa: F811 -- shared pytest fixture imports

import json
import select

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from tests.services.test_drive_document_selection import (  # noqa: F401
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
)
from tests.services.test_drive_live_query import ask, store  # noqa: F401
from tests.services.test_drive_sharing_store import MIGRATIONS, request, sharing  # noqa: F401

PROJECTION = MIGRATIONS / "246_drive_feed_projection.sql"
STREAM_PROJECTION = MIGRATIONS / "288_drive_request_feed_stream.sql"
PAYMENT = MIGRATIONS / "262_drive_request_payments.sql"


def run_projection_migration(db, times=2):
    with db.engine.connect() as connection:
        with connection.connection.driver_connection.cursor() as cursor:
            # Replay mode runs every migration on every deploy.
            for _ in range(times):
                cursor.execute(PROJECTION.read_text())
                cursor.execute(STREAM_PROJECTION.read_text())
        connection.commit()


@pytest.fixture
async def feed(store):
    with store.db.engine.connect() as connection:
        # The sharing fixture stops at migration 263. Migration 287 adds this
        # request column before the Feed wake migration in deployment order.
        connection.exec_driver_sql(
            "ALTER TABLE drive_share_requests "
            "ADD COLUMN IF NOT EXISTS access_stop_requested_at TIMESTAMPTZ"
        )
        connection.exec_driver_sql("ALTER TABLE actor_identity_cache ADD COLUMN email TEXT")
        connection.exec_driver_sql("CREATE TABLE actor_profiles(user_id TEXT PRIMARY KEY)")
        connection.exec_driver_sql("INSERT INTO actor_profiles VALUES ('owner'),('recipient')")
        connection.exec_driver_sql(
            """
            CREATE TABLE feed_events(
              id BIGSERIAL PRIMARY KEY,
              user_id TEXT NOT NULL,
              source_domain TEXT NOT NULL CHECK (source_domain IN
                ('consent','location','kai','kyc','connected_systems','connections')),
              event_type TEXT NOT NULL,
              actor_label TEXT,
              metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
              source_row_id TEXT,
              read_at TIMESTAMPTZ,
              created_at TIMESTAMPTZ NOT NULL DEFAULT now())
            """
        )
        connection.exec_driver_sql(
            "CREATE UNIQUE INDEX uq_feed_events_source_projection ON feed_events"
            "(user_id,source_domain,event_type,source_row_id) WHERE source_row_id IS NOT NULL"
        )
        connection.exec_driver_sql(
            "CREATE TABLE feed_event_counterparts("
            "feed_event_id BIGINT PRIMARY KEY REFERENCES feed_events(id) ON DELETE CASCADE,"
            "counterpart_user_id TEXT NOT NULL REFERENCES actor_profiles(user_id))"
        )
        connection.commit()
    run_projection_migration(store.db)
    return store


@pytest.mark.asyncio
async def test_owner_access_stop_wakes_both_participants_once_without_private_data(feed, sharing):
    created = await request(sharing)
    with feed.db.engine.connect() as listener:
        raw = listener.connection.driver_connection
        listener.exec_driver_sql("LISTEN one_user_state_changed")
        listener.commit()

        with feed.db.engine.begin() as writer:
            writer.execute(
                text("""
                    UPDATE drive_share_requests
                    SET access_stop_requested_at=clock_timestamp()
                    WHERE request_id=:request
                """),
                {"request": created["requestId"]},
            )

        assert select.select([raw], [], [], 1)[0]
        raw.poll()
        messages = []
        while raw.notifies:
            messages.append(json.loads(raw.notifies.pop(0).payload))
        assert sorted(message["user_id"] for message in messages) == ["owner", "recipient"]
        for message in messages:
            assert message == {
                "type": "document_share_feed_changed",
                "user_id": message["user_id"],
                "event_id": created["requestId"],
                "request_id": created["requestId"],
            }

        with feed.db.engine.begin() as writer:
            writer.execute(
                text("""
                    UPDATE drive_share_requests
                    SET access_stop_requested_at=access_stop_requested_at
                    WHERE request_id=:request
                """),
                {"request": created["requestId"]},
            )
        assert not select.select([raw], [], [], 0.1)[0]


def feed_rows(db, user_id):
    with db.engine.connect() as connection:
        return [
            dict(row)
            for row in connection.execute(
                text(
                    "SELECT f.source_domain,f.event_type,f.actor_label,f.metadata,"
                    "f.source_row_id,c.counterpart_user_id FROM feed_events f "
                    "LEFT JOIN feed_event_counterparts c ON c.feed_event_id=f.id "
                    "WHERE f.user_id=:user ORDER BY f.id"
                ),
                {"user": user_id},
            ).mappings()
        ]


@pytest.mark.asyncio
async def test_share_request_reaches_owner_feed_naming_the_requester(feed, sharing):
    created = await request(sharing)

    [row] = feed_rows(feed.db, "owner")
    assert row["source_domain"] == "connected_systems"
    assert row["event_type"] == "document_share_request"
    assert row["actor_label"] == "Bo"
    assert row["counterpart_user_id"] == "recipient"
    # Plaintext Feed: ids, a status word and a label only. No purpose text.
    assert row["metadata"] == {
        "request_id": created["requestId"],
        "counterpart_label": "Bo",
        "user_facing_status": "pending",
    }
    assert "six-month" not in str(row)
    [sent] = feed_rows(feed.db, "recipient")
    assert sent["event_type"] == "document_share_request_sent"
    assert sent["actor_label"] == "Ada"
    assert sent["metadata"] == {
        "request_id": created["requestId"],
        "counterpart_label": "Ada",
        "feed_audience": "recipient",
        "user_facing_status": "pending",
    }


@pytest.mark.asyncio
async def test_question_and_decline_reach_each_side(feed):
    created = await ask(feed)
    [question] = feed_rows(feed.db, "owner")
    assert question["event_type"] == "document_share_question"
    assert question["actor_label"] == "Bo"
    assert "bank" not in str(question)

    await feed.deny(user_id="owner", request_id=created["requestId"], revision=created["revision"])
    [declined] = feed_rows(feed.db, "recipient")
    assert declined["event_type"] == "document_share_declined"
    assert declined["actor_label"] == "Ada"
    assert declined["counterpart_user_id"] == "owner"
    assert declined["metadata"]["feed_audience"] == "recipient"
    assert declined["metadata"]["request_id"] == created["requestId"]


@pytest.mark.asyncio
async def test_technical_display_name_falls_back_to_email_handle(feed, sharing):
    with feed.db.engine.begin() as connection:
        connection.exec_driver_sql(
            "UPDATE actor_identity_cache SET display_name='AbCdEfGhIjKlMnOpQrStUvWx12',"
            "email='bo.smith@example.invalid' WHERE user_id='recipient'"
        )
    await request(sharing)
    [row] = feed_rows(feed.db, "owner")
    assert row["actor_label"] == "bo.smith"

    # A full email set as the display name is narrowed to its handle.
    with feed.db.engine.begin() as connection:
        connection.exec_driver_sql(
            "UPDATE actor_identity_cache SET display_name='bo.smith@example.invalid' "
            "WHERE user_id='recipient'"
        )
    await ask(feed)
    assert feed_rows(feed.db, "owner")[-1]["actor_label"] == "bo.smith"

    with feed.db.engine.begin() as connection:
        connection.exec_driver_sql(
            "UPDATE actor_identity_cache SET email=NULL WHERE user_id='recipient'"
        )
    await ask(feed)
    unnamed = feed_rows(feed.db, "owner")[-1]
    assert unnamed["event_type"] == "document_share_question"
    assert unnamed["actor_label"] is None
    assert "counterpart_label" not in unnamed["metadata"]


@pytest.mark.asyncio
async def test_feed_failure_never_fails_the_share(feed, sharing):
    with feed.db.engine.begin() as connection:
        connection.exec_driver_sql("ALTER TABLE feed_events RENAME TO feed_events_gone")

    created = await request(sharing)

    with feed.db.engine.connect() as connection:
        events = connection.execute(
            text("SELECT event_type FROM drive_share_events WHERE request_id=:id"),
            {"id": created["requestId"]},
        ).scalars()
        assert list(events) == ["document_share_request", "document_share_request_sent"]


@pytest.mark.asyncio
async def test_replay_backfills_recent_events_exactly_once(feed, sharing):
    with feed.db.engine.begin() as connection:
        connection.exec_driver_sql(
            "DROP TRIGGER drive_share_events_feed_projection ON drive_share_events"
        )
    await request(sharing)
    assert feed_rows(feed.db, "owner") == []

    run_projection_migration(feed.db, times=3)

    rows = feed_rows(feed.db, "owner")
    assert [row["event_type"] for row in rows] == ["document_share_request"]
    assert rows[0]["counterpart_user_id"] == "recipient"
    assert [row["event_type"] for row in feed_rows(feed.db, "recipient")] == [
        "document_share_request_sent"
    ]


@pytest.mark.asyncio
async def test_payment_replay_preserves_newer_populated_feed_event_constraint(feed, sharing):
    await request(sharing)

    def snapshot():
        with feed.db.engine.connect() as connection:
            constraint = connection.execute(
                text("""SELECT oid, pg_get_constraintdef(oid)
                     FROM pg_constraint
                     WHERE conrelid='drive_share_events'::regclass
                       AND conname='drive_share_events_event_type_check'""")
            ).one()
            events = connection.execute(
                text("SELECT event_id,event_type FROM drive_share_events ORDER BY event_id")
            ).all()
        return constraint, events

    before = snapshot()
    assert {row.event_type for row in before[1]} == {
        "document_share_request",
        "document_share_request_sent",
    }
    # Negative control: the old replay constraint rejects this populated
    # schema. The savepoint rolls back the DDL and preserves the original OID.
    with feed.db.engine.connect() as connection:
        with pytest.raises(IntegrityError) as caught, connection.begin_nested():
            connection.exec_driver_sql(
                "ALTER TABLE drive_share_events DROP CONSTRAINT drive_share_events_event_type_check"
            )
            connection.exec_driver_sql("""ALTER TABLE drive_share_events
                ADD CONSTRAINT drive_share_events_event_type_check CHECK (event_type IN (
                  'document_share_request','document_share_review_ready','document_share_decided',
                  'document_share_outcome','document_share_revoked','document_share_revocation_outcome',
                  'document_share_payment_ready','document_share_payment_confirmed',
                  'document_share_payment_refunded'))""")
        assert caught.value.orig.pgcode == "23514"
        assert caught.value.orig.diag.constraint_name == "drive_share_events_event_type_check"
    assert snapshot() == before
    feed_before = {user: feed_rows(feed.db, user) for user in ("owner", "recipient")}
    for replay in range(2):
        with feed.db.engine.connect() as reader, feed.db.engine.connect() as connection:
            if replay:
                # The no-op replay must also work while a live Feed reader
                # holds the table: rewriting this needs ACCESS EXCLUSIVE.
                reader.exec_driver_sql("LOCK TABLE drive_share_events IN ACCESS SHARE MODE")
            with connection.connection.driver_connection.cursor() as cursor:
                cursor.execute("SET lock_timeout = '250ms'")
                cursor.execute(PAYMENT.read_text())
                cursor.execute(STREAM_PROJECTION.read_text())
            connection.commit()
        # OID equality proves the newer constraint was not dropped/recreated.
        assert snapshot() == before
        assert {user: feed_rows(feed.db, user) for user in ("owner", "recipient")} == feed_before
