"""Real SMS schema and immutable relationship receipt assertions."""

from pathlib import Path
from uuid import UUID


def sms_schema(db):
    """Real Circle migrations; adjacent tables expose their consumed columns."""
    db.execute_raw("""
        CREATE TABLE actor_identity_cache(user_id TEXT PRIMARY KEY, display_name TEXT, email TEXT,
            custom_photo_url TEXT, photo_url TEXT);
        INSERT INTO actor_identity_cache VALUES('owner','Owner',NULL,NULL,NULL),('other','Contact',NULL,NULL,NULL);
        CREATE TABLE connections(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_a_id TEXT, user_b_id TEXT,
            status TEXT, source TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(), revoked_at TIMESTAMPTZ, UNIQUE(user_a_id,user_b_id));
        CREATE TABLE connection_requests(requester_user_id TEXT,addressee_user_id TEXT,status TEXT,responded_at TIMESTAMPTZ,updated_at TIMESTAMPTZ,metadata JSONB);
        INSERT INTO connections(user_a_id,user_b_id,status,source) VALUES('owner','other','active','request');
        CREATE TABLE one_location_share_grants(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), owner_user_id TEXT,
            recipient_user_id TEXT, status TEXT, updated_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ);
        CREATE TABLE one_location_events(id UUID DEFAULT gen_random_uuid(),owner_user_id TEXT,actor_user_id TEXT,
            recipient_user_id TEXT,event_type TEXT,metadata JSONB,grant_id UUID);
    """)
    migrations = Path(__file__).resolve().parents[2] / "db/migrations"
    for name in (
        "116_one_location_sms_contacts.sql",
        "134_one_location_named_circles.sql",
        "135_one_location_circle_connection_origins.sql",
        "136_one_location_circle_member_invites.sql",
        "138_circle_member_connection_origin.sql",
        "160_one_location_system_circles.sql",
        "163_one_location_system_circle_kinds.sql",
    ):
        with db.engine.begin() as conn:
            conn.exec_driver_sql(
                (migrations / name).read_text(), execution_options={"no_parameters": True}
            )


def assert_sms_added_event(db):
    events = db.execute_raw(
        "SELECT recipient_user_id,event_type,metadata FROM one_location_events"
    ).data
    assert len(events) == 1
    event = events[0]
    assert (
        event["recipient_user_id"] == "other"
        and event["event_type"] == "location_sms_contact_added"
    )
    metadata = dict(event["metadata"])
    assert metadata.pop("circle_name") == "SMS Circle"
    assert len(metadata.pop("membership_key")) == 64
    assert str(UUID(metadata.pop("circle_id")))
    assert metadata == {"owner_label": "Owner", "counterpart_label": "Contact"}
