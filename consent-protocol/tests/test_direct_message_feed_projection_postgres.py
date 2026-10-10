"""Database trigger proof for the Direct Message recipient Feed projection."""

from __future__ import annotations

import base64
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
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
                    CREATE TABLE actor_profiles (user_id TEXT PRIMARY KEY, public_person_ref UUID DEFAULT gen_random_uuid());
                    CREATE TABLE vault_keys(user_id TEXT PRIMARY KEY REFERENCES actor_profiles(user_id));
                    CREATE TABLE actor_identity_cache (user_id TEXT PRIMARY KEY REFERENCES actor_profiles(user_id), display_name TEXT, photo_url TEXT, custom_photo_url TEXT);
                    CREATE TABLE connections (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_a_id TEXT, user_b_id TEXT, status TEXT DEFAULT 'active', UNIQUE(user_a_id,user_b_id));
                    INSERT INTO connections(user_a_id,user_b_id) VALUES('alice','bob');
                    CREATE TABLE circle_chat_messages(id UUID PRIMARY KEY);
                    CREATE TABLE circle_chat_recipients(push_due_at TIMESTAMPTZ);
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
            for migration in [
                "012_user_push_tokens.sql",
                "201_account_deletion_tombstones.sql",
                "264_direct_messages.sql",
                "268_direct_message_feed_projection.sql",
                "282_direct_message_actions.sql",
                "284_direct_message_multiple_reactions.sql",
                "290_chat_push_delivery.sql",
            ]:
                sql = (ROOT / "db/migrations" / migration).read_text(encoding="utf-8")
                # Replay the actual production guards and projection wiring.
                cursor.execute(sql)
                cursor.execute(sql)
        raw.close()

        def execute_raw(sql, params):
            with engine.begin() as connection:
                result = connection.execute(text(sql), params)
                return SimpleNamespace(
                    data=[dict(row) for row in result.mappings()] if result.returns_rows else []
                )

        yield SimpleNamespace(engine=engine, execute_raw=execute_raw)
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


def _message_service(db, monkeypatch, events=None, pushes=None):
    from hushh_mcp.services.direct_messages_service import DirectMessagesService

    monkeypatch.setenv(
        "DIRECT_MESSAGE_ENCRYPTION_KEY_V1", base64.urlsafe_b64encode(b"m" * 32).decode()
    )
    return DirectMessagesService(
        db=db,
        event_notifier=lambda *args, **kwargs: events.append(args) if events is not None else None,
        push_notifier=lambda *args, **kwargs: pushes.append(args) if pushes is not None else None,
    )


def _seed_people(db):
    with db.engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO actor_profiles(user_id) VALUES('alice'),('bob'),('carol'),('outsider')"
            )
        )
        connection.execute(
            text(
                "INSERT INTO actor_identity_cache(user_id,display_name) SELECT user_id,user_id FROM actor_profiles"
            )
        )
        connection.execute(
            text(
                "INSERT INTO connections(user_a_id,user_b_id) VALUES('alice','carol'),('bob','carol')"
            )
        )


def test_concurrent_uuid_replay_commits_one_message_feed_and_push(projection_db, monkeypatch):
    _seed_people(projection_db)
    events, pushes = [], []
    barrier = Barrier(2)
    message_id = str(uuid.uuid4())

    def send():
        service = _message_service(projection_db, monkeypatch, events, pushes)
        barrier.wait(timeout=5)
        return service.send_message(
            "alice",
            recipient_user_id="bob",
            content="  Hello again  ",
            client_message_id=message_id,
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        first, second = list(executor.map(lambda _: send(), range(2)))
    assert first == second
    replay = _message_service(projection_db, monkeypatch, events, pushes).send_message(
        "alice", recipient_user_id="bob", content="Hello again", client_message_id=message_id
    )
    assert replay == first
    assert len(events) == len(pushes) == 1
    with projection_db.engine.connect() as connection:
        for table in ["messages", "conversations", "feed_events", "direct_message_push_outbox"]:
            assert connection.execute(text(f"SELECT count(*) FROM {table}")).scalar_one() == 1
        assert (
            "Hello again"
            not in connection.execute(text("SELECT content_ciphertext FROM messages")).scalar_one()
        )


def test_uuid_conflicts_do_not_replace_content_or_cross_recipient_authority(
    projection_db, monkeypatch
):
    from hushh_mcp.services.direct_messages_service import DirectMessagesError

    _seed_people(projection_db)
    service = _message_service(projection_db, monkeypatch)
    message_id = str(uuid.uuid4())
    sent = service.send_message(
        "alice", recipient_user_id="bob", content="Original", client_message_id=message_id
    )
    errors = []
    for sender, peer, content in [
        ("alice", "bob", "Changed"),
        ("alice", "carol", "Original"),
        ("bob", "alice", "Original"),
        ("bob", "carol", "Original"),
    ]:
        with pytest.raises(DirectMessagesError) as caught:
            service.send_message(
                sender, recipient_user_id=peer, content=content, client_message_id=message_id
            )
        errors.append((caught.value.code, caught.value.status_code, str(caught.value)))
    assert len(set(errors)) == 1
    assert errors[0][0:2] == ("DIRECT_MESSAGE_RETRY_CONFLICT", 409)
    with projection_db.engine.begin() as connection:
        assert connection.execute(text("SELECT count(*) FROM conversations")).scalar_one() == 1
        assert connection.execute(text("SELECT count(*) FROM messages")).scalar_one() == 1
        connection.execute(
            text(
                "INSERT INTO direct_message_blocks(blocker_user_id,blocked_user_id) VALUES('bob','alice')"
            )
        )
    with pytest.raises(DirectMessagesError) as blocked:
        service.send_message(
            "alice", recipient_user_id="bob", content="Original", client_message_id=message_id
        )
    assert blocked.value.status_code == 403
    with projection_db.engine.begin() as connection:
        connection.execute(text("DELETE FROM direct_message_blocks"))
        connection.execute(
            text(
                "UPDATE connections SET status='revoked' WHERE user_a_id='alice' AND user_b_id='bob'"
            )
        )
    with pytest.raises(DirectMessagesError) as revoked:
        service.send_message(
            "alice", recipient_user_id="bob", content="Original", client_message_id=message_id
        )
    assert revoked.value.status_code == 403
    assert (
        service.list_messages("alice", sent["conversation"]["id"])["items"][0]["content"]
        == "Original"
    )


def test_read_boundary_keeps_later_tied_messages_unread_and_handles_older_transaction(
    projection_db, monkeypatch
):
    from hushh_mcp.services.direct_messages_service import DirectMessagesError

    _seed_people(projection_db)
    sender = _message_service(projection_db, monkeypatch)
    reader = _message_service(projection_db, monkeypatch)
    first = sender.send_message("alice", recipient_user_id="bob", content="First")
    conversation = first["conversation"]["id"]
    tied_ids = [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
    ]
    with projection_db.engine.begin() as connection:
        timestamp = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
        for message_id in tied_ids:
            envelope = sender._cipher.seal(
                "Tied", conversation_id=conversation, message_id=message_id, sender_user_id="alice"
            )
            connection.execute(
                text("""INSERT INTO messages(id,conversation_id,sender_user_id,content_ciphertext,content_iv,content_algorithm,created_at)
              VALUES(CAST(:id AS UUID),CAST(:conversation AS UUID),'alice',:content_ciphertext,:content_iv,:content_algorithm,:created)"""),
                {"id": message_id, "conversation": conversation, "created": timestamp, **envelope},
            )
    own = reader.send_message("bob", recipient_user_id="alice", content="Own reply")
    result = reader.mark_as_read("bob", conversation, through_message_id=tied_ids[1])
    assert result["readCount"] == 3
    assert result["readThroughCreatedAt"] is not None
    with projection_db.engine.connect() as connection:
        unread = set(
            map(
                str,
                connection.execute(text("SELECT id FROM messages WHERE read_at IS NULL")).scalars(),
            )
        )
        assert unread == {tied_ids[2], own["message"]["id"]}
    foreign = sender.send_message("alice", recipient_user_id="carol", content="Other conversation")
    for viewer, boundary in [("outsider", tied_ids[2]), ("bob", foreign["message"]["id"])]:
        with pytest.raises(DirectMessagesError) as caught:
            reader.mark_as_read(viewer, conversation, through_message_id=boundary)
        assert caught.value.status_code == 404
    # Start a read transaction before a separate sender commits. NOW() would
    # violate migration264's read_at >= created_at; wall-clock receipt must pass.
    with reader._transaction() as connection:
        started = connection.execute(text("SELECT now()")).scalar_one()
        newest = sender.send_message(
            "alice", recipient_user_id="bob", content="Arrived after read transaction started"
        )
        result = reader.mark_as_read(
            "bob", conversation, through_message_id=newest["message"]["id"]
        )
        assert result["readCount"] == 2
        assert result["readAt"] > started.isoformat()


def test_reply_retry_preserves_original_target_and_rejects_changed_target(
    projection_db, monkeypatch
):
    from hushh_mcp.services.direct_messages_service import DirectMessagesError

    _seed_people(projection_db)
    service = _message_service(projection_db, monkeypatch)
    first = service.send_message("alice", recipient_user_id="bob", content="First")
    second = service.send_message("alice", recipient_user_id="bob", content="Second")
    message_id = str(uuid.uuid4())
    args = dict(
        recipient_user_id="bob",
        content="Reply",
        client_message_id=message_id,
        reply_to_message_id=first["message"]["id"],
    )
    reply = service.send_message("alice", **args)
    assert service.send_message("alice", **args) == reply
    with pytest.raises(DirectMessagesError) as caught:
        service.send_message("alice", **{**args, "reply_to_message_id": second["message"]["id"]})
    assert caught.value.status_code == 409


@pytest.mark.parametrize("scope", ["everyone", "me"])
def test_direct_push_skips_deleted_messages(projection_db, monkeypatch, scope):
    from firebase_admin import messaging

    from api.utils import firebase_admin as bootstrap
    from hushh_mcp.services import direct_message_notifications as worker

    _seed_people(projection_db)
    service = _message_service(projection_db, monkeypatch)
    sent = service.send_message("alice", recipient_user_id="bob", content="Deleted before delivery")
    service.delete_message(
        "alice" if scope == "everyone" else "bob",
        sent["conversation"]["id"],
        sent["message"]["id"],
        scope=scope,
    )
    with projection_db.engine.begin() as connection:
        connection.execute(text("UPDATE direct_message_push_outbox SET due_at=now()"))
        connection.execute(
            text(
                "INSERT INTO user_push_tokens(user_id,token,platform) VALUES('bob','fixture-device','android')"
            )
        )
    monkeypatch.setattr(worker, "get_db", lambda: projection_db)
    monkeypatch.setattr(bootstrap, "ensure_firebase_admin", lambda: (True, "fixture"))
    delivered = []
    monkeypatch.setattr(messaging, "send", lambda push: delivered.append(push))
    worker.dispatch_direct_message_pushes()
    assert delivered == []
    with projection_db.engine.connect() as connection:
        assert (
            connection.execute(text("SELECT status FROM direct_message_push_outbox")).scalar()
            == "suppressed"
        )
