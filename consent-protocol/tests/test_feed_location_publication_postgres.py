"""Exercise the production audit -> Feed trigger, not hand-inserted receipts."""

import json
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

import hushh_mcp.services.one_location_agent_service as location_module
from db.db_client import DatabaseClient
from hushh_mcp.services.feed_location_policy import RECEIVED_GRANTS_FEED_SQL
from hushh_mcp.services.one_location_agent_service import OneLocationAgentService
from tests.test_feed_account_session_postgres import (
    OTHER,
    OWNER,
    ROOT,
    SOS_SENDER,
    apply,
    listed_ids,
    session,
)
from tests.test_feed_account_session_postgres import (
    feed_db as feed_db,
)

MIGRATION = ROOT / "db/migrations/455_location_feed_confirmed_incidents.sql"


@pytest.fixture
def publication_db(feed_db):
    with feed_db.begin() as c:
        c.execute(
            text("""
          ALTER TABLE one_location_share_grants ADD COLUMN latest_envelope_id UUID;
          CREATE TABLE one_location_events(id BIGSERIAL PRIMARY KEY, owner_user_id TEXT,
            actor_user_id TEXT, recipient_user_id TEXT, grant_id UUID, envelope_id UUID,
            request_id UUID, referral_id UUID, event_type TEXT,
            metadata JSONB DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ DEFAULT now());
          CREATE INDEX idx_one_location_events_recipient_type ON one_location_events(recipient_user_id,event_type);
          CREATE TABLE one_location_envelopes(id UUID PRIMARY KEY, grant_id UUID,
            owner_user_id TEXT, recipient_user_id TEXT);
          CREATE TABLE actor_profiles(user_id TEXT PRIMARY KEY);
          CREATE TABLE actor_identity_cache(user_id TEXT PRIMARY KEY, display_name TEXT,
            photo_url TEXT, custom_photo_url TEXT, phone_number TEXT);
          CREATE FUNCTION install_account_deletion_write_guards() RETURNS void LANGUAGE sql AS 'SELECT';
          CREATE UNIQUE INDEX uq_feed_events_source_projection
            ON feed_events(user_id,source_domain,event_type,source_row_id) WHERE source_row_id IS NOT NULL;
        """)
        )
        for user_id in (OWNER, OTHER, SOS_SENDER):
            c.execute(
                text(
                    "INSERT INTO actor_profiles VALUES (:id); INSERT INTO actor_identity_cache(user_id,display_name) VALUES (:id,'Test person')"
                ),
                {"id": user_id},
            )
    for filename in (
        "152_feed_events_recipient_fanout.sql",
        "186_feed_share_kind_projection.sql",
        "202_feed_counterpart_identity.sql",
        "204_feed_counterpart_indexed_lookup.sql",
    ):
        apply(feed_db, ROOT / "db/migrations" / filename)
    if MIGRATION.exists():
        apply(feed_db, MIGRATION)
    return feed_db


def audit(c, grant_id, event, *, actor=SOS_SENDER, share_kind="sos", envelope_id=None):
    c.execute(
        text("""INSERT INTO one_location_events(owner_user_id,recipient_user_id,
      actor_user_id,grant_id,envelope_id,event_type,metadata)
      VALUES (:sender,:recipient,:actor,CAST(:grant AS uuid),CAST(:envelope AS uuid),:event,CAST(:meta AS jsonb))"""),
        {
            "sender": SOS_SENDER,
            "recipient": OWNER,
            "actor": actor,
            "grant": grant_id,
            "envelope": envelope_id,
            "event": event,
            "meta": json.dumps(
                {
                    "share_kind": share_kind,
                    "reason": "recipient_revoke" if actor == OWNER else "owner_revoke",
                }
            ),
        },
    )


def create_grant(db, *, share_kind="sos", confirmed=False):
    grant_id = str(uuid.uuid4())
    with db.begin() as c:
        c.execute(
            text("""INSERT INTO one_location_share_grants(id,owner_user_id,recipient_user_id,recipient_key_id,metadata)
          VALUES (CAST(:id AS uuid),:sender,:recipient,'key',CAST(:meta AS jsonb))"""),
            {
                "id": grant_id,
                "sender": SOS_SENDER,
                "recipient": OWNER,
                "meta": json.dumps({"share_kind": share_kind}),
            },
        )
        if confirmed:
            publish(c, grant_id)
        audit(c, grant_id, "location_share_created", share_kind=share_kind)
    return grant_id


def publish(c, grant_id):
    envelope_id = str(uuid.uuid4())
    c.execute(
        text("""INSERT INTO one_location_envelopes VALUES(CAST(:envelope AS uuid),CAST(:grant AS uuid),:sender,:recipient);
      UPDATE one_location_share_grants SET latest_envelope_id=CAST(:envelope AS uuid) WHERE id=CAST(:grant AS uuid)"""),
        {"envelope": envelope_id, "grant": grant_id, "sender": SOS_SENDER, "recipient": OWNER},
    )
    audit(c, grant_id, "location_envelope_updated", envelope_id=envelope_id)


def receipts(db):
    with db.connect() as c:
        return (
            c.execute(
                text(
                    "SELECT id,source_row_id,metadata FROM feed_events WHERE user_id=:id ORDER BY id"
                ),
                {"id": OWNER},
            )
            .mappings()
            .all()
        )


def test_unpublished_sms_draft_cannot_displace_confirmed_alert(publication_db):
    db = publication_db
    confirmed = create_grant(db, confirmed=True)
    first = listed_ids(session(db), OWNER)
    draft = create_grant(db)
    with db.connect() as c:
        grants = (
            c.execute(text(RECEIVED_GRANTS_FEED_SQL), {"user_id": OWNER, "source_limit": 100})
            .mappings()
            .all()
        )
    assert {str(g["id"]): g["feed_latest_sms"] for g in grants} == {confirmed: True, draft: False}
    assert next(g for g in grants if str(g["id"]) == draft)["feed_sms_confirmed"] is False
    assert listed_ids(session(db), OWNER) == first
    assert len(first) == 1
    assert str(receipts(db)[0]["source_row_id"]).split(":")[0] == confirmed
    with db.begin() as c:
        publish(c, draft)
    assert len(receipts(db)) == 2
    assert listed_ids(session(db), OWNER) == [receipts(db)[1]["id"]]
    with db.begin() as c:
        publish(c, draft)
    assert len(receipts(db)) == 2
    assert session(db).unread_count(OWNER) == 1


def test_recipient_stop_is_not_incoming_but_owner_stop_is_quiet(publication_db):
    db = publication_db
    grant = create_grant(db, share_kind="live")
    initial_revision = session(db).list_feed(OWNER)["history_revision"]
    with db.begin() as c:
        audit(c, grant, "location_share_revoked", actor=OWNER, share_kind="live")
    assert listed_ids(session(db), OWNER) == []
    assert session(db).list_feed(OWNER)["history_revision"] != initial_revision
    owner_stopped = create_grant(db, share_kind="live")
    with db.begin() as c:
        audit(c, owner_stopped, "location_share_revoked", share_kind="live")
    assert listed_ids(session(db), OWNER) == [receipts(db)[-1]["id"]]
    assert session(db).unread_count(OWNER) == 0


def test_atomic_with_envelope_creation_publishes_one_receipt(publication_db):
    db = publication_db
    grant_id, envelope_id = str(uuid.uuid4()), str(uuid.uuid4())
    # The production writer's sibling CTEs expose the envelope through their
    # RETURNING dependency before both required audit records are inserted.
    with db.begin() as c:
        c.execute(
            text("""
          WITH grant_row AS (
            INSERT INTO one_location_share_grants(id,owner_user_id,recipient_user_id,recipient_key_id,metadata,latest_envelope_id)
            VALUES (CAST(:grant AS uuid),:sender,:recipient,'key','{"share_kind":"sos"}',CAST(:envelope AS uuid)) RETURNING *
          ), envelope_row AS (
            INSERT INTO one_location_envelopes SELECT CAST(:envelope AS uuid),id,owner_user_id,recipient_user_id FROM grant_row RETURNING *
          ), completed AS MATERIALIZED (SELECT g.* FROM grant_row g JOIN envelope_row e ON e.grant_id=g.id)
          INSERT INTO one_location_events(owner_user_id,recipient_user_id,actor_user_id,grant_id,envelope_id,event_type,metadata)
          SELECT owner_user_id,recipient_user_id,owner_user_id,id,CAST(:envelope AS uuid),kind,'{"share_kind":"sos"}'
          FROM completed CROSS JOIN (VALUES ('location_share_created'),('location_envelope_updated')) AS events(kind)
        """),
            {"grant": grant_id, "envelope": envelope_id, "sender": SOS_SENDER, "recipient": OWNER},
        )
    assert len(receipts(db)) == 1
    assert len(listed_ids(session(db), OWNER)) == 1


def test_publication_receipt_failure_rolls_back_the_envelope_and_audit(publication_db):
    db = publication_db
    grant = create_grant(db)
    with db.begin() as c:
        c.execute(
            text("""CREATE FUNCTION reject_publication() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'TEST_PUBLICATION_FAILURE'; END $$;
          CREATE TRIGGER reject_publication BEFORE INSERT ON feed_events FOR EACH ROW EXECUTE FUNCTION reject_publication();""")
        )
    with pytest.raises(DBAPIError, match="TEST_PUBLICATION_FAILURE"):
        with db.begin() as c:
            publish(c, grant)
    with db.connect() as c:
        assert c.execute(text("SELECT count(*) FROM one_location_envelopes")).scalar_one() == 0
        assert (
            c.execute(
                text(
                    "SELECT count(*) FROM one_location_events WHERE event_type='location_envelope_updated'"
                )
            ).scalar_one()
            == 0
        )
        assert (
            c.execute(text("SELECT latest_envelope_id FROM one_location_share_grants")).scalar_one()
            is None
        )
    assert receipts(db) == []


def test_legacy_draft_backfill_replay_clear_and_source_cleanup(publication_db, monkeypatch):
    db = publication_db
    apply(db, ROOT / "db/migrations/rollback/455_location_feed_confirmed_incidents.rollback.sql")
    confirmed = create_grant(db, confirmed=True)
    draft = create_grant(db)
    apply(db, MIGRATION)
    rows = receipts(db)
    assert [r["metadata"]["feed_sms_confirmed"] for r in rows] == [True, False]
    with db.connect() as c:
        assert (
            c.execute(
                text("SELECT event_type FROM feed_events WHERE id=:id"), {"id": rows[1]["id"]}
            ).scalar_one()
            == "location_share_unconfirmed"
        )
    assert listed_ids(session(db), OWNER) == [rows[0]["id"]]
    # Pre455 readers rank plain recipient/SOS creation keys without knowing
    # feed_sms_confirmed. Quarantined drafts must not match that selector.
    with db.connect() as c:
        assert (
            c.execute(
                text("""SELECT source_row_id FROM feed_events WHERE user_id=:owner
          AND event_type='location_share_created' AND metadata->>'feed_audience'='recipient'
          AND metadata->>'share_kind'='sos' ORDER BY created_at DESC,id DESC LIMIT 1"""),
                {"owner": OWNER},
            ).scalar_one()
            == confirmed
        )
    with db.begin() as c:
        publish(c, confirmed)  # No duplicate legacy confirmed alert.
        publish(c, draft)
    assert len(receipts(db)) == 3
    newest = receipts(db)[-1]
    assert newest["source_row_id"] == draft
    apply(db, MIGRATION)
    assert receipts(db)[1]["metadata"]["feed_sms_confirmed"] is False
    assert listed_ids(session(db), OWNER) == [newest["id"]]
    apply(db, ROOT / "db/migrations/rollback/455_location_feed_confirmed_incidents.rollback.sql")
    token = session(db).dismiss(OWNER, item_id=newest["id"])["dismissal_token"]
    with db.begin() as c:
        c.execute(
            text(
                "UPDATE one_location_share_grants SET status='revoked' WHERE id=CAST(:id AS uuid)"
            ),
            {"id": draft},
        )
    monkeypatch.setattr(location_module, "get_db", lambda: DatabaseClient(db))
    assert OneLocationAgentService().clear_received_grants(
        recipient_user_id=OWNER, grant_ids=[draft]
    ) == [draft]
    assert (
        session(db).restore(OWNER, item_id=newest["id"], dismissal_token=token)["restored"] is False
    )
    with db.begin() as c:
        c.execute(
            text(
                "DELETE FROM one_location_share_grants; DELETE FROM one_location_events; DELETE FROM one_location_envelopes"
            )
        )
    assert listed_ids(session(db), OWNER) == []
    assert session(db).unread_count(OWNER) == 0


def test_replayed_legacy_draft_after_rollback_is_quarantined_without_identity_loss(publication_db):
    db = publication_db
    grant = create_grant(db)
    rollback = ROOT / "db/migrations/rollback/455_location_feed_confirmed_incidents.rollback.sql"
    identities = []
    for _ in range(2):
        apply(db, rollback)
        with db.begin() as c:
            audit(c, grant, "location_share_created")
        with db.connect() as c:
            identities.append(
                c.execute(
                    text("SELECT id,created_at FROM feed_events ORDER BY id DESC LIMIT 1")
                ).one()
            )
        apply(db, MIGRATION)
    with db.connect() as c:
        assert (
            c.execute(text("SELECT id,created_at FROM feed_events ORDER BY id")).all() == identities
        )
        assert (
            c.execute(
                text(
                    "SELECT count(*) FROM feed_events WHERE event_type='location_share_unconfirmed'"
                )
            ).scalar_one()
            == 2
        )
    assert listed_ids(session(db), OWNER) == []
    with db.begin() as c:
        publish(c, grant)
    assert len(listed_ids(session(db), OWNER)) == 1


def test_migration_waits_for_old_publisher_before_repairing_its_draft(publication_db):
    db = publication_db
    grant = create_grant(db)
    apply(db, ROOT / "db/migrations/rollback/455_location_feed_confirmed_incidents.rollback.sql")
    with db.connect() as writer, ThreadPoolExecutor(max_workers=1) as pool:
        transaction = writer.begin()
        audit(writer, grant, "location_share_created")
        repair = pool.submit(apply, db, MIGRATION)
        try:
            deadline = time.monotonic() + 3
            blocked = False
            while time.monotonic() < deadline and not repair.done():
                with db.connect() as observer:
                    blocked = observer.execute(
                        text("""SELECT EXISTS(SELECT 1 FROM pg_stat_activity
                      WHERE datname=current_database() AND wait_event_type='Lock')""")
                    ).scalar_one()
                if blocked:
                    break
                time.sleep(0.01)
            assert blocked, "repair must wait for the old audit writer before its snapshot"
        finally:
            transaction.commit()
        repair.result(timeout=5)
    assert receipts(db)[0]["metadata"]["feed_sms_confirmed"] is False
    with db.begin() as c:
        publish(c, grant)
    assert listed_ids(session(db), OWNER) == [receipts(db)[-1]["id"]]
