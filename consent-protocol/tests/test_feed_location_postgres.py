"""Location source privacy, confirmed incidents and conversation attention."""

import json
import uuid

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
                    "INSERT INTO one_location_share_grants(id,owner_user_id,recipient_user_id,recipient_key_id,status,duration_mode,metadata) VALUES(:id,:sender,:owner,'key','active','until_stopped',CAST(:meta AS JSONB))"
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
    live = reader.live_incidents(OWNER)["items"]
    assert {row["metadata"]["grant_id"] for row in live} == set(grants)

    # Two incidents remain visible even behind more than fifty newer outcomes.
    with feed_db.begin() as conn:
        conn.execute(
            text("""INSERT INTO feed_events(user_id,source_domain,event_type,metadata,created_at)
          SELECT :owner,'kai','kai_analysis_completed','{}',clock_timestamp()
          FROM generate_series(1,60)"""),
            {"owner": OWNER},
        )
    assert len(reader.list_feed(OWNER, limit=20)["items"]) == 20
    assert {
        row["metadata"]["grant_id"] for row in reader.list_feed(OWNER)["live_incidents"]["items"]
    } == set(grants)

    # Both legacy Clear and snapshot Clear preserve the incident's eventual history.
    current = reader.list_feed(OWNER)
    protected = reader.clear(
        OWNER,
        up_to_id=int(current["read_snapshot"]["up_to_id"]),
        snapshot_fingerprint=current["read_snapshot"]["fingerprint"],
    )
    assert protected["snapshot_changed"] is False
    for item in page["items"]:
        assert reader.dismiss(OWNER, item_id=int(item["id"]))["dismissal_token"] is None
    with feed_db.begin() as conn:
        assert (
            conn.execute(
                text(
                    "SELECT count(*) FROM feed_events WHERE user_id=:owner AND source_domain='location' AND dismissed_at IS NOT NULL"
                ),
                {"owner": OWNER},
            ).scalar_one()
            == 0
        )
        # Same-lane supersession changes the source without producing another end event.
        conn.execute(
            text("UPDATE one_location_share_grants SET status='revoked' WHERE id=:id"),
            {"id": grants[0]},
        )
    superseded = reader.search_activity(OWNER, query="Ankit")["items"]
    assert any(
        item["activity_group_id"] == "location-grant:" + grants[0]
        and item["metadata"]["current_location_status"] == "revoked"
        for item in superseded
    )

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


def test_location_feed_uses_server_expiry_before_retention_settles_raw_status(feed_db):
    from tests.feed_fixture_support import install_location_publication

    install_location_publication(feed_db)
    sender, grants = _unpublished_incidents(feed_db)
    with feed_db.begin() as conn:
        for grant in grants:
            envelope = str(uuid.uuid4())
            conn.execute(
                text(
                    "INSERT INTO one_location_envelopes VALUES(:id,:grant,:sender,:owner); UPDATE one_location_share_grants SET latest_envelope_id=:id WHERE id=:grant"
                ),
                {"id": envelope, "grant": grant, "sender": sender, "owner": OWNER},
            )
            _audit_incident(conn, sender, grant, "location_envelope_updated", envelope)
        conn.execute(
            text(
                "UPDATE one_location_share_grants SET duration_mode='timed',expires_at=clock_timestamp()-interval '1 second' WHERE id=:id"
            ),
            {"id": grants[0]},
        )
    items = {
        item["metadata"]["recorded_grant_id"]: item
        for item in session(feed_db).list_feed(OWNER)["items"]
    }
    assert items[grants[0]]["metadata"]["current_location_status"] == "expired"
    assert items[grants[1]]["metadata"]["current_location_status"] == "active"
    with feed_db.begin() as conn:
        conn.execute(
            text(
                "UPDATE one_location_share_grants SET expires_at=NULL,duration_mode='timed' WHERE id=:id"
            ),
            {"id": grants[0]},
        )
    assert (
        next(
            item
            for item in session(feed_db).list_feed(OWNER)["items"]
            if item["metadata"]["recorded_grant_id"] == grants[0]
        )["metadata"]["current_location_status"]
        == "expired"
    )
