"""Location source privacy, confirmed incidents and conversation attention."""

import json
import uuid
from pathlib import Path

import pytest
from sqlalchemy import text

from tests import test_feed_account_session_postgres as support

feed_db = support.feed_db
session, OWNER, OTHER = support.session, support.OWNER, support.OTHER


def _audit_incident(conn, sender, grant, event, envelope=None):
    conn.execute(
        text("""INSERT INTO one_location_events(owner_user_id,actor_user_id,recipient_user_id,grant_id,envelope_id,event_type,metadata)
      VALUES(:sender,:sender,:owner,:grant,:envelope,:event,'{"share_kind":"sos","reason":"sos_panic"}'::jsonb)"""),
        {
            "sender": sender,
            "owner": OWNER,
            "grant": grant,
            "envelope": envelope,
            "event": event,
        },
    )


def _unpublished_incidents(feed_db):
    sender = "qa-emergency-sender"
    with feed_db.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO actor_profiles VALUES(:sender),(:owner); INSERT INTO actor_identity_cache(user_id,display_name) VALUES(:sender,'Ankit'),(:owner,'Recipient')"
            ),
            {"sender": sender, "owner": OWNER},
        )
    grants = [str(uuid.uuid4()) for _ in range(2)]

    for grant in grants:
        with feed_db.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO one_location_share_grants(id,owner_user_id,recipient_user_id,recipient_key_id,status,metadata) VALUES(:id,:sender,:owner,'key','active',CAST(:meta AS JSONB))"
                ),
                {
                    "id": grant,
                    "sender": sender,
                    "owner": OWNER,
                    "meta": json.dumps({"share_kind": "sos"}),
                },
            )
            _audit_incident(conn, sender, grant, "location_share_created")
    return sender, grants


def test_emergencies_require_publication_and_clear_never_hides_two_live_incidents(feed_db):
    from hushh_mcp.services.location_feed_publication import RECEIVED_GRANTS_SQL
    from tests.feed_fixture_support import install_location_publication

    install_location_publication(feed_db)
    sender, grants = _unpublished_incidents(feed_db)
    assert session(feed_db).list_feed(OWNER)["items"] == []
    for grant in grants:
        with feed_db.begin() as conn:
            envelope = str(uuid.uuid4())
            conn.execute(
                text(
                    "INSERT INTO one_location_envelopes VALUES(:id,:grant,:sender,:owner); UPDATE one_location_share_grants SET latest_envelope_id=:id WHERE id=:grant"
                ),
                {"id": envelope, "grant": grant, "sender": sender, "owner": OWNER},
            )
            _audit_incident(conn, sender, grant, "location_envelope_updated", envelope)
    reader = session(feed_db)
    page = reader.list_feed(OWNER)
    assert len(page["items"]) == 2
    reader.clear(OWNER, up_to_id=int(page["read_snapshot"]["up_to_id"]))
    with feed_db.begin() as conn:
        live = list(
            conn.execute(
                text(RECEIVED_GRANTS_SQL), {"user_id": OWNER, "source_limit": 50}
            ).mappings()
        )
    assert {
        str(row["id"]) for row in live if row["feed_sms_confirmed"] and row["status"] == "active"
    } == set(grants)
    assert all(row["feed_confirmed_at"] is not None for row in live)

    # An unpublished draft ending must not manufacture a delivered incident.
    draft = str(uuid.uuid4())
    with feed_db.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO one_location_share_grants(id,owner_user_id,recipient_user_id,recipient_key_id,status,metadata) VALUES(:id,:sender,:owner,'key','revoked','{\"share_kind\":\"sos\"}')"
            ),
            {"id": draft, "sender": sender, "owner": OWNER},
        )
        _audit_incident(conn, sender, draft, "location_share_revoked")
        for grant, event in zip(
            grants, ("location_share_revoked", "location_share_expired"), strict=True
        ):
            conn.execute(
                text("UPDATE one_location_share_grants SET status=:status WHERE id=:id"),
                {"id": grant, "status": "revoked" if event.endswith("revoked") else "expired"},
            )
            _audit_incident(conn, sender, grant, event)
    ended = reader.list_feed(OWNER)
    assert len(ended["items"]) == 2
    keys = {item["activity_group_id"] for item in ended["items"]}
    assert keys == {"location-grant:" + grant for grant in grants}
    # Normal source retention must not split incident history or restore a map.
    with feed_db.begin() as conn:
        conn.execute(
            text(
                "DELETE FROM one_location_events; DELETE FROM one_location_envelopes; DELETE FROM one_location_share_grants"
            )
        )
    retained = session(feed_db).search_activity(OWNER, agent="agent_location")["items"]
    assert {item["activity_group_id"] for item in retained} == keys
    for item in retained:
        assert "grant_id" not in item["metadata"]
        detail = session(feed_db).operation_detail(OWNER, item_id=int(item["id"]))
        assert len(detail["milestones"]) == 2


def test_circle_chat_uses_current_unread_membership_not_feed_acknowledgement(feed_db):
    circle, message, later = [str(uuid.uuid4()) for _ in range(3)]
    with feed_db.begin() as conn:
        conn.execute(
            text("""ALTER TABLE one_location_circles ADD COLUMN status TEXT, ADD COLUMN is_system BOOLEAN, ADD COLUMN system_kind TEXT;
          CREATE TABLE one_location_circle_memberships(circle_id UUID,user_id TEXT,status TEXT,joined_at TIMESTAMPTZ);
          CREATE TABLE circle_chat_messages(id UUID PRIMARY KEY,circle_id UUID,sender_user_id TEXT,deleted_for_everyone_at TIMESTAMPTZ);
          CREATE TABLE circle_chat_recipients(message_id UUID,recipient_user_id TEXT,membership_joined_at TIMESTAMPTZ,read_at TIMESTAMPTZ,deleted_at TIMESTAMPTZ,feed_event_id BIGINT);
          INSERT INTO one_location_circles(id,owner_user_id,status,is_system,system_kind) VALUES(:circle,:owner,'active',FALSE,NULL);
          INSERT INTO one_location_circle_memberships VALUES(:circle,:owner,'active','2026-01-01');
          INSERT INTO circle_chat_messages VALUES(:message,:circle,:other,NULL),(:later,:circle,:other,NULL);"""),
            dict(circle=circle, owner=OWNER, other=OTHER, message=message, later=later),
        )
        for source in (message, later):
            row = conn.execute(
                text(
                    "INSERT INTO feed_events(user_id,source_domain,event_type,source_row_id,metadata) VALUES(:owner,'location','location_circle_message',:source,jsonb_build_object('circle_id',CAST(:circle AS TEXT),'circle_name','Family Circle')) RETURNING id"
                ),
                dict(owner=OWNER, source=f"circle-chat:{source}:{OWNER}", circle=circle),
            ).scalar_one()
            conn.execute(
                text(
                    "INSERT INTO circle_chat_recipients VALUES(:message,:owner,'2026-01-01',NULL,NULL,:id)"
                ),
                dict(message=source, owner=OWNER, id=row),
            )
    reader = session(feed_db)
    assert len(reader.list_feed(OWNER)["items"]) == 1
    with feed_db.begin() as conn:
        conn.execute(
            text("UPDATE feed_events SET read_at=now() WHERE user_id=:owner"), dict(owner=OWNER)
        )
    current = reader.list_feed(OWNER)
    assert len(current["items"]) == 1 and current["items"][0]["metadata"]["chat_unread_count"] == 2
    assert reader.unread_count(OWNER) == 1
    assert reader.search_activity(OWNER)["items"] == []
    with feed_db.begin() as conn:
        conn.execute(text("UPDATE circle_chat_recipients SET read_at=now()"))
    assert reader.list_feed(OWNER)["items"] == []

    with feed_db.begin() as conn:
        conn.execute(
            text(
                "UPDATE circle_chat_recipients SET read_at=NULL; UPDATE one_location_circle_memberships SET joined_at='2026-02-01'"
            )
        )
    assert reader.list_feed(OWNER)["items"] == []


def test_check_in_erasure_preserves_the_denominator_and_blocks_identity_resurrection(feed_db):
    from tests.feed_fixture_support import install_location_publication

    install_location_publication(feed_db)
    migrations = Path(__file__).resolve().parents[1] / "db/migrations"
    operation = str(uuid.uuid4())
    with feed_db.begin() as conn:
        conn.execute(
            text("""DROP FUNCTION install_account_deletion_write_guards();
          CREATE TABLE vault_keys(user_id TEXT PRIMARY KEY);
          CREATE TABLE one_location_circle_memberships(circle_id UUID,user_id TEXT,status TEXT,joined_at TIMESTAMPTZ);
          CREATE TABLE one_location_access_requests(id UUID,owner_user_id TEXT,requester_user_id TEXT,approved_grant_id UUID);
          INSERT INTO actor_profiles VALUES(:owner),(:other);"""),
            {"owner": OWNER, "other": OTHER},
        )
        for name in ("201_account_deletion_tombstones.sql", "462_location_check_in_operations.sql"):
            conn.exec_driver_sql(
                (migrations / name).read_text(), execution_options={"no_parameters": True}
            )
        conn.execute(
            text(
                "INSERT INTO one_location_check_in_operations(id,owner_user_id,client_operation_id,duration_hours,confirmed_at) VALUES(:id,:owner,'erasure-qa',1,now())"
            ),
            {"id": operation, "owner": OWNER},
        )
        conn.execute(
            text(
                "INSERT INTO one_location_check_in_targets(operation_id,recipient_user_id) VALUES(:id,:other),(:id,NULL)"
            ),
            {"id": operation, "other": OTHER},
        )
    # Negative control: a normal writer cannot detach or reparent a participant.
    with pytest.raises(Exception, match="account identity reference is immutable"):
        with feed_db.begin() as conn:
            conn.execute(
                text(
                    "UPDATE one_location_check_in_targets SET recipient_user_id=NULL WHERE recipient_user_id=:other"
                ),
                {"other": OTHER},
            )
    with feed_db.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO account_deletion_tombstones(user_id_hash) VALUES('sha256:'||encode(digest(CAST(:other AS TEXT),'sha256'),'hex'))"
            ),
            {"other": OTHER},
        )
        conn.execute(text("DELETE FROM actor_profiles WHERE user_id=:other"), {"other": OTHER})
        assert (
            conn.execute(
                text(
                    "SELECT count(*) FROM one_location_check_in_targets WHERE operation_id=:id AND recipient_user_id IS NULL"
                ),
                {"id": operation},
            ).scalar_one()
            == 2
        )
    with pytest.raises(Exception, match="account identity is deleted"):
        with feed_db.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO one_location_check_in_targets(operation_id,recipient_user_id) VALUES(:id,:other)"
                ),
                {"id": operation, "other": OTHER},
            )
