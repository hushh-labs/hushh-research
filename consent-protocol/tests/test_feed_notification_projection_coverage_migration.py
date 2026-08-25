import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "db" / "migrations" / "177_feed_notification_projection_coverage.sql"
ROLLBACK = (
    ROOT
    / "db"
    / "migrations"
    / "rollback"
    / "177_feed_notification_projection_coverage.rollback.sql"
)


def _sql(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_notification_feed_projection_is_source_idempotent() -> None:
    sql = _sql(MIGRATION)
    assert "CREATE UNIQUE INDEX IF NOT EXISTS uq_feed_events_source_projection" in sql
    assert "WHERE source_row_id IS NOT NULL" in sql
    assert sql.count("ON CONFLICT (") >= 5
    assert sql.count("DO NOTHING") >= 5
    manifest = json.loads(
        (ROOT / "db" / "release_migration_manifest.json").read_text(encoding="utf-8")
    )
    assert MIGRATION.name in manifest["ordered_migrations"]
    assert MIGRATION.name in manifest["groups"]["iam"]


def test_location_notification_families_have_the_correct_audiences() -> None:
    sql = _sql(MIGRATION)
    for event_type in (
        "location_share_shortened",
        "location_share_duration_changed",
        "location_access_request_withdrawn",
        "location_public_invite_submitted",
        "location_one_network_joined",
        "location_referral_invite",
    ):
        assert f"'{event_type}'" in sql

    assert "feed_events_recipient_from_one_location_events" in sql
    assert "feed_events_requester_from_one_location_events" in sql
    assert "feed_events_referred_from_one_location_events" in sql
    assert "'feed_audience', 'recipient'" in sql
    assert "'feed_audience', 'requester'" in sql
    assert "'feed_audience', 'referred'" in sql
    assert "NEW.metadata->>'reason' = 'request_approved'" in sql


def test_funding_projection_is_terminal_and_plaintext_bounded() -> None:
    sql = _sql(MIGRATION)
    assert "feed_events_from_kai_funding_transfer_events" in sql
    assert "'funding_transfer_status'" in sql
    for status in (
        "completed",
        "settled",
        "canceled",
        "failed",
        "rejected",
        "error",
        "returned",
        "reversed",
    ):
        assert f"WHEN '{status}'" in sql

    funding_function = sql.split(
        "CREATE OR REPLACE FUNCTION feed_events_from_kai_funding_transfer_events()",
        maxsplit=1,
    )[1]
    for sensitive_column in (
        "amount",
        "account_id",
        "reason_message",
        "payload_json",
        "response_payload_json",
    ):
        assert sensitive_column not in funding_function


def test_notification_projection_has_a_scoped_rollback() -> None:
    rollback = _sql(ROLLBACK)
    assert "DROP TRIGGER IF EXISTS kai_funding_transfer_events_feed_fanout" in rollback
    assert "DROP TRIGGER IF EXISTS one_location_events_feed_fanout_referred" in rollback
    assert "DROP INDEX IF EXISTS uq_feed_events_source_projection" in rollback
    # Rollback restores, rather than drops, the three pre-existing functions.
    assert "CREATE OR REPLACE FUNCTION feed_events_from_one_location_events()" in rollback
    assert "CREATE OR REPLACE FUNCTION feed_events_recipient_from_one_location_events()" in rollback
    assert "CREATE OR REPLACE FUNCTION feed_events_requester_from_one_location_events()" in rollback
