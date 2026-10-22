"""Actual PostgreSQL proof of card provenance, transactional delivery and isolation."""

import base64
import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import text
from test_direct_message_feed_projection_postgres import projection_db  # noqa: F401

from hushh_mcp.services import wallet_card_access_service as module
from hushh_mcp.services.wallet_card_access_service import (
    WalletCardAccessError,
    WalletCardAccessService,
)


@pytest.fixture
def legacy_cards_db(projection_db, monkeypatch):  # noqa: F811 - imported pytest fixture
    monkeypatch.setenv("WALLET_CARD_ACCESS_ENABLED", "true")
    monkeypatch.setenv("ONE_WALLET_CARD_ENABLED", "true")
    monkeypatch.setenv(
        "DIRECT_MESSAGE_ENCRYPTION_KEY_V1", base64.urlsafe_b64encode(b"t" * 32).decode()
    )
    with projection_db.engine.begin() as conn:
        conn.execute(
            text("""
CREATE TABLE pkm_manifests(user_id text,domain text,manifest_version integer,summary_projection jsonb,PRIMARY KEY(user_id,domain));
CREATE TABLE pkm_domain_commits(commit_id uuid PRIMARY KEY,user_id text,domain text,commit_kind text,result_manifest_revision integer);
CREATE TABLE one_location_circles(id uuid PRIMARY KEY,owner_user_id text,system_kind text,status text);
CREATE TABLE one_location_circle_memberships(circle_id uuid,user_id text,status text,metadata jsonb);
ALTER TABLE actor_identity_cache ADD COLUMN email text;
INSERT INTO actor_profiles(user_id) VALUES('alice'),('bob'),('charu'),('outsider');
INSERT INTO actor_identity_cache(user_id,display_name) VALUES('alice','Divya'),('bob','Rupman'),('charu','Charu');
INSERT INTO connections(user_a_id,user_b_id) VALUES('alice','charu');
INSERT INTO one_location_circles VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','alice','trusted','active');
INSERT INTO one_location_circle_memberships VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','charu','active','{"addedVia":"direct_add","addedBy":"alice"}');
""")
        )
    projection_db.apply_migrations(["302_wallet_temporary_card_access.sql"])
    projection_db.apply_migrations(["302_wallet_temporary_card_access.sql"])
    return projection_db, WalletCardAccessService(db=projection_db)


@pytest.fixture
def cards_db(legacy_cards_db):
    db, service = legacy_cards_db
    db.apply_migrations(
        [
            "132_one_wallet_card.sql",
            "322_wallet_universal_sharing.sql",
            "323_wallet_sharing_owner_index.sql",
            "324_wallet_sharing_recipient_index.sql",
            "325_wallet_sharing_audit_index.sql",
            "330_wallet_share_longer_durations.sql",
        ]
    )
    db.apply_migrations(["322_wallet_universal_sharing.sql"])
    return db, service


def save(db, card_id, revision=1):
    from hushh_mcp.services.personal_knowledge_model_service import PersonalKnowledgeModelService
    from hushh_mcp.services.wallet_card_access_projection import wallet_manifest_source

    entry = {
        "card_id": card_id,
        "brand": "visa",
        "last4": "4242",
        "expiry_month": 4,
        "expiry_year": 2030,
        "issuing_region": "US",
    }
    summary = {"card_count": 1, "cards": [entry]}
    manifest = {
        "summary_projection": PersonalKnowledgeModelService._sanitize_manifest_summary_projection(
            summary
        )
    }
    assert "cards" not in manifest["summary_projection"]
    wallet_manifest_source("alice", "wallet", summary, manifest)
    with db.engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO pkm_manifests VALUES('alice','wallet',:revision,CAST(:summary AS jsonb)) ON CONFLICT(user_id,domain) DO UPDATE SET manifest_version=EXCLUDED.manifest_version,summary_projection=EXCLUDED.summary_projection"
            ),
            {"revision": revision, "summary": json.dumps(manifest["summary_projection"])},
        )
        conn.execute(
            text(
                "INSERT INTO pkm_domain_commits VALUES(CAST(:id AS uuid),'alice','wallet','mutation',:revision)"
            ),
            {"id": str(uuid.uuid4()), "revision": revision},
        )


def active_card(db, service):
    card = service.reserve("alice", str(uuid.uuid4()))["cardId"]
    assert not service.card_access("alice", card)["eligible"]
    save(db, card)
    assert service.card_access("alice", card)["eligible"]
    return card


def refs(db):
    return [
        str(row["public_person_ref"])
        for row in db.execute_raw(
            "SELECT public_person_ref FROM actor_profiles WHERE user_id IN('bob','charu') ORDER BY user_id",
            {},
        ).data
    ]


@pytest.fixture
def incoming_requests(cards_db):
    from hushh_mcp.services.wallet_card_request_service import WalletCardRequestService

    db, shares = cards_db
    db.apply_migrations(["351_wallet_card_requests.sql"])
    db.apply_migrations(["351_wallet_card_requests.sql"])
    with db.engine.begin() as conn:
        conn.execute(
            text("ALTER TABLE feed_events ADD COLUMN IF NOT EXISTS dismissed_at timestamptz")
        )
    return db, shares, WalletCardRequestService(db=db)


def test_card_request_is_metadata_only_targeted_and_not_folded_into_later_messages(
    incoming_requests,
):
    from hushh_mcp.services.direct_messages_service import DirectMessagesService
    from hushh_mcp.services.feed_service import FeedService

    db, _, requests = incoming_requests
    target = str(
        db.execute_raw(
            "SELECT public_person_ref FROM actor_profiles WHERE user_id='alice'", {}
        ).data[0]["public_person_ref"]
    )
    client_id = str(uuid.uuid4())
    result = requests.create("bob", target, client_id)
    assert requests.create("bob", target, client_id) == result
    with pytest.raises(WalletCardAccessError, match="PENDING"):
        requests.create("bob", target, str(uuid.uuid4()))
    assert result["role"] == "requester"
    assert requests.get("alice", result["id"])["role"] == "owner"
    with pytest.raises(WalletCardAccessError, match="NOT_FOUND"):
        requests.get("charu", result["id"])
    assert (
        db.execute_raw("SELECT count(*) AS n FROM wallet_card_access_grants", {}).data[0]["n"] == 0
    )
    DirectMessagesService(db=db).send_message(
        "bob", recipient_user_id="alice", content="Later ordinary message"
    )
    feed = FeedService()
    feed._db = db
    rows = db.execute_raw(
        feed._grouped_feed_sql(count=False), {"user_id": "alice", "page_size": 20, "cursor": None}
    ).data
    items = [feed._to_item(row) for row in feed._with_wallet_card_requests("alice", rows)]
    assert len(items) == 2
    assert (
        sum(item["metadata"].get("wallet_card_request_id") == result["id"] for item in items) == 1
    )
    # A forged marker/metadata is a locator only, never an authenticated ask.
    fake = dict(
        rows[0],
        metadata={
            "wallet_card_request_id": str(uuid.uuid4()),
            "wallet_card_request_status": "pending",
        },
    )
    assert "wallet_card_request_id" not in feed._to_item(fake)["metadata"]
    assert all(
        "wallet_card_request_id" not in feed._to_item(row)["metadata"]
        for row in feed._with_wallet_card_requests("charu", rows)
    )


@pytest.mark.parametrize("source", ["payment", "profile"])
def test_card_response_binds_owner_recipient_and_retry_and_keeps_existing_verification(
    incoming_requests,
    source,
):
    db, shares, requests = incoming_requests
    from test_wallet_universal_sharing_postgres import profile

    card = active_card(db, shares) if source == "payment" else profile(db)
    target = str(
        db.execute_raw(
            "SELECT public_person_ref FROM actor_profiles WHERE user_id='alice'", {}
        ).data[0]["public_person_ref"]
    )
    result = requests.create("bob", target, str(uuid.uuid4()))
    bob, charu = refs(db)
    for owner, recipients in [("charu", [bob]), ("alice", [charu]), ("alice", [bob, charu])]:
        with pytest.raises(WalletCardAccessError):
            shares.create_grants(
                owner, card, str(uuid.uuid4()), recipients, 15, card_request_id=result["id"]
            )
    replay = str(uuid.uuid4())
    sent = shares.create_grants("alice", card, replay, [bob], 15, card_request_id=result["id"])
    assert (
        shares.create_grants("alice", card, replay, [bob], 15, card_request_id=result["id"]) == sent
    )
    assert requests.get("alice", result["id"])["status"] == "fulfilled"
    assert shares.view_grant("bob", sent["grants"][0]["id"])["status"] == "verification_required"
    with pytest.raises(WalletCardAccessError, match="RETRY_CONFLICT"):
        shares.create_grants("alice", card, replay, [bob], 15)
    with pytest.raises(WalletCardAccessError, match="CLOSED"):
        shares.create_grants(
            "alice", card, str(uuid.uuid4()), [bob], 15, card_request_id=result["id"]
        )
    assert (
        db.execute_raw(
            "SELECT count(*) AS n FROM "
            + (
                "wallet_card_access_grants"
                if source == "payment"
                else "wallet_profile_access_grants"
            ),
            {},
        ).data[0]["n"]
        == 1
    )
    assert (
        db.execute_raw("SELECT read_at FROM feed_events WHERE user_id='alice'", {}).data[0][
            "read_at"
        ]
        is not None
    )


def test_failed_response_rolls_back_request_grant_message_feed_and_outbox(
    incoming_requests, monkeypatch
):
    import hushh_mcp.services.wallet_card_request_service as request_module

    db, shares, requests = incoming_requests
    card = active_card(db, shares)
    target = str(
        db.execute_raw(
            "SELECT public_person_ref FROM actor_profiles WHERE user_id='alice'", {}
        ).data[0]["public_person_ref"]
    )
    result = requests.create("bob", target, str(uuid.uuid4()))
    tables = (
        "messages",
        "feed_events",
        "direct_message_push_outbox",
        "wallet_card_access_grants",
        "wallet_card_share_requests",
    )
    before = [
        db.execute_raw(f"SELECT count(*) AS n FROM {table}", {}).data[0]["n"] for table in tables
    ]

    def fail(*_):
        raise RuntimeError("synthetic transaction failure")

    monkeypatch.setattr(request_module, "resolve_request_feed", fail)
    with pytest.raises(RuntimeError, match="synthetic"):
        shares.create_grants(
            "alice", card, str(uuid.uuid4()), [refs(db)[0]], 15, card_request_id=result["id"]
        )
    assert requests.get("alice", result["id"])["status"] == "pending"
    assert [
        db.execute_raw(f"SELECT count(*) AS n FROM {table}", {}).data[0]["n"] for table in tables
    ] == before


def test_card_request_decisions_are_participant_specific_terminal_and_revocable_by_requester(
    incoming_requests,
):
    from sqlalchemy.exc import DBAPIError

    db, shares, requests = incoming_requests
    card = active_card(db, shares)
    target = str(
        db.execute_raw(
            "SELECT public_person_ref FROM actor_profiles WHERE user_id='alice'", {}
        ).data[0]["public_person_ref"]
    )
    for action, actor in [("declined", "alice"), ("cancelled", "bob")]:
        result = requests.create("bob", target, str(uuid.uuid4()))
        with pytest.raises(WalletCardAccessError):
            requests.decide("charu", result["id"], action)
        with pytest.raises(WalletCardAccessError):
            requests.decide("bob" if actor == "alice" else "alice", result["id"], action)
        assert requests.decide(actor, result["id"], action)["status"] == action
        assert requests.decide(actor, result["id"], action)["status"] == action
        with pytest.raises(WalletCardAccessError, match="CLOSED"):
            shares.create_grants(
                "alice", card, str(uuid.uuid4()), [refs(db)[0]], 15, card_request_id=result["id"]
            )
        with pytest.raises(DBAPIError, match="IMMUTABLE"):
            with db.engine.begin() as conn:
                conn.execute(
                    text(
                        "UPDATE wallet_card_requests SET status='pending',resolved_at=NULL WHERE id=CAST(:id AS uuid)"
                    ),
                    {"id": result["id"]},
                )


def test_deleting_a_request_prevents_fulfillment_and_allows_a_replacement(incoming_requests):
    from hushh_mcp.services.direct_messages_service import DirectMessagesService

    db, shares, requests = incoming_requests
    card = active_card(db, shares)
    target = str(
        db.execute_raw(
            "SELECT public_person_ref FROM actor_profiles WHERE user_id='alice'", {}
        ).data[0]["public_person_ref"]
    )
    previous = requests.create("bob", target, str(uuid.uuid4()))
    row = db.execute_raw(
        "SELECT m.id,m.conversation_id FROM messages m JOIN wallet_card_requests r ON r.message_id=m.id WHERE r.id=CAST(:id AS uuid)",
        {"id": previous["id"]},
    ).data[0]
    DirectMessagesService(db=db).delete_message(
        "bob", str(row["conversation_id"]), str(row["id"]), scope="everyone"
    )
    with pytest.raises(WalletCardAccessError, match="NOT_FOUND"):
        shares.create_grants(
            "alice", card, str(uuid.uuid4()), [refs(db)[0]], 15, card_request_id=previous["id"]
        )
    replacement = requests.create("bob", target, str(uuid.uuid4()))
    assert replacement["id"] != previous["id"] and replacement["status"] == "pending"
    assert (
        db.execute_raw(
            "SELECT status FROM wallet_card_requests WHERE id=CAST(:id AS uuid)",
            {"id": previous["id"]},
        ).data[0]["status"]
        == "cancelled"
    )


@pytest.mark.parametrize("deletion", ["hard", "everyone", "recipient"])
def test_source_deletion_waits_for_a_response_that_already_locked_the_message(
    incoming_requests, monkeypatch, deletion
):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    import hushh_mcp.services.wallet_card_request_service as request_module

    db, shares, requests = incoming_requests
    card = active_card(db, shares)
    target = str(
        db.execute_raw(
            "SELECT public_person_ref FROM actor_profiles WHERE user_id='alice'", {}
        ).data[0]["public_person_ref"]
    )
    pending = requests.create("bob", target, str(uuid.uuid4()))
    locked, resume, deleting, deleted = Event(), Event(), Event(), Event()
    original = request_module.lock_card_request

    def hold(*args):
        result = original(*args)
        locked.set()
        assert resume.wait(5)
        return result

    monkeypatch.setattr(request_module, "lock_card_request", hold)

    def delete_source():
        with db.engine.begin() as conn:
            conn.execute(text("SET LOCAL lock_timeout='4s'"))
            deleting.set()
            conn.execute(
                text(
                    (
                        "DELETE FROM messages"
                        if deletion == "hard"
                        else "UPDATE messages SET "
                        + (
                            "deleted_for_everyone_at"
                            if deletion == "everyone"
                            else "deleted_for_recipient_at"
                        )
                        + "=clock_timestamp()"
                    )
                    + " WHERE id=(SELECT message_id FROM wallet_card_requests WHERE id=CAST(:id AS uuid))"
                ),
                {"id": pending["id"]},
            )
        deleted.set()

    with ThreadPoolExecutor(max_workers=2) as pool:
        future = pool.submit(
            shares.create_grants,
            "alice",
            card,
            str(uuid.uuid4()),
            [refs(db)[0]],
            15,
            card_request_id=pending["id"],
        )
        assert locked.wait(5)
        removal = pool.submit(delete_source)
        try:
            assert deleting.wait(5)
            assert not deleted.wait(0.25), "source deletion must serialize behind fulfillment"
        finally:
            resume.set()
        assert len(future.result(timeout=5)["grants"]) == 1
        removal.result(timeout=5)
    resolved = db.execute_raw(
        "SELECT status,message_id FROM wallet_card_requests WHERE id=CAST(:id AS uuid)",
        {"id": pending["id"]},
    ).data[0]
    assert resolved["status"] == "fulfilled"
    assert (resolved["message_id"] is None) == (deletion == "hard")


def test_connections_query_loads_owner_recipients_and_filters_blocks(cards_db, monkeypatch):
    db, service = cards_db
    monkeypatch.setenv("WALLET_CARD_ACCESS_ENABLED", "false")
    result = service.connections("alice")
    assert [(row["displayName"], row["trusted"]) for row in result["items"]] == [
        ("Charu", True),
        ("Rupman", False),
    ]
    assert result["hasMore"] is False
    assert len(service.connections("alice", "rup")["items"]) == 1
    assert service.connections("outsider")["items"] == []
    with pytest.raises(WalletCardAccessError, match="WALLET_CARD_ACCESS_DISABLED") as unavailable:
        service.create_grants("alice", "card_test", str(uuid.uuid4()), refs(db), 10)
    assert unavailable.value.status_code == 503
    with db.engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO direct_message_blocks(blocker_user_id,blocked_user_id) VALUES('bob','alice')"
            )
        )
    assert [row["displayName"] for row in service.connections("alice")["items"]] == ["Charu"]
    with db.engine.begin() as conn:
        conn.execute(text("DELETE FROM actor_identity_cache WHERE user_id='charu'"))
    assert service.connections("alice")["items"][0]["displayName"] == "A connection"
    assert service.connections("alice")["items"][0]["trusted"] is True


def test_saved_owner_cards_share_without_extra_verification_but_foreign_cards_do_not(cards_db):
    db, service = cards_db
    legacy = "card_" + str(uuid.uuid4())
    assert service.card_access("alice", legacy)["eligible"] is False
    with pytest.raises(WalletCardAccessError):
        service.create_grants("alice", legacy, str(uuid.uuid4()), refs(db), 10)
    save(db, legacy)
    assert service.card_access("alice", legacy)["eligible"] is True
    assert (
        len(service.create_grants("alice", legacy, str(uuid.uuid4()), refs(db), 10)["grants"]) == 2
    )
    assert service.card_access("bob", legacy)["eligible"] is False
    expired = service.reserve("alice", str(uuid.uuid4()))["cardId"]
    with db.engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE wallet_card_registrations SET reservation_expires_at=clock_timestamp()-interval '1 day' WHERE card_id=:card"
            ),
            {"card": expired},
        )
    save(db, expired, 2)
    assert service.card_access("alice", expired)["eligible"] is True
    card = active_card(db, service)
    assert service.card_access("bob", card)["eligible"] is False
    for default in ["agent-one-profile", "agent-one-referral", "agent-one-net-worth"]:
        with pytest.raises(WalletCardAccessError):
            service.create_grants("alice", default, str(uuid.uuid4()), refs(db), 10)


@pytest.mark.parametrize("include_number", [False, True])
def test_two_recipients_messages_feed_retry_verification_and_revoke(cards_db, include_number):
    db, service = cards_db
    card = active_card(db, service)
    request = str(uuid.uuid4())
    encrypted = {}
    if include_number:
        key = {
            "algorithm": "ECDH-P256-AES256-GCM",
            "recipientKeyId": "test-key",
            "iv": "A" * 16,
            "ciphertext": "A" * 64,
            "senderEphemeralPublicKeyJwk": {
                "kty": "EC",
                "crv": "P-256",
                "x": "A" * 43,
                "y": "A" * 43,
            },
        }
        encrypted = {
            "encrypted_cards": {
                ref: "hushh-wallet-card:v1:"
                + json.dumps(
                    {
                        "shareId": str(uuid.uuid4()),
                        "cardId": card,
                        "payload": {"ciphertext": "AAAA", "iv": "A" * 16, "tag": "A" * 22 + "=="},
                        "senderKey": key,
                        "recipientKey": key,
                    }
                )
                for ref in refs(db)
            }
        }
    result = service.create_grants("alice", card, request, refs(db), 10, **encrypted)
    assert service.create_grants("alice", card, request, refs(db), 10, **encrypted) == result
    with pytest.raises(WalletCardAccessError, match="RETRY_CONFLICT"):
        service.create_grants("alice", card, request, refs(db), 15)
    assert len(db.execute_raw("SELECT id FROM messages", {}).data) == 2
    assert len(db.execute_raw("SELECT id FROM feed_events", {}).data) == 2
    grants = {
        row["recipient_user_id"]: str(row["id"])
        for row in db.execute_raw(
            "SELECT id,recipient_user_id FROM wallet_card_access_grants", {}
        ).data
    }
    assert service.view_grant("charu", grants["charu"])["card"]["last4"] == "4242"
    if include_number:
        assert (
            service.view_grant("charu", grants["charu"])["encryptedCard"]
            in encrypted["encrypted_cards"].values()
        )
        assert all(
            "encryptedCard" not in str(row)
            for row in db.execute_raw("SELECT metadata FROM feed_events", {}).data
        )
    assert service.view_grant("bob", grants["bob"])["status"] == "verification_required"
    assert (
        service.view_grant(
            "bob", grants["bob"], verified_auth_time=datetime.now(timezone.utc).timestamp() - 10
        )["status"]
        == "verification_required"
    )
    assert (
        service.view_grant(
            "bob", grants["bob"], verified_auth_time=datetime.now(timezone.utc).timestamp() + 1
        )["card"]["last4"]
        == "4242"
    )
    with pytest.raises(WalletCardAccessError):
        service.view_grant("outsider", grants["charu"])
    with pytest.raises(WalletCardAccessError):
        service.revoke("bob", grants["charu"])
    service.revoke("alice", grants["bob"])
    assert service.view_grant("bob", grants["bob"])["status"] == "revoked"
    assert "encryptedCard" not in service.view_grant("bob", grants["bob"])
    assert service.view_grant("charu", grants["charu"])["status"] == "active"
    from hushh_mcp.services.feed_service import FeedService

    feed = FeedService()
    feed._db = db
    rows = db.execute_raw("SELECT * FROM feed_events WHERE user_id='charu'", {}).data
    decorated = feed._with_wallet_card_grants("charu", rows)
    assert feed._to_item(decorated[0])["metadata"]["wallet_card_grant_id"] == grants["charu"]
    assert not feed._with_wallet_card_grants("bob", rows)[0]["_wallet_card_grant_id"]


def test_failed_multi_send_rolls_back_every_message_grant_and_feed(cards_db, monkeypatch):
    db, service = cards_db
    card = active_card(db, service)
    seal = service.cipher.seal
    calls = 0

    def fail_second(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("synthetic unavailable key")
        return seal(*args, **kwargs)

    monkeypatch.setattr(service.cipher, "seal", fail_second)
    with pytest.raises(RuntimeError):
        service.create_grants("alice", card, str(uuid.uuid4()), refs(db), 5)
    for table in [
        "messages",
        "feed_events",
        "wallet_card_access_grants",
        "wallet_card_share_requests",
        "direct_message_push_outbox",
    ]:
        assert not db.execute_raw("SELECT * FROM " + table, {}).data


def test_expiry_is_server_enforced_and_removal_is_terminal(cards_db, monkeypatch):
    db, service = cards_db
    card = active_card(db, service)
    query = module.one

    def old_clock(conn, sql, values=None):
        if sql == "SELECT clock_timestamp() AS created_at":
            return {"created_at": datetime.now(timezone.utc) - timedelta(minutes=6)}
        return query(conn, sql, values)

    monkeypatch.setattr(module, "one", old_clock)
    result = service.create_grants("alice", card, str(uuid.uuid4()), refs(db), 5)
    assert all(grant["status"] == "expired" for grant in result["grants"])
    grant = db.execute_raw(
        "SELECT id FROM wallet_card_access_grants WHERE recipient_user_id='charu'", {}
    ).data[0]["id"]
    assert service.view_grant("charu", str(grant))["status"] == "expired"
    with db.engine.begin() as conn:
        conn.execute(text("DELETE FROM pkm_manifests WHERE user_id='alice'"))
    removed = service.view_grant("charu", str(grant))
    assert removed["status"] == "revoked" and "card" not in removed
    save(db, card, 2)
    assert not service.card_access("alice", card)["eligible"]


def test_rollback_refuses_history_and_empty_schema_can_be_reinstalled(legacy_cards_db):
    from sqlalchemy.exc import DBAPIError

    db, service = legacy_cards_db
    rollback = (
        Path(__file__).resolve().parents[1]
        / "db/migrations/rollback/302_wallet_temporary_card_access.rollback.sql"
    ).read_text()
    # Empty-only rollback is safe; the same forward migration restores the schema.
    with db.engine.connect() as conn:
        conn.exec_driver_sql(rollback)
    db.apply_migrations(["302_wallet_temporary_card_access.sql"])
    service.reserve("alice", str(uuid.uuid4()))
    with pytest.raises(DBAPIError, match="wallet_card_access_rollback_requires_empty_tables"):
        with db.engine.connect() as conn:
            conn.exec_driver_sql(rollback)
    assert len(db.execute_raw("SELECT card_id FROM wallet_card_registrations", {}).data) == 1


def test_request_expiry_and_empty_only_rollback_are_enforced_by_postgres(
    incoming_requests, monkeypatch
):
    from sqlalchemy.exc import DBAPIError

    import hushh_mcp.services.wallet_card_request_service as request_module

    db, shares, requests = incoming_requests
    rollback = (
        Path(__file__).resolve().parents[1]
        / "db/migrations/rollback/351_wallet_card_requests.rollback.sql"
    ).read_text(encoding="utf-8")
    with db.engine.connect() as conn:
        conn.exec_driver_sql(rollback)
    db.apply_migrations(["351_wallet_card_requests.sql"])
    target = str(
        db.execute_raw(
            "SELECT public_person_ref FROM actor_profiles WHERE user_id='alice'", {}
        ).data[0]["public_person_ref"]
    )
    query = request_module.one

    def old_creation(conn, sql, values=None):
        return query(
            conn,
            sql.replace(
                "SELECT clock_timestamp() AS t", "SELECT clock_timestamp()-interval '8 days' AS t"
            ),
            values,
        )

    monkeypatch.setattr(request_module, "one", old_creation)
    pending = requests.create("bob", target, str(uuid.uuid4()))
    card = active_card(db, shares)
    with pytest.raises(WalletCardAccessError, match="CLOSED"):
        shares.create_grants(
            "alice", card, str(uuid.uuid4()), [refs(db)[0]], 15, card_request_id=pending["id"]
        )
    assert requests.get("alice", pending["id"])["status"] == "expired"
    with pytest.raises(DBAPIError, match="wallet_card_requests_rollback_requires_empty_table"):
        with db.engine.connect() as conn:
            conn.exec_driver_sql(rollback)
