import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "db" / "migrations" / "179_feed_notification_projection_coverage.sql"
ROLLBACK = (
    ROOT
    / "db"
    / "migrations"
    / "rollback"
    / "179_feed_notification_projection_coverage.rollback.sql"
)


def _sql(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _function_body(sql: str, function_name: str) -> str:
    return sql.split(
        f"CREATE OR REPLACE FUNCTION {function_name}()",
        maxsplit=1,
    )[1].split("$$ LANGUAGE plpgsql;", maxsplit=1)[0]


def _metadata_keys(function_body: str) -> set[str]:
    return set(re.findall(r"NEW\.metadata\s*->>?\s*'([^']+)'", function_body))


def test_notification_feed_projection_is_source_idempotent() -> None:
    sql = _sql(MIGRATION)
    assert "CREATE UNIQUE INDEX IF NOT EXISTS uq_feed_events_source_projection" in sql
    assert "WHERE source_row_id IS NOT NULL" in sql
    assert sql.count("ON CONFLICT DO NOTHING") == 5
    assert "ON CONFLICT (" not in sql
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


def test_location_projection_uses_event_specific_plaintext_allowlists() -> None:
    sql = _sql(MIGRATION)
    assert "COALESCE(NEW.metadata" not in sql

    owner = _function_body(sql, "feed_events_from_one_location_events")
    recipient = _function_body(sql, "feed_events_recipient_from_one_location_events")
    requester = _function_body(sql, "feed_events_requester_from_one_location_events")
    referred = _function_body(sql, "feed_events_referred_from_one_location_events")

    assert "CASE NEW.event_type" in owner
    assert "CASE NEW.event_type" in recipient
    assert "CASE NEW.event_type" in requester
    assert _metadata_keys(owner) == {
        "counterpart_label",
        "client_operation_id",
        "connection_id",
        "direction",
        "duration_hours",
        "duration_mode",
        "is_extension",
        "invite_id",
        "public_location_view",
        "reason",
        "requested_duration_hours",
        "requested_duration_mode",
        "request_revision",
        "submission_id",
    }
    assert _metadata_keys(recipient) == {
        "client_operation_id",
        "connection_id",
        "direction",
        "duration_hours",
        "duration_mode",
        "invite_id",
        "owner_label",
        "reason",
    }
    assert _metadata_keys(requester) == {
        "is_extension",
        "owner_label",
        "requested_duration_hours",
        "requested_duration_mode",
        "request_revision",
    }
    assert _metadata_keys(referred) == {"owner_label", "referring_label"}


def test_location_projection_uses_stable_domain_transition_ids() -> None:
    sql = _sql(MIGRATION)
    owner = _function_body(sql, "feed_events_from_one_location_events")
    recipient = _function_body(sql, "feed_events_recipient_from_one_location_events")
    requester = _function_body(sql, "feed_events_requester_from_one_location_events")
    referred = _function_body(sql, "feed_events_referred_from_one_location_events")

    assert "source_row_id_value := CASE NEW.event_type" in owner
    assert "':operation:'" in owner
    assert "COALESCE(NEW.grant_id::TEXT, 'unknown-grant')" in owner
    assert "submission_id_value" in owner
    assert "':revision:'" in owner
    assert owner.index("NEW.metadata ->> 'invite_id'") < owner.index(
        "NEW.metadata ->> 'connection_id'"
    )
    assert "source_row_id_value := CASE NEW.event_type" in recipient
    assert "source_row_id_value := CASE NEW.event_type" in requester
    assert "COALESCE(NEW.referral_id::TEXT, NEW.id::TEXT)" in referred

    for sensitive_key in (
        "access_token",
        "account_id",
        "ciphertext",
        "coordinates",
        "phone_number",
        "share_kind",
    ):
        assert sensitive_key not in sql


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
    assert "COALESCE(NEW.metadata" not in rollback
    assert "NEW.metadata," not in rollback
