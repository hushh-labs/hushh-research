"""Circle chat authority, retry and lifecycle contracts on isolated PostgreSQL.

The CI PostgreSQL role must be able to create a disposable database. No live
tables or credentials are used. ONE_COMMAND_TEST_DATABASE_URL is the existing
protocol CI service; local runs may point it at a disposable PostgreSQL server.
"""

from __future__ import annotations

import asyncio
import base64
import copy
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException, Response
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError

from api.middleware import require_vault_owner_token
from api.routes.one import circle_chat as chat_routes
from api.routes.one.circle_chat import MAX_REQUEST_BYTES, SendMessage, router
from hushh_mcp.services import circle_chat_notifications as pushes
from hushh_mcp.services.circle_chat_service import CircleChatError, CircleChatService

ROOT = Path(__file__).resolve().parents[1]


def _b64(size):
    return base64.urlsafe_b64encode(os.urandom(size)).decode().rstrip("=")


@pytest.fixture
def chat_db():
    source = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not source:
        pytest.skip("An isolated PostgreSQL server is required.")
    url = make_url(source).set(drivername="postgresql+psycopg2")
    admin = create_engine(url, isolation_level="AUTOCOMMIT")
    name = "chat_test_" + uuid.uuid4().hex
    with admin.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{name}"'))
    engine = create_engine(url.set(database=name))
    try:
        with engine.begin() as conn:
            conn.execute(
                text("""
              CREATE TABLE actor_profiles(user_id TEXT PRIMARY KEY);
              CREATE TABLE vault_keys(user_id TEXT PRIMARY KEY REFERENCES actor_profiles(user_id));
              CREATE TABLE actor_identity_cache(user_id TEXT PRIMARY KEY REFERENCES actor_profiles(user_id) ON DELETE CASCADE, display_name TEXT, photo_url TEXT, custom_photo_url TEXT);
              CREATE TABLE one_location_circles(id UUID PRIMARY KEY, owner_user_id TEXT REFERENCES actor_profiles(user_id) ON DELETE CASCADE, name TEXT, status TEXT DEFAULT 'active', is_system BOOLEAN DEFAULT false, system_kind TEXT, updated_at TIMESTAMPTZ DEFAULT now());
              CREATE TABLE one_location_circle_memberships(circle_id UUID REFERENCES one_location_circles(id) ON DELETE CASCADE, user_id TEXT REFERENCES actor_profiles(user_id) ON DELETE CASCADE, status TEXT DEFAULT 'active', joined_at TIMESTAMPTZ DEFAULT clock_timestamp(), metadata JSONB NOT NULL DEFAULT '{}'::jsonb, PRIMARY KEY(circle_id,user_id));
              CREATE TABLE one_location_recipient_keys(user_id TEXT REFERENCES actor_profiles(user_id) ON DELETE CASCADE, key_id TEXT, public_key_jwk JSONB, encrypted_private_key_jwk JSONB, status TEXT DEFAULT 'active', created_at TIMESTAMPTZ DEFAULT now());
              CREATE TABLE feed_events(id BIGSERIAL PRIMARY KEY, user_id TEXT REFERENCES actor_profiles(user_id) ON DELETE CASCADE, source_domain TEXT, event_type TEXT, metadata JSONB, source_row_id TEXT, read_at TIMESTAMPTZ);
              CREATE TABLE connections(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_a_id TEXT, user_b_id TEXT, status TEXT DEFAULT 'active');
              CREATE TABLE conversations(id UUID PRIMARY KEY, participant_a_user_id TEXT, participant_b_user_id TEXT);
              CREATE TABLE messages(id UUID PRIMARY KEY, conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE, sender_user_id TEXT,
                content_ciphertext TEXT, content_iv TEXT, content_algorithm TEXT, deleted_for_everyone_at TIMESTAMPTZ, deleted_for_recipient_at TIMESTAMPTZ, read_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now());
              CREATE TABLE direct_message_blocks(blocker_user_id TEXT, blocked_user_id TEXT);
            """)
            )
        raw = engine.raw_connection()
        raw.autocommit = True
        with raw.cursor() as cursor:
            cursor.execute((ROOT / "db/migrations/012_user_push_tokens.sql").read_text())
            cursor.execute((ROOT / "db/migrations/201_account_deletion_tombstones.sql").read_text())
            for _ in range(2):
                cursor.execute((ROOT / "db/migrations/265_circle_chat.sql").read_text())
                cursor.execute(
                    (ROOT / "db/migrations/266_circle_chat_presentation.sql").read_text()
                )
                cursor.execute((ROOT / "db/migrations/290_chat_push_delivery.sql").read_text())
                cursor.execute(
                    (ROOT / "db/migrations/293_circle_chat_reactions_events.sql").read_text()
                )
        raw.close()

        def execute_raw(sql, params):
            with engine.begin() as connection:
                return SimpleNamespace(
                    error=None,
                    data=[dict(row) for row in connection.execute(text(sql), params).mappings()],
                )

        yield SimpleNamespace(engine=engine, execute_raw=execute_raw)
    finally:
        engine.dispose()
        with admin.connect() as conn:
            conn.execute(text(f'DROP DATABASE "{name}" WITH (FORCE)'))
        admin.dispose()


def _seed(db):
    circle = str(uuid.uuid4())
    with db.engine.begin() as conn:
        conn.execute(
            text("INSERT INTO actor_profiles VALUES ('alice'),('bob'),('carol'),('outsider')")
        )
        conn.execute(
            text(
                "INSERT INTO actor_identity_cache(user_id,display_name) VALUES ('alice','Alice'),('bob','Bob'),('carol','Carol')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO one_location_circles(id,owner_user_id,name) VALUES(CAST(:circle AS uuid),'alice','Weekend')"
            ),
            {"circle": circle},
        )
        conn.execute(
            text(
                "INSERT INTO one_location_circle_memberships(circle_id,user_id) VALUES(CAST(:circle AS uuid),'alice'),(CAST(:circle AS uuid),'bob')"
            ),
            {"circle": circle},
        )
        for user in ["alice", "bob", "carol"]:
            conn.execute(
                text(
                    "INSERT INTO one_location_recipient_keys(user_id,key_id,public_key_jwk) VALUES(:user,:key,CAST(:jwk AS jsonb))"
                ),
                {"user": user, "key": f"key-{user}-123", "jwk": '{"kty":"EC","crv":"P-256"}'},
            )
    return circle


def _payload(service, circle, user="alice"):
    state = service.state(user, circle)
    return SendMessage.model_validate(
        {
            "clientMessageId": str(uuid.uuid4()),
            "rosterVersion": state["rosterVersion"],
            "ciphertext": _b64(32),
            "iv": _b64(12),
            "imageCiphertext": _b64(40),
            "imageIv": _b64(12),
            "recipients": [
                {
                    "userId": member["userId"],
                    "envelope": {
                        "algorithm": "ECDH-P256-AES256-GCM",
                        "recipientKeyId": member["keyId"],
                        "ciphertext": _b64(48),
                        "iv": _b64(12),
                        "senderEphemeralPublicKeyJwk": {
                            "kty": "EC",
                            "crv": "P-256",
                            "x": _b64(32),
                            "y": _b64(32),
                        },
                    },
                }
                for member in state["members"]
            ],
        }
    ).model_dump(mode="json")


def test_reactions_and_membership_events_follow_current_message_access(chat_db):
    service = CircleChatService(chat_db)
    circle = _seed(chat_db)
    sent = service.send("alice", circle, _payload(service, circle))
    message_id = sent["id"]

    assert service.react("bob", circle, message_id, "❤️", True)["reactions"] == [
        {"emoji": "❤️", "count": 1, "reactedByViewer": True}
    ]
    # PUT and DELETE remain safe to retry after a lost response.
    assert service.react("bob", circle, message_id, "❤️", True)["reactions"][0]["count"] == 1
    assert service.messages("alice", circle)["items"][0]["reactions"] == [
        {"emoji": "❤️", "count": 1, "reactedByViewer": False}
    ]
    assert service.react("alice", circle, message_id, "❤️", True)["reactions"][0]["count"] == 2
    assert service.react("bob", circle, message_id, "❤️", False)["reactions"][0]["count"] == 1
    assert service.react("bob", circle, message_id, "❤️", False)["reactions"][0]["count"] == 1
    updates = service.messages(
        "bob", circle, receipt_after=sent["sequence"] - 1, receipt_through=sent["sequence"]
    )["reactionUpdates"]
    assert updates == [
        {"id": message_id, "reactions": [{"emoji": "❤️", "count": 1, "reactedByViewer": False}]}
    ]

    with pytest.raises(CircleChatError) as bad_emoji:
        service.react("bob", circle, message_id, "💛", True)
    assert bad_emoji.value.status == 422
    with pytest.raises(CircleChatError):
        service.react("outsider", circle, message_id, "❤️", True)
    with chat_db.engine.begin() as conn:
        conn.execute(
            text("""INSERT INTO one_location_circle_memberships(circle_id,user_id,metadata)
          VALUES(CAST(:circle AS uuid),'carol','{"addedBy":"alice"}'::jsonb)"""),
            {"circle": circle},
        )
    assert service.messages("carol", circle)["items"] == []
    assert any(
        event["subjectName"] == "Carol" and event["actorName"] == "Alice"
        for event in service.messages("carol", circle)["events"]
    )
    with pytest.raises(CircleChatError):
        service.react("carol", circle, message_id, "❤️", True)

    with chat_db.engine.begin() as conn:
        conn.execute(
            text("""UPDATE one_location_circle_memberships SET status='removed'
          WHERE circle_id=CAST(:circle AS uuid) AND user_id='alice'"""),
            {"circle": circle},
        )
    assert service.messages("bob", circle)["items"][0]["reactions"] == []
    assert any(
        event["kind"] == "member_removed" and event["subjectName"] == "Alice"
        for event in service.messages("bob", circle)["events"]
    )
    with pytest.raises(CircleChatError):
        service.react("alice", circle, message_id, "❤️", True)


def test_membership_history_images_retries_read_and_erasure(chat_db):
    service = CircleChatService(chat_db)
    circle = _seed(chat_db)
    payload = _payload(service, circle)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: service.send("alice", circle, payload), range(4)))
    sent = results[0]
    assert len({message["id"] for message in results}) == 1
    assert service.state("bob", circle)["unreadCount"] == 1
    assert service.image("bob", circle, sent["id"])["ciphertext"] == payload["imageCiphertext"]
    assert service.messages("bob", circle)["items"][0]["senderName"] == "Alice"
    with chat_db.engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE one_location_recipient_keys SET status='rotated', encrypted_private_key_jwk='{\"ciphertext\":\"opaque-vault-backup\"}'::jsonb WHERE user_id='bob'"
            )
        )
    assert service.key("bob", circle, "key-bob-123")["keyId"] == "key-bob-123"
    with pytest.raises(CircleChatError):
        service.key("carol", circle, "key-bob-123")
    with chat_db.engine.begin() as conn:
        conn.execute(
            text("UPDATE one_location_recipient_keys SET status='active' WHERE user_id='bob'")
        )
    assert "imageCiphertext" not in service.messages("bob", circle)["items"][0]
    with pytest.raises(CircleChatError, match="no longer available"):
        service.image("outsider", circle, sent["id"])
    changed = copy.deepcopy(payload)
    changed["ciphertext"] = _b64(32)
    with pytest.raises(CircleChatError) as conflict:
        service.send("alice", circle, changed)
    assert conflict.value.code == "CIRCLE_CHAT_RETRY_CONFLICT"
    service.read("bob", circle, sent["sequence"])
    service.read("bob", circle, sent["sequence"])
    assert service.state("bob", circle)["unreadCount"] == 0
    with chat_db.engine.begin() as conn:
        assert (
            conn.execute(
                text("SELECT count(*) FROM feed_events WHERE read_at IS NOT NULL")
            ).scalar()
            == 1
        )
        conn.execute(
            text(
                "INSERT INTO one_location_circle_memberships(circle_id,user_id) VALUES(CAST(:circle AS uuid),'carol')"
            ),
            {"circle": circle},
        )
    assert service.messages("carol", circle)["items"] == []
    with pytest.raises(CircleChatError):
        service.image("carol", circle, sent["id"])
    with pytest.raises(CircleChatError) as stale:
        service.send("alice", circle, {**payload, "clientMessageId": str(uuid.uuid4())})
    assert stale.value.code == "CIRCLE_CHAT_ROSTER_CHANGED"
    next_message = service.send("alice", circle, _payload(service, circle))
    with chat_db.engine.begin() as conn:
        conn.execute(
            text("UPDATE one_location_circle_memberships SET status='left' WHERE user_id='bob'")
        )
    with pytest.raises(CircleChatError):
        service.messages("bob", circle)
    with chat_db.engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE one_location_circle_memberships SET status='active',joined_at=clock_timestamp() WHERE user_id='bob'"
            )
        )
    assert service.messages("bob", circle)["items"] == []
    # Negative control: breaking generation matching would expose this old wrap.
    with chat_db.engine.begin() as conn:
        assert (
            conn.execute(
                text("SELECT count(*) FROM circle_chat_recipients WHERE recipient_user_id='bob'")
            ).scalar()
            == 2
        )
    with pytest.raises(CircleChatError):
        service.image("bob", circle, next_message["id"])
    with pytest.raises(CircleChatError):
        service.key("bob", circle, "key-bob-123")
    latest = service.send("alice", circle, _payload(service, circle))
    assert [m["id"] for m in service.messages("bob", circle)["items"]] == [latest["id"]]
    with chat_db.engine.begin() as conn:
        conn.execute(text("DELETE FROM actor_profiles WHERE user_id='alice'"))
        assert conn.execute(text("SELECT count(*) FROM circle_chat_messages")).scalar() == 0
        assert conn.execute(text("SELECT count(*) FROM circle_chat_recipients")).scalar() == 0
        assert conn.execute(text("SELECT count(*) FROM feed_events")).scalar() == 0
        with pytest.raises(IntegrityError):
            conn.execute(text("INSERT INTO actor_profiles VALUES('alice')"))


def test_key_rotation_pagination_push_lease_and_soft_delete(chat_db, monkeypatch):
    service = CircleChatService(chat_db)
    circle = _seed(chat_db)
    payload = _payload(service, circle)
    with chat_db.engine.begin() as registering:
        registering.execute(
            text(
                "SELECT pg_advisory_xact_lock(hashtextextended('one-location-recipient-key:bob',0))"
            )
        )
        with pytest.raises(CircleChatError) as busy:
            service.send("alice", circle, payload)
        assert busy.value.code == "CIRCLE_CHAT_ROSTER_CHANGED"
    sent = [service.send("alice", circle, _payload(service, circle)) for _ in range(4)]
    page = service.messages("bob", circle, limit=2)
    assert page["hasMore"] and [m["id"] for m in page["items"]] == [m["id"] for m in sent[2:]]
    assert service.messages("bob", circle, before=sent[2]["sequence"], limit=2)["hasMore"] is False
    assert [
        m["id"]
        for m in service.messages("bob", circle, after=sent[0]["sequence"], limit=2)["items"]
    ] == [m["id"] for m in sent[1:3]]
    monkeypatch.setattr(pushes, "get_db", lambda: chat_db)
    calls = []
    monkeypatch.setattr(
        pushes, "deliver_chat_push", lambda *args, **kwargs: calls.append((args, kwargs)) or True
    )
    with chat_db.engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE circle_chat_recipients SET push_due_at=now() WHERE recipient_user_id='bob'"
            )
        )
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _: pushes.dispatch_circle_chat_pushes(), range(2)))
    assert len(calls) == 4  # disjoint leases, one generic push per message
    assert all(call[1]["kind"] == "location_circle_message" for call in calls)
    service.mute("bob", circle, True)
    service.send("alice", circle, _payload(service, circle))
    with chat_db.engine.begin() as conn:
        conn.execute(
            text("UPDATE circle_chat_recipients SET push_due_at=now() WHERE push_status='pending'")
        )
    pushes.dispatch_circle_chat_pushes()
    assert len(calls) == 4
    with chat_db.engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE circle_chat_recipients SET push_status='leased',push_attempts=5,push_due_at=now() WHERE recipient_user_id='bob'"
            )
        )
    service.mute("bob", circle, False)
    pushes.dispatch_circle_chat_pushes()
    with chat_db.engine.begin() as conn:
        assert (
            conn.execute(
                text("SELECT count(*) FROM circle_chat_recipients WHERE push_status='failed'")
            ).scalar()
            == 5
        )
        conn.execute(text("UPDATE one_location_circles SET status='deleted'"))
        assert conn.execute(text("SELECT count(*) FROM circle_chat_messages")).scalar() == 0
        assert conn.execute(text("SELECT count(*) FROM feed_events")).scalar() == 0
    raw = chat_db.engine.raw_connection()
    raw.autocommit = True
    with raw.cursor() as cursor:
        cursor.execute(
            (
                ROOT / "db/migrations/rollback/293_circle_chat_reactions_events.rollback.sql"
            ).read_text()
        )
        cursor.execute(
            (ROOT / "db/migrations/rollback/290_chat_push_delivery.rollback.sql").read_text()
        )
        cursor.execute(
            (ROOT / "db/migrations/rollback/266_circle_chat_presentation.rollback.sql").read_text()
        )
        cursor.execute((ROOT / "db/migrations/rollback/265_circle_chat.rollback.sql").read_text())
    raw.close()


def test_route_validation_does_not_echo_private_input():
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "alice"}
    client = TestClient(app)
    endpoint = f"/api/one/circles/{uuid.uuid4()}/chat/messages"
    response = client.post(endpoint, json={"ciphertext": "PRIVATE_INPUT_MUST_NOT_ECHO"})
    assert response.status_code == 422
    assert "PRIVATE_INPUT" not in response.text
    assert "no-store" in response.headers["cache-control"]
    assert (
        client.post(
            endpoint, content=b"{}", headers={"Content-Length": str(MAX_REQUEST_BYTES + 1)}
        ).status_code
        == 413
    )
    photo_endpoint = endpoint.removesuffix("/chat/messages") + "/photo"
    response = client.put(photo_endpoint, json={"photoUrl": {"PRIVATE_INPUT_MUST_NOT_ECHO": True}})
    assert response.status_code == 422 and "PRIVATE_INPUT" not in response.text
    assert "no-store" in response.headers["cache-control"]
    assert (
        client.put(photo_endpoint, content=b"{}", headers={"Content-Length": "430001"}).status_code
        == 413
    )


def test_reaction_route_rejects_unsupported_emoji_before_database_access():
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "alice"}
    client = TestClient(app)
    endpoint = (
        f"/api/one/circles/{uuid.uuid4()}/chat/messages/{uuid.uuid4()}/reactions/%F0%9F%92%9B"
    )
    response = client.put(endpoint)
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "CIRCLE_CHAT_REACTION_INVALID"
    assert "no-store" in response.headers["cache-control"]


def test_large_reconnect_gap_is_ordered_unique_and_independent_of_doorbell_delivery(
    chat_db, monkeypatch
):
    service = CircleChatService(chat_db)
    circle = _seed(chat_db)
    # A NOTIFY is a wake-up hint, never message storage. Losing every wake-up
    # must still leave an independently recoverable history beyond 5x40 pages.
    monkeypatch.setattr(service, "_notify", lambda *args: None)
    sent = [service.send("alice", circle, _payload(service, circle)) for _ in range(205)]
    assert service.revision("bob", circle)["latestSequence"] == sent[-1]["sequence"]
    recovered, cursor = [], 0
    while True:
        page = service.messages("bob", circle, after=cursor)
        recovered.extend(page["items"])
        if not page["hasMore"]:
            break
        cursor = page["items"][-1]["sequence"]
    assert [item["id"] for item in recovered] == [item["id"] for item in sent]
    assert len({item["sequence"] for item in recovered}) == 205
    with chat_db.engine.begin() as conn:
        conn.execute(
            text("UPDATE one_location_circle_memberships SET status='left' WHERE user_id='bob'")
        )
    with pytest.raises(CircleChatError) as lost:
        service.messages("bob", circle, after=cursor)
    assert lost.value.status == 404


@pytest.mark.asyncio
async def test_wait_reauthorizes_and_releases_disconnected_subscriptions(chat_db, monkeypatch):
    service = CircleChatService(chat_db)
    circle = _seed(chat_db)
    queue = asyncio.Queue()
    subscribed, removed = asyncio.Event(), []

    async def subscribe(user):
        subscribed.set()
        return queue

    async def unsubscribe(user, existing):
        removed.append(existing)

    disconnected = False

    async def is_disconnected():
        return disconnected

    monkeypatch.setattr(chat_routes, "CircleChatService", lambda: service)
    monkeypatch.setattr(chat_routes, "subscribe_consent_queue", subscribe)
    monkeypatch.setattr(chat_routes, "unsubscribe_consent_queue", unsubscribe)
    wait = chat_routes.chat_wait.__wrapped__
    request = SimpleNamespace(is_disconnected=is_disconnected)
    task = asyncio.create_task(
        wait(request, Response(), uuid.UUID(circle), after=0, owner={"user_id": "bob"})
    )
    await subscribed.wait()
    # A queued doorbell cannot grant access after membership ends.
    with chat_db.engine.begin() as conn:
        conn.execute(
            text("UPDATE one_location_circle_memberships SET status='left' WHERE user_id='bob'")
        )
    await queue.put({"circle_id": circle})
    with pytest.raises(HTTPException) as lost:
        await task
    assert lost.value.status_code == 404
    assert removed == [queue] and "bob" not in chat_routes._waiting
    with chat_db.engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE one_location_circle_memberships SET status='active',joined_at=clock_timestamp() WHERE user_id='bob'"
            )
        )
    subscribed.clear()
    task = asyncio.create_task(
        wait(request, Response(), uuid.UUID(circle), after=0, owner={"user_id": "bob"})
    )
    await subscribed.wait()
    disconnected = True
    with pytest.raises(HTTPException) as closed:
        await asyncio.wait_for(task, timeout=2)
    assert closed.value.status_code == 499
    assert removed == [queue, queue] and "bob" not in chat_routes._waiting
    disconnected = False
    subscribed.clear()
    task = asyncio.create_task(
        wait(request, Response(), uuid.UUID(circle), after=0, owner={"user_id": "bob"})
    )
    await subscribed.wait()
    await queue.put({"circle_id": circle, "type": "location_circle_chat_read"})
    assert await task == {
        "latestSequence": 0,
        "changed": True,
        "readChanged": True,
        "receiptsChanged": False,
        "photoChanged": False,
    }
    assert removed == [queue, queue, queue] and "bob" not in chat_routes._waiting


def test_receipts_are_sender_only_and_keep_original_audience_after_erasure(chat_db, monkeypatch):
    service = CircleChatService(chat_db)
    circle = _seed(chat_db)
    with chat_db.engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO one_location_circle_memberships(circle_id,user_id) VALUES(CAST(:circle AS uuid),'carol')"
            ),
            {"circle": circle},
        )
        conn.execute(
            text(
                "UPDATE actor_identity_cache SET photo_url='https://example.test/old.png', custom_photo_url='data:image/png;base64,custom' WHERE user_id='alice'"
            )
        )
    payload = _payload(service, circle)
    sent = service.send("alice", circle, payload)
    assert sent["senderPhotoUrl"] == "data:image/png;base64,custom"
    assert sent["receipt"] == {"recipientCount": 2, "readCount": 0}
    notices = []
    monkeypatch.setattr(service, "_notify", lambda *args: notices.append(args[1:]))
    service.read("bob", circle, sent["sequence"])
    assert any(
        event[0] == "alice" and event[-1] == "location_circle_chat_receipts" for event in notices
    )
    page = service.messages(
        "alice", circle, after=sent["sequence"], receipt_after=0, receipt_through=sent["sequence"]
    )
    assert page["items"] == [] and page["receipts"] == [
        {"id": sent["id"], "recipientCount": 2, "readCount": 1}
    ]
    assert (
        service.messages("bob", circle, receipt_after=0, receipt_through=sent["sequence"])[
            "receipts"
        ]
        == []
    )
    assert service.send("alice", circle, payload)["receipt"]["readCount"] == 1
    with chat_db.engine.begin() as conn:
        conn.execute(text("DELETE FROM actor_profiles WHERE user_id='carol'"))
    assert service.send("alice", circle, payload)["receipt"] == {
        "recipientCount": 2,
        "readCount": 1,
    }
    with chat_db.engine.begin() as conn:
        conn.execute(text("UPDATE circle_chat_messages SET original_recipient_count=NULL"))
    assert service.send("alice", circle, payload)["receipt"]["recipientCount"] is None


@pytest.mark.parametrize("rejoin", [False, True])
def test_old_receipts_do_not_notify_departed_or_rejoined_sender(chat_db, monkeypatch, rejoin):
    service = CircleChatService(chat_db)
    circle = _seed(chat_db)
    sent = service.send("bob", circle, _payload(service, circle, "bob"))
    with chat_db.engine.begin() as conn:
        conn.execute(
            text("UPDATE one_location_circle_memberships SET status='left' WHERE user_id='bob'")
        )
        if rejoin:
            conn.execute(
                text(
                    "UPDATE one_location_circle_memberships SET status='active', joined_at=clock_timestamp() WHERE user_id='bob'"
                )
            )
    notices = []
    monkeypatch.setattr(service, "_notify", lambda *args: notices.append(args[1:]))
    service.read("alice", circle, sent["sequence"])
    assert not any(event[0] == "bob" for event in notices)


def test_diverse_inline_avatars_cannot_overflow_a_transcript_page(chat_db):
    service = CircleChatService(chat_db)
    circle = _seed(chat_db)
    photo = "data:image/png;base64," + "A" * 400000
    with chat_db.engine.begin() as conn:
        for index in range(40):
            user = f"member-{index}"
            conn.execute(text("INSERT INTO actor_profiles VALUES(:user)"), {"user": user})
            conn.execute(
                text(
                    "INSERT INTO actor_identity_cache(user_id,display_name,photo_url) VALUES(:user,:user,:photo)"
                ),
                {"user": user, "photo": photo},
            )
            conn.execute(
                text(
                    "INSERT INTO one_location_circle_memberships(circle_id,user_id) VALUES(CAST(:circle AS uuid),:user)"
                ),
                {"circle": circle, "user": user},
            )
            conn.execute(
                text(
                    "INSERT INTO one_location_recipient_keys(user_id,key_id,public_key_jwk) VALUES(:user,:key,'{}')"
                ),
                {"user": user, "key": f"key-{user}-123"},
            )
    for index in range(40):
        user = f"member-{index}"
        service.send(user, circle, _payload(service, circle, user))
    page = service.messages("alice", circle)
    assert len(page["items"]) == 40 and len(page["senders"]) == 40
    assert sum(len(sender["photoUrl"] or "") for sender in page["senders"]) <= 2_000_000
    assert any(sender["photoUrl"] is None for sender in page["senders"])


def test_circle_photo_owner_access_validation_and_erasure(chat_db, monkeypatch):
    from hushh_mcp.services.one_location_circle_service import (
        OneLocationCircleError,
        OneLocationCircleService,
    )

    circle = _seed(chat_db)
    service = OneLocationCircleService(db=chat_db)

    # This fixture exercises real storage/authority; the unrelated bounded
    # overview projection has its existing canonical service tests.
    def overview(**kwargs):
        with chat_db.engine.connect() as conn:
            return {
                "id": circle,
                "photoUrl": conn.execute(
                    text(
                        "SELECT photo_url FROM one_location_circles WHERE id=CAST(:circle AS uuid)"
                    ),
                    {"circle": circle},
                ).scalar(),
            }

    monkeypatch.setattr(service, "get_circle_overview", overview)
    photo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC"
    assert (
        service.update_circle_photo(owner_user_id="alice", circle_id=circle, photo_url=photo)[
            "photoUrl"
        ]
        == photo
    )
    for user in ["bob", "outsider"]:
        with pytest.raises(OneLocationCircleError) as denied:
            service.update_circle_photo(owner_user_id=user, circle_id=circle, photo_url=None)
        assert denied.value.status_code == 403
    for invalid in [
        "https://example.test/icon.png",
        "data:image/svg+xml;base64,PHN2Zz4=",
        "data:image/png;base64,bm90YW5pbWFnZQ==",
    ]:
        with pytest.raises(OneLocationCircleError) as rejected:
            service.update_circle_photo(owner_user_id="alice", circle_id=circle, photo_url=invalid)
        assert rejected.value.status_code == 422
    assert (
        service.update_circle_photo(owner_user_id="alice", circle_id=circle, photo_url=None)[
            "photoUrl"
        ]
        is None
    )
    service.update_circle_photo(owner_user_id="alice", circle_id=circle, photo_url=photo)
    with chat_db.engine.begin() as conn:
        conn.execute(text("UPDATE one_location_circles SET system_kind='trusted'"))
    with pytest.raises(OneLocationCircleError):
        service.update_circle_photo(owner_user_id="alice", circle_id=circle, photo_url=None)
    with chat_db.engine.begin() as conn:
        conn.execute(text("UPDATE one_location_circles SET system_kind=NULL, status='deleted'"))
        assert conn.execute(text("SELECT photo_url FROM one_location_circles")).scalar() is None


def test_chat_push_device_ownership_retry_and_wire_budget(chat_db, monkeypatch):
    import json

    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from firebase_admin import messaging
    from firebase_admin.messaging import _MessagingService

    from api.utils import firebase_admin as firebase_bootstrap
    from hushh_mcp.services import push_tokens_service as tokens_module
    from hushh_mcp.services.chat_push_delivery import b64, deliver_chat_push

    _seed(chat_db)
    service = CircleChatService(db=chat_db)
    with chat_db.engine.connect() as conn:
        circle = str(conn.execute(text("SELECT id FROM one_location_circles")).scalar())
    message = service.send("alice", circle, _payload(service, circle))
    monkeypatch.setattr(tokens_module, "get_db", lambda: chat_db)
    monkeypatch.setattr(firebase_bootstrap, "ensure_firebase_admin", lambda: (True, "test"))
    key = ec.generate_private_key(ec.SECP256R1())
    public = b64(
        key.public_key().public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
        )
    )
    devices = [str(uuid.uuid4()), str(uuid.uuid4())]
    tokens = tokens_module.PushTokensService()
    for index, device in enumerate(devices):
        tokens.upsert_user_push_token(
            "bob",
            f"device-{index}",
            "ios",
            device_id=device,
            preview_key_id=str(uuid.uuid4()),
            preview_public_key=public,
        )
    attempts = []
    fail = True
    encoded = []

    def send(push):
        attempts.append(push.token)
        wire = _MessagingService.encode_message(push)
        encoded.append(wire)
        assert len(json.dumps(wire["apns"]["payload"], ensure_ascii=False).encode()) < 4096
        assert "sender_label" not in wire["data"]
        assert "circle_label" not in wire["data"]
        if push.token == "device-1" and fail:
            raise RuntimeError("synthetic transient transport failure")
        return "accepted"

    monkeypatch.setattr(messaging, "send", send)

    def deliver():
        return deliver_chat_push(
            chat_db,
            "bob",
            event_id=f"location_circle_message:{message['id']}",
            kind="location_circle_message",
            link=f"/one/connect?circleId={circle}",
            tag="fixture",
            context=f"circle:{circle}:fixture",
            data={
                "circle_id": circle,
                "sender_label": "😀" * 80,
                "circle_label": "😀" * 80,
                "sender_avatar": "data:image/jpeg;base64," + "A" * 1000,
            },
            preview_for=lambda _: "opaque" * 425,
            eligible=lambda renew, connection=None: True,
        )

    assert not deliver()
    fail = False
    assert deliver()
    assert attempts.count("device-0") == 1
    assert attempts.count("device-1") == 2
    # Stable installation acceptance survives same-owner token rotation.
    tokens.upsert_user_push_token("bob", "rotated-token", "ios", device_id=devices[0])
    assert deliver()
    assert "rotated-token" not in attempts
    # One installation switches account without an immutable-owner UPDATE.
    tokens.upsert_user_push_token("carol", "rotated-token", "ios", device_id=devices[0])
    with chat_db.engine.connect() as conn:
        assert (
            conn.execute(
                text("SELECT user_id FROM user_push_installations WHERE token='rotated-token'")
            ).scalar()
            == "carol"
        )
        assert (
            conn.execute(
                text("SELECT count(*) FROM user_push_installations WHERE user_id='bob'")
            ).scalar()
            == 1
        )
    assert deliver()
    assert "rotated-token" not in attempts


def test_push_registry_preserves_old_handlers_devices_and_rollback(chat_db, monkeypatch):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from firebase_admin import messaging

    from api.utils import firebase_admin as firebase_bootstrap
    from db import db_client
    from hushh_mcp.services import push_tokens_service as registry
    from hushh_mcp.services.push_notifications import send_user_data_push

    _seed(chat_db)
    monkeypatch.setattr(registry, "get_db", lambda: chat_db)
    monkeypatch.setattr(db_client, "get_db", lambda: chat_db)
    monkeypatch.setattr(firebase_bootstrap, "ensure_firebase_admin", lambda: (True, "test"))
    attempts = []
    monkeypatch.setattr(messaging, "send", lambda push: attempts.append(push.token) or "accepted")
    tokens = registry.PushTokensService()
    devices = [str(uuid.uuid4()), str(uuid.uuid4())]
    key_ids = [str(uuid.uuid4()), str(uuid.uuid4())]
    public = (
        base64.urlsafe_b64encode(
            ec.generate_private_key(ec.SECP256R1())
            .public_key()
            .public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        )
        .decode()
        .rstrip("=")
    )
    for i, device in enumerate(devices):
        tokens.upsert_user_push_token(
            "bob",
            f"rollout-device-{i}",
            "ios",
            device_id=device,
            preview_key_id=key_ids[i],
            preview_public_key=public,
        )
    assert (
        send_user_data_push(
            "bob",
            notification_type="connection_request",
            title="Request",
            body="Fixture",
            deep_link="/one/connect",
            notification_tag="fixture",
            notification_category="CONSENT_REQUEST",
        )
        == 2
    )
    assert sorted(attempts) == ["rollout-device-0", "rollout-device-1"]
    # The actual serving/rollback SQL, which does not run the new Python locks.
    old_sql = """INSERT INTO user_push_tokens(user_id,token,platform) VALUES(:user,:token,'ios')
      ON CONFLICT(user_id,platform) DO UPDATE SET token=EXCLUDED.token,updated_at=now()"""
    tokens.upsert_user_push_token(
        "bob",
        "rollout-device-0",
        "ios",
        device_id=devices[0],
        preview_key_id=str(uuid.uuid4()),
        preview_public_key=public,
    )
    with chat_db.engine.begin() as conn:
        conn.execute(text(old_sql), {"user": "bob", "token": "rollout-device-0"})
        assert conn.execute(
            text("""SELECT preview_key_id IS NULL AND preview_public_key IS NULL
          FROM user_push_installations WHERE token='rollout-device-0'""")
        ).scalar()
    with chat_db.engine.begin() as conn:
        conn.execute(text(old_sql), {"user": "carol", "token": "rollout-device-0"})
        assert (
            conn.execute(
                text("SELECT count(*) FROM user_push_installations WHERE token='rollout-device-0'")
            ).scalar()
            == 0
        )
    registry.remove_stale_push_token(chat_db, "bob", "rollout-device-0")
    assert chat_db.execute_raw(registry.PUSH_TOKENS_FOR_USER_SQL, {"user_id": "carol"}).data == [
        {"token": "rollout-device-0", "platform": "ios"}
    ]
    tokens.upsert_user_push_token("bob", "rollout-device-0", "ios", device_id=devices[0])
    assert not chat_db.execute_raw(registry.PUSH_TOKENS_FOR_USER_SQL, {"user_id": "carol"}).data
    assert tokens.delete_user_push_tokens("bob", device_id=devices[0]) == 1
    assert chat_db.execute_raw(registry.PUSH_TOKENS_FOR_USER_SQL, {"user_id": "bob"}).data == [
        {"token": "rollout-device-1", "platform": "ios"}
    ]
    assert chat_db.execute_raw(
        "SELECT token,platform FROM user_push_tokens WHERE user_id=:user_id", {"user_id": "bob"}
    ).data == [{"token": "rollout-device-1", "platform": "ios"}]
    with chat_db.engine.connect() as conn:
        assert (
            str(
                conn.execute(
                    text(
                        "SELECT preview_key_id FROM user_push_installations WHERE token='rollout-device-1'"
                    )
                ).scalar()
            )
            == key_ids[1]
        )
    tokens.upsert_user_push_token("bob", "before-account-rotation", "ios", device_id=devices[0])
    tokens.upsert_user_push_token("carol", "after-account-rotation", "ios", device_id=devices[0])
    assert chat_db.execute_raw(registry.PUSH_TOKENS_FOR_USER_SQL, {"user_id": "bob"}).data == [
        {"token": "rollout-device-1", "platform": "ios"}
    ]
    assert chat_db.execute_raw(
        "SELECT token,platform FROM user_push_tokens WHERE user_id=:user_id", {"user_id": "bob"}
    ).data == [{"token": "rollout-device-1", "platform": "ios"}]
    tokens.upsert_user_push_token("bob", "stale-shadow", "ios", device_id=devices[0])
    registry.remove_stale_push_token(chat_db, "bob", "stale-shadow")
    assert chat_db.execute_raw(
        "SELECT token,platform FROM user_push_tokens WHERE user_id=:user_id", {"user_id": "bob"}
    ).data == [{"token": "rollout-device-1", "platform": "ios"}]
    # Registration precedes profile/onboarding; deletion fences still apply.
    tokens.upsert_user_push_token(
        "fresh-user", "fresh-device", "android", device_id=str(uuid.uuid4())
    )
    with chat_db.engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO account_deletion_tombstones(user_id_hash) VALUES('sha256:' || encode(digest('fresh-user','sha256'),'hex'))"
            )
        )
    with pytest.raises(IntegrityError, match="delet|tombstone|closed"):
        tokens.upsert_user_push_token(
            "fresh-user", "fresh-device", "android", device_id=str(uuid.uuid4())
        )
    raw = chat_db.engine.raw_connection()
    raw.autocommit = True
    with raw.cursor() as cursor:
        cursor.execute(
            (ROOT / "db/migrations/rollback/290_chat_push_delivery.rollback.sql").read_text()
        )
    raw.close()
    with chat_db.engine.begin() as conn:
        conn.execute(text(old_sql), {"user": "carol", "token": "rollout-device-1"})
        assert (
            conn.execute(
                text("SELECT count(*) FROM user_push_installations WHERE token='rollout-device-1'")
            ).scalar()
            == 0
        )
    # Old account erasure knows only the original registry and root identities.
    tokens.upsert_user_push_token("carol", "old-erasure-device", "ios", device_id=str(uuid.uuid4()))
    with chat_db.engine.begin() as conn:
        conn.execute(text("DELETE FROM user_push_tokens WHERE user_id='carol'"))
        conn.execute(text("DELETE FROM actor_profiles WHERE user_id='carol'"))
        assert (
            conn.execute(
                text("SELECT count(*) FROM user_push_installations WHERE user_id='carol'")
            ).scalar()
            == 0
        )
    assert not chat_db.execute_raw(registry.PUSH_TOKENS_FOR_USER_SQL, {"user_id": "carol"}).data


def test_concurrent_old_and_new_registration_cannot_share_a_token(chat_db, monkeypatch):
    import time
    from threading import Event

    from sqlalchemy import event

    from hushh_mcp.services import push_tokens_service as registry

    _seed(chat_db)
    monkeypatch.setattr(registry, "get_db", lambda: chat_db)
    projected, release, old_started = Event(), Event(), Event()
    old_pid = []

    def pause_installation(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().startswith("INSERT INTO user_push_installations"):
            projected.set()
            assert release.wait(8)

    def old_register():
        with chat_db.engine.begin() as conn:
            conn.execute(text("SET LOCAL statement_timeout='8s'"))
            old_pid.append(conn.execute(text("SELECT pg_backend_pid()")).scalar())
            old_started.set()
            conn.execute(
                text("""INSERT INTO user_push_tokens(user_id,token,platform)
                  VALUES('carol','simultaneous-device','ios')
                  ON CONFLICT(user_id,platform) DO UPDATE SET token=EXCLUDED.token,updated_at=now()""")
            )

    event.listen(chat_db.engine, "before_cursor_execute", pause_installation)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            modern = pool.submit(
                registry.PushTokensService().upsert_user_push_token,
                "bob",
                "simultaneous-device",
                "ios",
                device_id=str(uuid.uuid4()),
            )
            assert projected.wait(5)
            legacy = pool.submit(old_register)
            try:
                assert old_started.wait(5)
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    with chat_db.engine.connect() as conn:
                        waiting = conn.execute(
                            text(
                                "SELECT wait_event_type='Lock' FROM pg_stat_activity WHERE pid=:pid"
                            ),
                            {"pid": old_pid[0]},
                        ).scalar()
                    if waiting:
                        break
                    time.sleep(0.02)
                assert waiting, "Legacy claim must wait on the uncommitted modern token fence"
            finally:
                release.set()
            assert modern.result(timeout=10)
            with pytest.raises(IntegrityError, match="user_push_tokens_token_owner"):
                legacy.result(timeout=10)
    finally:
        release.set()
        event.remove(chat_db.engine, "before_cursor_execute", pause_installation)
    assert not chat_db.execute_raw(registry.PUSH_TOKENS_FOR_USER_SQL, {"user_id": "carol"}).data
    # A fresh old-handler retry sees and safely revokes the committed old owner.
    old_register()
    assert not chat_db.execute_raw(registry.PUSH_TOKENS_FOR_USER_SQL, {"user_id": "bob"}).data
    assert chat_db.execute_raw(registry.PUSH_TOKENS_FOR_USER_SQL, {"user_id": "carol"}).data == [
        {"token": "simultaneous-device", "platform": "ios"}
    ]
    # Reverse order: a modern loser retries on a fresh transaction/owner snapshot.
    old_pending, commit_old = Event(), Event()

    def hold_old_claim():
        with chat_db.engine.begin() as conn:
            conn.execute(
                text("""INSERT INTO user_push_tokens(user_id,token,platform)
              VALUES('carol','reverse-device','ios') ON CONFLICT(user_id,platform)
              DO UPDATE SET token=EXCLUDED.token,updated_at=now()""")
            )
            old_pending.set()
            assert commit_old.wait(8)

    with ThreadPoolExecutor(max_workers=2) as pool:
        old_claim = pool.submit(hold_old_claim)
        assert old_pending.wait(5)
        new_claim = pool.submit(
            registry.PushTokensService().upsert_user_push_token,
            "bob",
            "reverse-device",
            "ios",
            device_id=str(uuid.uuid4()),
        )
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                with chat_db.engine.connect() as conn:
                    waiting = conn.execute(
                        text("""SELECT EXISTS(SELECT 1 FROM pg_stat_activity
                      WHERE wait_event_type='Lock' AND query LIKE '%reverse-device%')""")
                    ).scalar()
                if waiting:
                    break
                time.sleep(0.02)
            assert waiting, "Modern claim must meet the old uncommitted token fence"
        finally:
            commit_old.set()
        old_claim.result(timeout=10)
        assert new_claim.result(timeout=10)
    assert not chat_db.execute_raw(registry.PUSH_TOKENS_FOR_USER_SQL, {"user_id": "carol"}).data
    assert {
        row["token"]
        for row in chat_db.execute_raw(registry.PUSH_TOKENS_FOR_USER_SQL, {"user_id": "bob"}).data
    } == {"reverse-device"}


def test_old_registration_during_stale_provider_call_does_not_deadlock(chat_db, monkeypatch):
    from threading import Event

    from firebase_admin import messaging

    from api.utils import firebase_admin as firebase_bootstrap
    from hushh_mcp.services import push_tokens_service as registry
    from hushh_mcp.services.chat_push_delivery import deliver_chat_push

    _seed(chat_db)
    service = CircleChatService(db=chat_db)
    with chat_db.engine.connect() as conn:
        circle = str(conn.execute(text("SELECT id FROM one_location_circles")).scalar())
    message = service.send("alice", circle, _payload(service, circle))
    monkeypatch.setattr(registry, "get_db", lambda: chat_db)
    monkeypatch.setattr(firebase_bootstrap, "ensure_firebase_admin", lambda: (True, "test"))
    registry.PushTokensService().upsert_user_push_token(
        "bob", "concurrent-device", "ios", device_id=str(uuid.uuid4())
    )
    sending, transferred, release = Event(), Event(), Event()

    def stale(push):
        sending.set()
        assert release.wait(5)
        raise messaging.UnregisteredError("synthetic stale token")

    def transfer():
        with chat_db.engine.begin() as conn:
            conn.execute(text("SET LOCAL statement_timeout='8s'"))
            transferred.set()
            conn.execute(
                text("""INSERT INTO user_push_tokens(user_id,token,platform) VALUES('carol','concurrent-device','ios')
              ON CONFLICT(user_id,platform) DO UPDATE SET token=EXCLUDED.token,updated_at=now()""")
            )

    monkeypatch.setattr(messaging, "send", stale)
    with ThreadPoolExecutor(max_workers=2) as pool:
        delivery = pool.submit(
            deliver_chat_push,
            chat_db,
            "bob",
            event_id=f"location_circle_message:{message['id']}",
            kind="location_circle_message",
            link="/one/connect",
            tag="fixture",
            context="fixture",
            data={},
            preview_for=lambda _: None,
        )
        assert sending.wait(5)
        old_registration = pool.submit(transfer)
        assert transferred.wait(5)
        release.set()
        assert delivery.result(timeout=10)
        old_registration.result(timeout=10)
    assert chat_db.execute_raw(registry.PUSH_TOKENS_FOR_USER_SQL, {"user_id": "carol"}).data == [
        {"token": "concurrent-device", "platform": "ios"}
    ]
    assert not chat_db.execute_raw(registry.PUSH_TOKENS_FOR_USER_SQL, {"user_id": "bob"}).data


def test_old_same_owner_registration_waits_before_account_erasure_rows(chat_db, monkeypatch):
    import time
    from threading import Event

    from hushh_mcp.services import push_tokens_service as registry

    _seed(chat_db)
    monkeypatch.setattr(registry, "get_db", lambda: chat_db)
    registry.PushTokensService().upsert_user_push_token(
        "bob", "erasure-device", "ios", device_id=str(uuid.uuid4())
    )
    started, old_pid = Event(), []

    def old_register():
        with chat_db.engine.begin() as conn:
            conn.execute(text("SET LOCAL statement_timeout='8s'"))
            old_pid.append(conn.execute(text("SELECT pg_backend_pid()")).scalar())
            started.set()
            conn.execute(
                text("""INSERT INTO user_push_tokens(user_id,token,platform)
                  VALUES('bob','erasure-device','ios') ON CONFLICT(user_id,platform)
                  DO UPDATE SET token=EXCLUDED.token,updated_at=now()""")
            )

    with ThreadPoolExecutor(max_workers=1) as pool:
        with chat_db.engine.begin() as erasure:
            erasure.execute(text("SELECT pg_advisory_xact_lock(hashtextextended('bob',171))"))
            erasure.execute(text("SELECT pg_advisory_xact_lock(hashtextextended('bob',198))"))
            registration = pool.submit(old_register)
            assert started.wait(5)
            deadline = time.monotonic() + 5
            waiting = False
            while time.monotonic() < deadline:
                with chat_db.engine.connect() as conn:
                    waiting = conn.execute(
                        text("SELECT wait_event='advisory' FROM pg_stat_activity WHERE pid=:pid"),
                        {"pid": old_pid[0]},
                    ).scalar()
                if waiting:
                    break
                time.sleep(0.02)
            assert waiting, "Old registration must wait on the canonical lifecycle guard"
            # With the bridge before the guard, the old INSERT locks an installation
            # row first and this real root deletion deadlocks. No time-based sleep.
            erasure.execute(text("SET LOCAL statement_timeout='3s'"))
            erasure.execute(text("DELETE FROM actor_profiles WHERE user_id='bob'"))
        with pytest.raises(IntegrityError, match="deleted"):
            registration.result(timeout=10)
    assert not chat_db.execute_raw(registry.PUSH_TOKENS_FOR_USER_SQL, {"user_id": "bob"}).data


def test_direct_push_transaction_queue_read_block_and_expiry(chat_db, monkeypatch):
    from firebase_admin import messaging

    from api.utils import firebase_admin as firebase_bootstrap
    from hushh_mcp.services import direct_message_notifications as direct_push
    from hushh_mcp.services.direct_messages_service import DirectMessageCipher

    _seed(chat_db)
    monkeypatch.setenv("DIRECT_MESSAGE_ENCRYPTION_KEY_V1", _b64(32))
    monkeypatch.setattr(direct_push, "get_db", lambda: chat_db)
    monkeypatch.setattr(firebase_bootstrap, "ensure_firebase_admin", lambda: (True, "test"))
    sent = []
    monkeypatch.setattr(messaging, "send", lambda push: sent.append(push) or "accepted")
    conversation = str(uuid.uuid4())
    with chat_db.engine.begin() as conn:
        conn.execute(
            text("INSERT INTO conversations VALUES (:id,'alice','bob')"), {"id": conversation}
        )
        conn.execute(text("INSERT INTO connections(user_a_id,user_b_id) VALUES ('alice','bob')"))
        conn.execute(
            text(
                "INSERT INTO user_push_tokens(user_id,token,platform) VALUES ('bob','legacy-device','android')"
            )
        )
    ids = []
    for _ in range(4):
        message = str(uuid.uuid4())
        ids.append(message)
        sealed = DirectMessageCipher().seal(
            "Private fixture",
            conversation_id=conversation,
            message_id=message,
            sender_user_id="alice",
        )
        with chat_db.engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO messages(id,conversation_id,sender_user_id,content_ciphertext,content_iv,content_algorithm) VALUES (:id,:conversation,'alice',:content_ciphertext,:content_iv,:content_algorithm)"
                ),
                {"id": message, "conversation": conversation, **sealed},
            )
    with chat_db.engine.begin() as conn:
        conn.execute(text("UPDATE messages SET read_at=now() WHERE id=:id"), {"id": ids[0]})
        conn.execute(
            text("UPDATE messages SET created_at=now()-interval '2 days' WHERE id=:id"),
            {"id": ids[1]},
        )
        conn.execute(
            text("UPDATE direct_message_push_outbox SET due_at=now() WHERE message_id<>:id"),
            {"id": ids[3]},
        )
    direct_push.dispatch_direct_message_pushes()
    assert len(sent) == 1
    assert sent[0].data["message_id"] == f"direct-message:{ids[2]}"
    assert sent[0].notification is not None  # Legacy Android still receives OS alerts.
    assert "chat_preview" not in sent[0].data
    with chat_db.engine.begin() as conn:
        conn.execute(text("INSERT INTO direct_message_blocks VALUES ('bob','alice')"))
        conn.execute(
            text("UPDATE direct_message_push_outbox SET due_at=now() WHERE message_id=:id"),
            {"id": ids[3]},
        )
    direct_push.dispatch_direct_message_pushes()
    assert len(sent) == 1
    with chat_db.engine.connect() as conn:
        states = dict(
            conn.execute(
                text("SELECT message_id::text,status FROM direct_message_push_outbox")
            ).all()
        )
    assert states == {
        ids[0]: "suppressed",
        ids[1]: "suppressed",
        ids[2]: "sent",
        ids[3]: "suppressed",
    }
