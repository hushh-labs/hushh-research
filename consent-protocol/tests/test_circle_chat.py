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
              CREATE TABLE one_location_circle_memberships(circle_id UUID REFERENCES one_location_circles(id) ON DELETE CASCADE, user_id TEXT REFERENCES actor_profiles(user_id) ON DELETE CASCADE, status TEXT DEFAULT 'active', joined_at TIMESTAMPTZ DEFAULT clock_timestamp(), PRIMARY KEY(circle_id,user_id));
              CREATE TABLE one_location_recipient_keys(user_id TEXT REFERENCES actor_profiles(user_id) ON DELETE CASCADE, key_id TEXT, public_key_jwk JSONB, encrypted_private_key_jwk JSONB, status TEXT DEFAULT 'active', created_at TIMESTAMPTZ DEFAULT now());
              CREATE TABLE feed_events(id BIGSERIAL PRIMARY KEY, user_id TEXT REFERENCES actor_profiles(user_id) ON DELETE CASCADE, source_domain TEXT, event_type TEXT, metadata JSONB, source_row_id TEXT, read_at TIMESTAMPTZ);
            """)
            )
        raw = engine.raw_connection()
        raw.autocommit = True
        with raw.cursor() as cursor:
            cursor.execute((ROOT / "db/migrations/201_account_deletion_tombstones.sql").read_text())
            for _ in range(2):
                cursor.execute((ROOT / "db/migrations/265_circle_chat.sql").read_text())
                cursor.execute(
                    (ROOT / "db/migrations/266_circle_chat_presentation.sql").read_text()
                )
        raw.close()
        yield SimpleNamespace(engine=engine)
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
        pushes, "send_user_data_push", lambda *args, **kwargs: calls.append((args, kwargs)) or 1
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
    assert all(call[1]["body"] == "You have a new circle message" for call in calls)
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
