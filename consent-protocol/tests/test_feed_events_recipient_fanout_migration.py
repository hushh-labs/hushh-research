"""The person a location is shared WITH gets a Feed row.

Reported from the field: "Ankit have shared me location or Jamai have shared
me location. The feed should be real time notifying and real time adding."

Migration 117 wrote every location feed row to ``NEW.owner_user_id`` -- the
person who shared. The recipient was never written a row, so their Feed was
empty no matter how often it refreshed. Making the Feed poll faster (the
parallel change) cannot show a row that was never created.
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION_NAME = "152_feed_events_recipient_fanout.sql"
ROLLBACK_NAME = "152_feed_events_recipient_fanout.rollback.sql"

SHARE_LIFECYCLE_EVENTS = (
    "location_share_created",
    "location_share_revoked",
    "location_share_expired",
)


def _migration_sql() -> str:
    return (ROOT / "db" / "migrations" / MIGRATION_NAME).read_text(encoding="utf-8")


def test_migration_is_registered_at_release_head():
    assert (ROOT / "db" / "migrations" / MIGRATION_NAME).exists()
    assert (ROOT / "db" / "migrations" / "rollback" / ROLLBACK_NAME).exists()

    manifest = json.loads(
        (ROOT / "db" / "release_migration_manifest.json").read_text(encoding="utf-8")
    )
    assert MIGRATION_NAME in manifest["ordered_migrations"]
    assert MIGRATION_NAME in manifest["groups"]["iam"]

    # feed_events and one_location_events must both exist before this runs.
    ordered = manifest["ordered_migrations"]
    assert ordered.index(MIGRATION_NAME) > ordered.index("117_feed_events.sql")

    for contract_name in (
        "dev_minimum_schema.json",
        "prod_core_schema.json",
        "uat_integrated_schema.json",
    ):
        contract = json.loads(
            (ROOT / "db" / "contracts" / contract_name).read_text(encoding="utf-8")
        )
        assert contract["expected_migration_version"] >= 152, contract_name


def test_the_recipient_of_a_share_is_written_a_row():
    sql = _migration_sql()

    assert "CREATE TRIGGER one_location_events_feed_fanout_recipient" in sql
    assert "AFTER INSERT ON one_location_events" in sql
    # The row is addressed to the recipient, which is the entire point.
    assert "NEW.recipient_user_id," in sql
    assert "INSERT INTO feed_events" in sql


def test_every_share_lifecycle_event_reaches_the_recipient():
    """Starting, stopping and expiring each change what the recipient can see.

    Dropping any one of them leaves the recipient's Feed telling a story that
    stops halfway: a share that starts and, as far as the Feed says, never ends.
    """
    sql = _migration_sql()

    for event_type in SHARE_LIFECYCLE_EVENTS:
        assert f"'{event_type}'" in sql, event_type


def test_requests_and_approvals_are_not_mirrored_to_the_recipient():
    """Those already notify the side that has to act.

    Mirroring them would put a second row in the Feed of someone who was
    already told, which is the duplicate-rows complaint in another form.
    """
    sql = _migration_sql()

    for event_type in (
        "location_access_request",
        "location_access_approved",
        "location_access_denied",
    ):
        assert f"'{event_type}'" not in sql, event_type


def test_a_share_with_no_other_person_writes_nothing():
    sql = _migration_sql()

    assert "NEW.recipient_user_id IS NULL" in sql
    assert "NEW.recipient_user_id = NEW.owner_user_id" in sql
    # Both guards must return before the insert, or a self-share writes a row
    # telling someone they shared with themselves.
    guard_at = sql.index("NEW.recipient_user_id IS NULL")
    insert_at = sql.index("INSERT INTO feed_events")
    assert guard_at < insert_at


def test_the_recipient_row_names_the_owner_not_itself():
    """`counterpart_label` on the source event was resolved for the owner.

    It holds the RECIPIENT's name. Copied through unchanged, the recipient's
    Feed would show them their own name as the person who shared with them.
    """
    sql = _migration_sql()

    assert "FROM actor_identity_cache" in sql
    assert "WHERE user_id = NEW.owner_user_id" in sql
    assert "'counterpart_label'" in sql
    # The override has to be merged ON TOP of the event metadata, not under it.
    assert "COALESCE(NEW.metadata, '{}'::jsonb)" in sql
    assert "||" in sql


def test_the_recipient_row_is_marked_so_the_client_can_word_it():
    """Without this the recipient's revoke row renders the owner's sentence.

    `reason = 'owner_revoke'` is true on BOTH copies of a revoke event, so the
    client cannot tell the two audiences apart from `reason` alone -- and would
    tell the recipient "You stopped sharing location".
    """
    sql = _migration_sql()

    assert "'feed_audience', 'recipient'" in sql


def test_the_owner_fan_out_is_left_alone():
    """This migration adds an audience; it does not re-filter the existing one.

    A parallel change is doing CREATE OR REPLACE on
    feed_events_from_one_location_events(). If this migration replaced that
    function too, whichever landed second would silently revert the other.
    """
    sql = _migration_sql()

    assert "CREATE OR REPLACE FUNCTION feed_events_from_one_location_events()" not in sql
    assert "DROP TRIGGER IF EXISTS one_location_events_feed_fanout ON" not in sql
    assert "CREATE OR REPLACE FUNCTION feed_events_recipient_from_one_location_events()" in sql


def test_rollback_drops_the_trigger_and_keeps_the_rows():
    """Rows already delivered are real activity someone received.

    Deleting them on rollback would remove shares from a person's Feed that
    genuinely happened, and they render correctly without the trigger.
    """
    rollback = (ROOT / "db" / "migrations" / "rollback" / ROLLBACK_NAME).read_text(encoding="utf-8")

    assert "DROP TRIGGER IF EXISTS one_location_events_feed_fanout_recipient" in rollback
    assert "DROP FUNCTION IF EXISTS feed_events_recipient_from_one_location_events" in rollback
    assert "DELETE FROM feed_events" not in rollback
    # And it must not take the owner's fan-out down with it.
    assert "DROP FUNCTION IF EXISTS feed_events_from_one_location_events" not in rollback
