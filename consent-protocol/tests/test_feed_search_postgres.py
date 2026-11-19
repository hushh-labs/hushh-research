"""Full owner history search, source identity and stable ranked cursors."""

import uuid

import pytest
from sqlalchemy import text

from hushh_mcp.services.feed_search_contract import FeedSearchError
from tests.feed_activity_fixture import cross_agent_activity as cross_agent_activity
from tests.feed_activity_fixture import ranked_search_activity as ranked_search_activity
from tests.test_feed_activity_postgres import OTHER, OWNER, seed, session
from tests.test_feed_activity_postgres import feed_db as feed_db


def test_ranked_scope_search_reads_all_history_and_keeps_opaque_page_boundaries(
    ranked_search_activity,
):
    from hushh_mcp.services.feed_search_contract import FeedSearchError

    scenario = ranked_search_activity
    reader = session(scenario["db"])
    unread = reader.unread_count(OWNER)
    first = reader.search_activity(OWNER, query="Ankit", scope="location", limit=1)
    assert first["items"][0]["id"] == str(scenario["exact"])
    assert first["top_hit"]["item"]["id"] == str(scenario["exact"])
    cursor = first["next_cursor"]
    assert cursor and not cursor.isdecimal()
    scenario["event"](
        "location_share_expired", "location", str(uuid.uuid4()), actor="Ankit", day="03"
    )
    second = reader.search_activity(
        OWNER, query="Ankit", scope="location", limit=100, cursor=cursor
    )
    assert {int(row["id"]) for row in second["items"]} == set(scenario["prefixes"])
    assert second["top_hit"] is None and second["next_cursor"] is None
    assert reader.search_activity(OWNER, query="Singh aNk", scope="location")["items"]
    assert reader.search_activity(OWNER, query="Ankti", scope="location")["suggestion"] == "ankit"
    assert reader.search_activity(OWNER, query="Mom check-in", scope="location")["items"] == []
    assert reader.search_activity(OTHER, query="Ankit", scope="location")["items"] == []
    for criteria in [
        {"query": "Kumar"},
        {"scope": "finance"},
        {"cursor": cursor[:-1] + ("x" if cursor[-1] != "x" else "y")},
        {"owner": OTHER},
    ]:
        with pytest.raises(FeedSearchError):
            reader.search_activity(
                criteria.get("owner", OWNER),
                query=criteria.get("query", "Ankit"),
                scope=criteria.get("scope", "location"),
                cursor=criteria.get("cursor", cursor),
            )
    assert reader.unread_count(OWNER) == unread  # A new dated expiry is quiet.


def test_current_account_name_search_requires_a_current_confirmed_relationship(feed_db):
    with feed_db.begin() as conn:
        conn.execute(
            text("""CREATE TABLE actor_identity_cache(user_id TEXT PRIMARY KEY,display_name TEXT,custom_photo_url TEXT,photo_url TEXT);
          CREATE TABLE connections(user_a_id TEXT,user_b_id TEXT,status TEXT);
          CREATE TABLE IF NOT EXISTS feed_event_counterparts(feed_event_id BIGINT,counterpart_user_id TEXT);
          INSERT INTO actor_identity_cache VALUES(:other,'Current Name',NULL,NULL);
          INSERT INTO connections VALUES(:owner,:other,'active');"""),
            {"owner": OWNER, "other": OTHER},
        )
        row = conn.execute(
            text("""INSERT INTO feed_events(user_id,source_domain,event_type,actor_label,source_row_id)
          VALUES(:owner,'location','location_share_expired','Recorded Name',:id) RETURNING id"""),
            {"owner": OWNER, "id": str(uuid.uuid4())},
        ).scalar_one()
        conn.execute(
            text("INSERT INTO feed_event_counterparts VALUES(:id,:other)"),
            {"id": row, "other": OTHER},
        )
    reader = session(feed_db)
    assert [
        item["id"]
        for item in reader.search_activity(OWNER, query="Current", scope="location")["items"]
    ] == [str(row)]
    assert reader.search_activity(OWNER, person="expired")["items"] == []
    with feed_db.begin() as conn:
        conn.execute(text("UPDATE connections SET status='revoked'"))
    assert reader.search_activity(OWNER, query="Current", scope="location")["items"] == []
    assert reader.search_activity(OWNER, query="Recorded", scope="location")["items"][0][
        "id"
    ] == str(row)


def test_search_normalizes_unicode_and_respects_classified_agent_scopes(feed_db):
    rows = seed(
        feed_db,
        OWNER,
        [
            ("unicode", "connections", "connection_accepted", {}),
            ("accent", "connections", "connection_accepted", {}),
        ],
    )
    with feed_db.begin() as conn:
        conn.execute(
            text("UPDATE feed_events SET actor_label=:name WHERE id=:id"),
            {"name": "Straße", "id": rows["unicode"]},
        )
        conn.execute(
            text("UPDATE feed_events SET actor_label=:name WHERE id=:id"),
            {"name": "Jose\u0301 García", "id": rows["accent"]},
        )
    reader = session(feed_db)
    assert reader.search_activity(OWNER, query="Straße")["items"][0]["id"] == str(rows["unicode"])
    assert reader.search_activity(OWNER, query="García José")["items"][0]["id"] == str(
        rows["accent"]
    )
    from hushh_mcp.services.feed_activity_dto import activity_fields
    from hushh_mcp.services.feed_search_contract import scope_sql

    # The source-verified classified owner must override a shared message event.
    with feed_db.connect() as conn:
        scope = conn.execute(
            text(
                "SELECT "
                + scope_sql("g")
                + " FROM (SELECT 'agent_wallet'::text AS subagent_id,'direct_message_received'::text AS event_type,'{}'::jsonb AS metadata) g"
            )
        ).scalar_one()
    assert scope == "wallet"
    assert (
        activity_fields(
            {"subagent_id": "agent_wallet", "event_type": "direct_message_received"}, {}
        )["scope_id"]
        == scope
    )


def test_clear_fences_old_labels_suggestions_and_cursor_without_erasing_exact_detail(feed_db):
    def event(name, key):
        with feed_db.begin() as conn:
            return conn.execute(
                text("""INSERT INTO feed_events(user_id,source_domain,event_type,actor_label,metadata)
                VALUES(:owner,'connected_systems','calendar_event_created',:name,jsonb_build_object('calendar_event_key',CAST(:key AS text))) RETURNING id"""),
                {"owner": OWNER, "name": name, "key": key},
            ).scalar_one()

    old = event("Alpha", "same-operation")
    event("Zed", "independent-operation")
    reader = session(feed_db)
    cursor = reader.search_activity(OWNER, scope="calendar", limit=1)["next_cursor"]
    assert cursor
    assert reader.search_activity(OWNER, query="Alpha")["items"]
    token = reader.dismiss(OWNER, item_id=old)["dismissal_token"]
    new = event("Maya", "same-operation")
    assert reader.search_activity(OWNER, query="Alpha")["items"] == []
    assert reader.search_activity(OWNER, query="Alhpa")["suggestion"] is None
    assert [row["id"] for row in reader.search_activity(OWNER, query="Maya")["items"]] == [str(new)]
    with pytest.raises(FeedSearchError):
        reader.search_activity(OWNER, scope="calendar", limit=1, cursor=cursor)
    assert {row["id"] for row in reader.operation_detail(OWNER, item_id=new)["milestones"]} == {
        str(old),
        str(new),
    }
    assert reader.restore(OWNER, item_id=old, dismissal_token=token)["restored"] is True
    assert reader.search_activity(OWNER, query="Alpha")["items"]
