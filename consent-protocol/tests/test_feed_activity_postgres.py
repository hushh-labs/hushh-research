"""Cross-subagent owner-source grouping and retained activity on real PostgreSQL."""

import json
import uuid
from datetime import datetime, timezone

from sqlalchemy import text

from tests import test_feed_account_session_postgres as account_fixture
from tests.feed_activity_fixture import cross_agent_activity as cross_agent_activity

# Reuse the existing isolated real-PostgreSQL fixture, not a second schema.
feed_db = account_fixture.feed_db
session, seed = account_fixture.session, account_fixture.seed
OWNER, OTHER = account_fixture.OWNER, account_fixture.OTHER


def test_cross_agent_groups_search_owner_sources_without_changing_unread(cross_agent_activity):
    scenario = cross_agent_activity
    reader = session(scenario["db"])
    page = reader.list_feed(OWNER, limit=100)
    by_id = {int(item["id"]): item for item in page["items"]}
    assert set(by_id) == {
        scenario["ended_grant"],
        scenario["approved"],
        scenario["consent"],
        scenario["sent"],
        scenario["email"],
        scenario["calendar"],
        scenario["gmail"],
        scenario["external"],
    }
    assert len({item["activity_group_id"] for item in by_id.values()}) == len(by_id)
    assert by_id[scenario["sent"]]["subagent_id"] == "agent_kyc"
    assert by_id[scenario["email"]]["subagent_id"] == "agent_email"
    assert (
        by_id[scenario["ended_grant"]]["activity_group_id"] == "location-grant:" + scenario["grant"]
    )
    assert by_id[scenario["consent"]]["activity_group_id"] == "consent:" + scenario["bundle"]
    assert {scenario["foreign"], scenario["stale"], scenario["noise"]}.isdisjoint(by_id)
    assert set(reader.attention_items(OWNER, list(by_id))) == {
        str(value) for value in by_id if value != scenario["ended_grant"]
    }
    assert reader.attention_items(OTHER, list(by_id)) == {}
    before = reader.unread_count(OWNER)
    matches = reader.search_activity(
        OWNER,
        person="Alex",
        agent="agent_location",
        from_at=datetime(2026, 10, 1, tzinfo=timezone.utc),
        before_at=datetime(2026, 10, 2, tzinfo=timezone.utc),
    )
    assert {int(item["id"]) for item in matches["items"]} == {
        scenario["ended_grant"],
        scenario["approved"],
    }
    assert reader.unread_count(OWNER) == before
    assert reader.search_activity(OTHER, person="Alex")["items"] == []
    assert reader.operation_detail(OTHER, item_id=scenario["sent"]) is None
    detail = reader.operation_detail(OWNER, item_id=scenario["sent"])
    assert detail["item"]["id"] == str(scenario["sent"])
    assert {step["event_type"] for step in detail["milestones"]} == {
        "mail_information_request_detected",
        "mail_message_sent",
    }


def test_cross_agent_dismissal_repair_and_ambiguous_delivery_bindings(cross_agent_activity):
    scenario = cross_agent_activity
    reader = session(scenario["db"])
    removal = reader.dismiss(OWNER, item_id=scenario["ended_grant"])
    assert set(removal["dismissed_ids"]) == {
        str(scenario["first_grant"]),
        str(scenario["ended_grant"]),
    }
    assert session(scenario["db"]).operation_detail(OWNER, item_id=scenario["first_grant"])["item"][
        "id"
    ] == str(scenario["ended_grant"])
    assert str(scenario["ended_grant"]) not in {
        item["id"] for item in reader.list_feed(OWNER)["items"]
    }
    assert str(scenario["ended_grant"]) not in {
        item["id"] for item in reader.search_activity(OWNER, agent="agent_location")["items"]
    }
    assert reader.search_activity(OTHER, agent="agent_location")["items"] == []
    revived = scenario["event"](
        "location_share_duration_changed",
        "location",
        scenario["grant"] + ":operation:new",
        day="04",
    )
    assert session(scenario["db"]).operation_detail(OWNER, item_id=scenario["first_grant"])["item"][
        "id"
    ] == str(scenario["ended_grant"])
    revived_detail = session(scenario["db"]).operation_detail(OWNER, item_id=revived)
    assert {row["id"] for row in revived_detail["milestones"]} == {
        str(scenario["first_grant"]),
        str(scenario["ended_grant"]),
        str(revived),
    }
    before_repair_revision = reader.list_feed(OWNER, limit=100)["history_revision"]
    with scenario["db"].begin() as conn:
        conn.execute(
            text(
                "UPDATE google_service_grants SET status='connected';\n            UPDATE kai_gmail_connections SET status='connected';\n            UPDATE user_external_connector_connections SET status='connected';"
            )
        )
    repaired_page = session(scenario["db"]).list_feed(OWNER, limit=100)
    assert repaired_page["history_revision"] != before_repair_revision
    repaired = {int(row["id"]) for row in repaired_page["items"]}
    assert {scenario["calendar"], scenario["gmail"], scenario["external"]}.isdisjoint(repaired)
    assert (
        reader.attention_items(
            OWNER, [scenario["calendar"], scenario["gmail"], scenario["external"]]
        )
        == {}
    )
    assert session(scenario["db"]).search_activity(OWNER, agent="agent_email")["items"][0][
        "id"
    ] == str(scenario["email"])
    with scenario["db"].begin() as conn:
        conn.execute(
            text(
                "INSERT INTO gmail_personal_information_requests VALUES(:workflow,:owner,'sent','kyc-send')"
            ),
            {"workflow": str(uuid.uuid4()), "owner": OWNER},
        )
    ambiguous = session(scenario["db"]).list_feed(OWNER, limit=100)["items"]
    assert sum((row["id"] == str(scenario["sent"]) for row in ambiguous)) == 1
    assert (
        next((row for row in ambiguous if row["id"] == str(scenario["sent"])))["subagent_id"]
        == "agent_email"
    )


def test_meaningful_time_cursor_and_refresh_do_not_repeat_unread(feed_db):
    rows = seed(
        feed_db,
        OWNER,
        [
            ("old", "connections", "connection_accepted", {}),
            ("new", "connections", "connection_accepted", {}),
        ],
    )
    with feed_db.begin() as conn:
        conn.execute(
            text("UPDATE feed_events SET created_at='2026-01-01T00:00:00Z' WHERE user_id=:owner"),
            {"owner": OWNER},
        )
        conn.execute(
            text("UPDATE feed_events SET created_at='2026-02-01T00:00:00Z' WHERE id=:id"),
            {"id": rows["old"]},
        )
    reader = session(feed_db)
    page = reader.list_feed(OWNER, limit=1)
    assert page["items"][0]["id"] == str(rows["old"])
    next_page = reader.list_feed(OWNER, cursor=int(page["next_cursor"]), limit=1)
    assert [item["id"] for item in next_page["items"]] == [str(rows["new"])]
    snapshot = page["read_snapshot"]
    assert snapshot["up_to_id"] == str(rows["new"])
    reader.mark_read(
        OWNER, up_to_id=int(snapshot["up_to_id"]), through_time=snapshot["through_time"]
    )
    for _ in range(2):
        refreshed = session(feed_db).list_feed(OWNER)
        assert refreshed["unread_count"] == 0
        assert len({item["activity_group_id"] for item in refreshed["items"]}) == 2


def test_read_snapshot_does_not_acknowledge_an_unseen_same_id_update(feed_db):
    row = seed(feed_db, OWNER, [("profile", "profile_discovery", "profile_discovery_ready", {})])[
        "profile"
    ]
    reader = session(feed_db)
    # A real writer starts before GET, but remains invisible until afterwards.
    with feed_db.connect() as writer:
        transaction = writer.begin()
        writer.execute(
            text(
                "UPDATE feed_events SET metadata=jsonb_build_object('progress_revision',2),created_at=now(),read_at=NULL WHERE id=:id"
            ),
            {"id": row},
        )
        snapshot = reader.list_feed(OWNER)["read_snapshot"]
        transaction.commit()
    receipt = dict(
        up_to_id=int(snapshot["up_to_id"]),
        through_time=snapshot["through_time"],
        snapshot_fingerprint=snapshot["fingerprint"],
    )
    reader.mark_read(OWNER, **receipt)
    assert session(feed_db).unread_count(OWNER) == 1
    assert reader.clear(OWNER, **receipt)["snapshot_changed"] is True
    assert len(reader.list_feed(OWNER)["items"]) == 1
    latest = reader.list_feed(OWNER)["read_snapshot"]
    assert latest["fingerprint"] != snapshot["fingerprint"]
    reader.mark_read(
        OWNER,
        up_to_id=row,
        through_time=latest["through_time"],
        snapshot_fingerprint=latest["fingerprint"],
    )
    assert session(feed_db).unread_count(OWNER) == 0


def test_location_grant_is_the_result_of_its_verified_request(feed_db):
    grant, request = str(uuid.uuid4()), str(uuid.uuid4())
    with feed_db.begin() as conn:
        conn.execute(
            text("""CREATE TABLE one_location_access_requests(id UUID PRIMARY KEY,owner_user_id TEXT,
            requester_user_id TEXT,approved_grant_id UUID);
            INSERT INTO one_location_access_requests VALUES(:request,:owner,:other,:grant);
            INSERT INTO one_location_share_grants(id,owner_user_id,recipient_user_id,recipient_key_id,status)
            VALUES(:grant,:owner,:other,'test','revoked');"""),
            dict(request=request, grant=grant, owner=OWNER, other=OTHER),
        )
        for event, source in [
            ("location_access_request", request),
            ("location_share_created", grant),
            ("location_share_revoked", grant),
            ("location_access_approved", request),
        ]:
            conn.execute(
                text("""INSERT INTO feed_events(user_id,source_domain,event_type,source_row_id)
                VALUES(:owner,'location',:event,:source)"""),
                dict(owner=OWNER, event=event, source=source),
            )
    reader = session(feed_db)
    [row] = reader.list_feed(OWNER)["items"]
    assert row["activity_group_id"] == "location-request:" + request
    assert (
        row["event_type"] == "location_share_revoked"
    )  # a delayed approval cannot undo access loss
    assert len(reader.operation_detail(OWNER, item_id=int(row["id"]))["milestones"]) == 4
    assert reader.list_feed(OTHER)["items"] == []


def test_normal_arrivals_preserve_visibility_revision_and_clear_uses_global_snapshot(feed_db):
    reader = session(feed_db)
    first = seed(feed_db, OWNER, [("first", "connections", "connection_accepted", {})])["first"]
    before = reader.list_feed(OWNER, limit=1)
    second = seed(feed_db, OWNER, [("older", "connections", "connection_accepted", {})])["older"]
    with feed_db.begin() as conn:
        conn.execute(
            text("UPDATE feed_events SET created_at='2020-01-01T00:00:00Z' WHERE id=:id"),
            {"id": second},
        )
    after = reader.list_feed(OWNER, limit=1)
    assert after["items"][0]["id"] == str(first)
    assert after["history_revision"] == before["history_revision"]
    snapshot = after["read_snapshot"]
    assert snapshot["up_to_id"] == str(second)
    receipt = reader.clear(
        OWNER, up_to_id=int(snapshot["up_to_id"]), through_time=snapshot["through_time"]
    )
    cleared = reader.list_feed(OWNER)
    assert cleared["clear_version"] == receipt["clear_version"]
    assert cleared["items"] == []
    assert reader.search_activity(OWNER)["items"] == []
    assert reader.search_activity(OTHER)["items"] == []


def test_operation_detail_pages_recorded_steps_without_cross_operation_cursors(feed_db):
    rows = seed(
        feed_db,
        OWNER,
        [
            (str(index), "consent", "consent_granted", {"bundle_id": "same-bundle"})
            for index in range(102)
        ],
    )
    other = seed(
        feed_db, OTHER, [("other", "consent", "consent_granted", {"bundle_id": "same-bundle"})]
    )["other"]
    reader = session(feed_db)
    first = reader.operation_detail(OWNER, item_id=rows["101"])
    assert len(first["milestones"]) == 100
    assert first["more_milestones"] is True
    second = reader.operation_detail(
        OWNER, item_id=rows["101"], before_id=int(first["next_cursor"])
    )
    assert len(second["milestones"]) == 2 and second["next_cursor"] is None
    assert len({item["id"] for item in first["milestones"] + second["milestones"]}) == 102
    assert reader.operation_detail(OWNER, item_id=rows["101"], before_id=other) is None


def test_transfer_progress_stays_in_the_same_detail_without_extra_attention(feed_db):
    with feed_db.begin() as conn:
        for state in ("pending", "completed", "processing"):
            conn.execute(
                text("""INSERT INTO feed_events(user_id,source_domain,event_type,source_row_id,metadata)
                VALUES(:owner,'kai','funding_transfer_status',:source,CAST(:meta AS jsonb))"""),
                {
                    "owner": OWNER,
                    "source": "transfer-one:" + state,
                    "meta": json.dumps({"user_facing_status": state}),
                },
            )
    reader = session(feed_db)
    [row] = reader.list_feed(OWNER)["items"]
    assert row["metadata"]["user_facing_status"] == "completed"
    assert reader.unread_count(OWNER) == 0
    detail = reader.operation_detail(OWNER, item_id=int(row["id"]))
    assert {item["metadata"]["user_facing_status"] for item in detail["milestones"]} == {
        "pending",
        "completed",
        "processing",
    }


def test_routine_and_foreign_chat_stay_hidden_including_historical_search(feed_db):
    conversation, message, foreign_conversation, foreign_message = [
        str(uuid.uuid4()) for _ in range(4)
    ]
    with feed_db.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO conversations VALUES(:conversation,:owner,:other),(:foreign,'foreign-a','foreign-b'); INSERT INTO messages VALUES(:message,:conversation,:other,NULL,NULL),(:foreign_message,:foreign,'foreign-a',NULL,NULL)"
            ),
            dict(
                conversation=conversation,
                owner=OWNER,
                other=OTHER,
                foreign=foreign_conversation,
                message=message,
                foreign_message=foreign_message,
            ),
        )
    rows = seed(
        feed_db,
        OWNER,
        [
            (message, "connections", "direct_message_received", {}),
            (foreign_message, "connections", "direct_message_received", {}),
        ],
    )
    with feed_db.begin() as conn:
        for source, row_id in rows.items():
            conn.execute(
                text("UPDATE feed_events SET source_row_id=:source WHERE id=:id"),
                {"source": source, "id": row_id},
            )
    reader = session(feed_db)
    # Routine Chat is not a Feed outcome, including through historical search.
    # Real card-backed messages remain covered by wallet_card_access_postgres.
    assert reader.list_feed(OWNER)["items"] == []
    assert reader.search_activity(OWNER)["items"] == []
    assert reader.unread_count(OWNER) == 0
    reader.clear(OWNER, up_to_id=rows[foreign_message])
    assert reader.list_feed(OWNER)["items"] == []
    assert reader.search_activity(OWNER)["items"] == []
    assert reader.search_activity(OTHER)["items"] == []
    with feed_db.begin() as conn:
        conn.execute(
            text(
                "UPDATE messages SET deleted_for_recipient_at=clock_timestamp() WHERE id=:message"
            ),
            {"message": message},
        )
    assert reader.search_activity(OWNER)["items"] == []
    assert reader.operation_detail(OWNER, item_id=rows[message]) is None


def test_location_search_matches_workflows_without_indexing_private_presence(cross_agent_activity):
    scenario = cross_agent_activity
    circle_id = str(uuid.uuid4())
    scenario["event"](
        "location_circle_member_invite_accepted",
        "location",
        "membership:qa",
        metadata={"circle_id": circle_id, "circle_name": "Family Circle"},
    )
    check_in = scenario["event"](
        "location_share_created",
        "location",
        scenario["grant"],
        metadata={
            "share_kind": "check_in",
            "check_in_operation_id": str(uuid.uuid4()),
            "private_note": "orchid-secret-note",
            "place_name": "orchid-secret-place",
            "coordinates": {"latitude": 37.7351, "longitude": -122.4352},
        },
    )
    # Nearby presence is deliberately not durable owner activity, even on old cached rows.
    scenario["event"](
        "location_nearby_checked_in",
        "location",
        "nearby:qa",
        metadata={"circle_name": "orchid-nearby-presence"},
    )
    scenario["event"](
        "circle_member_left",
        "location",
        "nested-label:qa",
        metadata={
            "circle_name": {"private_note": "orchid-nested-label"},
            "display_name": ["orchid-nested-label"],
            "counterpart_label": {"private_note": "orchid-nested-label"},
        },
    )
    reader = session(scenario["db"])
    # Server search uses safe labels from an earlier admitted milestone after
    # the visible row changes, without returning private source contents.
    local = next(
        row
        for row in reader.search_activity(OWNER, agent="agent_location")["items"]
        if int(row["id"]) == scenario["ended_grant"]
    )
    assert local["scope_id"] == "location"
    assert "orchid-secret" not in str(local) and "37.7351" not in str(local)
    assert "orchid-nested-label" not in str(reader.search_activity(OWNER)["items"])
    assert (
        reader.search_activity(
            OWNER,
            agent="agent_location",
            query="revoked",
            from_at=datetime(2026, 10, 1, tzinfo=timezone.utc),
            before_at=datetime(2026, 10, 2, tzinfo=timezone.utc),
        )["items"]
        == []
    )
    assert (
        len(reader.search_activity(OWNER, query="Family Circle", agent="agent_location")["items"])
        == 1
    )
    for query in ("Check-In", "check_in", "check in"):
        assert {
            int(row["id"])
            for row in reader.search_activity(OWNER, query=query, agent="agent_location")["items"]
        } == {scenario["ended_grant"]}
    detail = reader.operation_detail(OWNER, item_id=check_in)
    assert str(check_in) in {step["id"] for step in detail["milestones"]}
    for query in (
        "orchid-secret-note",
        "orchid-secret-place",
        "37.7351",
        "122.4352",
        "orchid-nearby-presence",
        "orchid-nested-label",
    ):
        assert reader.search_activity(OWNER, query=query)["items"] == []
    assert reader.search_activity(OTHER, query="Family Circle")["items"] == []
