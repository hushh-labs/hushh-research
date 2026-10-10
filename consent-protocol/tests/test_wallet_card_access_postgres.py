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
def cards_db(projection_db, monkeypatch):  # noqa: F811 - imported pytest fixture
    monkeypatch.setenv("WALLET_CARD_ACCESS_ENABLED", "true")
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


def test_saved_owner_cards_share_without_extra_verification_but_foreign_cards_do_not(cards_db):
    db, service = cards_db
    legacy = "card_" + str(uuid.uuid4())
    assert service.card_access("alice", legacy)["eligible"] is False
    with pytest.raises(WalletCardAccessError):
        service.create_grants("alice", legacy, str(uuid.uuid4()), refs(db), 10)
    save(db, legacy)
    assert service.card_access("alice", legacy)["eligible"] is True
    assert len(service.create_grants("alice", legacy, str(uuid.uuid4()), refs(db), 10)["grants"]) == 2
    assert service.card_access("bob", legacy)["eligible"] is False
    expired = service.reserve("alice", str(uuid.uuid4()))["cardId"]
    with db.engine.begin() as conn:
        conn.execute(text("UPDATE wallet_card_registrations SET reservation_expires_at=clock_timestamp()-interval '1 day' WHERE card_id=:card"), {"card": expired})
    save(db, expired, 2)
    assert service.card_access("alice", expired)["eligible"] is True
    card = active_card(db, service)
    assert service.card_access("bob", card)["eligible"] is False
    for default in ["agent-one-profile", "agent-one-referral", "agent-one-net-worth"]:
        with pytest.raises(WalletCardAccessError):
            service.create_grants("alice", default, str(uuid.uuid4()), refs(db), 10)


def test_two_recipients_messages_feed_retry_verification_and_revoke(cards_db):
    db, service = cards_db
    card = active_card(db, service)
    request = str(uuid.uuid4())
    result = service.create_grants("alice", card, request, refs(db), 10)
    assert service.create_grants("alice", card, request, refs(db), 10) == result
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


def test_rollback_refuses_history_and_empty_schema_can_be_reinstalled(cards_db):
    from sqlalchemy.exc import DBAPIError

    db, service = cards_db
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
