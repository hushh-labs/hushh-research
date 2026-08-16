"""One Feed row per real-world moment when a location request is approved.

Reported from the field: "3 feeds generated on requesting location". One
request/approve cycle put three rows in the owner's Feed --

    "Requested your location"           (the ask)
    "Started sharing location"          (the answer)
    "You approved the location request" (the same answer, again)

-- because ``approve_request`` calls ``create_grant`` (which writes
``location_share_created``) and then writes ``location_access_approved``
itself, and migration 117's trigger forwarded both.
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION_NAME = "151_feed_events_dedupe_approved_share.sql"


def _migration_sql() -> str:
    return (ROOT / "db" / "migrations" / MIGRATION_NAME).read_text(encoding="utf-8")


def test_migration_is_registered_at_release_head():
    assert (ROOT / "db" / "migrations" / MIGRATION_NAME).exists()

    manifest = json.loads(
        (ROOT / "db" / "release_migration_manifest.json").read_text(encoding="utf-8")
    )
    assert MIGRATION_NAME in manifest["ordered_migrations"]
    assert MIGRATION_NAME in manifest["groups"]["iam"]
    # The trigger it replaces was introduced by 117, so it must run after it.
    ordered = manifest["ordered_migrations"]
    assert ordered.index(MIGRATION_NAME) > ordered.index("117_feed_events.sql")

    contract = json.loads(
        (ROOT / "db" / "contracts" / "uat_integrated_schema.json").read_text(
            encoding="utf-8"
        )
    )
    assert contract["expected_migration_version"] >= 151
    assert contract["migration_version_policy"] == "exact"


def test_fan_out_skips_the_share_row_of_an_approval_born_grant():
    sql = _migration_sql()

    assert "CREATE OR REPLACE FUNCTION feed_events_from_one_location_events()" in sql
    assert "NEW.event_type = 'location_share_created'" in sql
    assert "NEW.metadata->>'reason' = 'request_approved'" in sql

    # The guard has to return BEFORE the insert, or it forwards the row anyway.
    guard_at = sql.index("NEW.metadata->>'reason' = 'request_approved'")
    insert_at = sql.index("INSERT INTO feed_events")
    assert guard_at < insert_at


def test_every_other_location_event_still_reaches_the_feed():
    sql = _migration_sql()

    # De-duplicating one pair must not quietly narrow the feed.
    for event_type in (
        "location_share_created",
        "location_share_revoked",
        "location_share_expired",
        "location_access_request",
        "location_access_approved",
        "location_access_denied",
    ):
        assert f"'{event_type}'" in sql

    # A share started directly carries no approval reason and is unaffected.
    assert "NEW.owner_user_id" in sql
    assert "'location'" in sql


def test_rollback_restores_the_unconditional_fan_out():
    rollback = (
        ROOT
        / "db"
        / "migrations"
        / "rollback"
        / "151_feed_events_dedupe_approved_share.rollback.sql"
    ).read_text(encoding="utf-8")

    assert (
        "CREATE OR REPLACE FUNCTION feed_events_from_one_location_events()" in rollback
    )
    assert "request_approved" not in rollback


def test_create_grant_stamps_the_reason_the_trigger_reads():
    """The guard is dead weight unless the service actually writes the key."""
    service = (
        ROOT / "hushh_mcp" / "services" / "one_location_agent_service.py"
    ).read_text(encoding="utf-8")

    share_created_event = service.index('event_type="location_share_created"')
    # Through the end of that metadata dict.
    window = service[share_created_event : service.index(")", service.index("},", share_created_event))]
    assert '"reason": reason or ""' in window

    # And the caller still names that reason when approving a request.
    assert 'reason="request_approved"' in service
