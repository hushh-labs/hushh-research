"""Database trigger proof for the Direct Message recipient Feed projection."""

from __future__ import annotations

import os
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def projection_db():
    source = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not source:
        pytest.skip("An isolated PostgreSQL server is required.")
    url = make_url(source).set(drivername="postgresql+psycopg2")
    admin = create_engine(url, isolation_level="AUTOCOMMIT")
    name = "direct_message_feed_test_" + uuid.uuid4().hex
    with admin.connect() as connection:
        connection.execute(text(f'CREATE DATABASE "{name}"'))
    engine = create_engine(url.set(database=name))
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    """
                    CREATE TABLE actor_profiles (user_id TEXT PRIMARY KEY);
                    CREATE TABLE conversations (
                      id UUID PRIMARY KEY,
                      participant_a_user_id TEXT NOT NULL REFERENCES actor_profiles(user_id),
                      participant_b_user_id TEXT NOT NULL REFERENCES actor_profiles(user_id)
                    );
                    CREATE TABLE messages (
                      id UUID PRIMARY KEY,
                      conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                      sender_user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
                      content_ciphertext TEXT NOT NULL,
                      content_iv TEXT NOT NULL,
                      content_algorithm TEXT NOT NULL
                    );
                    CREATE TABLE feed_events (
                      id BIGSERIAL PRIMARY KEY,
                      user_id TEXT NOT NULL,
                      source_domain TEXT NOT NULL,
                      event_type TEXT NOT NULL,
                      actor_label TEXT,
                      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                      source_row_id TEXT,
                      read_at TIMESTAMPTZ,
                      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    );
                    CREATE UNIQUE INDEX uq_feed_events_source_projection
                      ON feed_events (user_id, source_domain, event_type, source_row_id)
                      WHERE source_row_id IS NOT NULL;
                    CREATE TABLE feed_event_counterparts (
                      feed_event_id BIGINT PRIMARY KEY REFERENCES feed_events(id) ON DELETE CASCADE,
                      counterpart_user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE
                    );
                    """
                )
            )
        raw = engine.raw_connection()
        raw.autocommit = True
        with raw.cursor() as cursor:
            migration = (
                ROOT / "db" / "migrations" / "268_direct_message_feed_projection.sql"
            ).read_text(encoding="utf-8")
            # A replay must retain the exact trigger wiring.
            cursor.execute(migration)
            cursor.execute(migration)
        raw.close()
        yield SimpleNamespace(engine=engine)
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.execute(text(f'DROP DATABASE "{name}" WITH (FORCE)'))
        admin.dispose()


def test_direct_message_insert_and_source_delete_keep_recipient_feed_in_lockstep(
    projection_db,
) -> None:
    conversation_id = str(uuid.uuid4())
    message_id = str(uuid.uuid4())
    with projection_db.engine.begin() as connection:
        connection.execute(text("INSERT INTO actor_profiles VALUES ('alice'), ('bob')"))
        connection.execute(
            text(
                """
                INSERT INTO conversations(id, participant_a_user_id, participant_b_user_id)
                VALUES (CAST(:conversation_id AS UUID), 'alice', 'bob')
                """
            ),
            {"conversation_id": conversation_id},
        )
        connection.execute(
            text(
                """
                INSERT INTO messages(
                  id, conversation_id, sender_user_id, content_ciphertext,
                  content_iv, content_algorithm
                )
                VALUES (
                  CAST(:message_id AS UUID), CAST(:conversation_id AS UUID),
                  'alice', 'opaque', 'opaque', 'aes-256-gcm-aad-v1'
                )
                """
            ),
            {"message_id": message_id, "conversation_id": conversation_id},
        )
        projection = (
            connection.execute(
                text(
                    """
                SELECT user_id, source_domain, event_type, actor_label, metadata, source_row_id
                FROM feed_events
                """
                )
            )
            .mappings()
            .all()
        )
        counterpart = connection.execute(
            text("SELECT counterpart_user_id FROM feed_event_counterparts")
        ).scalar_one()

        assert [dict(row) for row in projection] == [
            {
                "user_id": "bob",
                "source_domain": "connections",
                "event_type": "direct_message_received",
                "actor_label": None,
                "metadata": {},
                "source_row_id": message_id,
            }
        ]
        assert counterpart == "alice"

        connection.execute(
            text("DELETE FROM messages WHERE id = CAST(:message_id AS UUID)"),
            {"message_id": message_id},
        )
        assert connection.execute(text("SELECT count(*) FROM feed_events")).scalar_one() == 0
        assert (
            connection.execute(text("SELECT count(*) FROM feed_event_counterparts")).scalar_one()
            == 0
        )
