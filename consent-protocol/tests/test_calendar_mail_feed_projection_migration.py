"""Contract checks for privacy-safe Calendar and Mail Feed projections."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "db/migrations/252_calendar_mail_feed_projection.sql"
ROLLBACK = ROOT / "db/migrations/rollback/252_calendar_mail_feed_projection.rollback.sql"
WEB = ROOT.parent / "hushh-webapp"
EVENT_TYPES = (
    "calendar_connected",
    "calendar_reconnect_required",
    "calendar_disconnected",
    "calendar_event_created",
    "calendar_event_rescheduled",
    "calendar_event_canceled",
    "mail_connected",
    "mail_reconnect_required",
    "mail_disconnected",
    "mail_information_request_detected",
    "mail_receipts_imported",
    "mail_sync_completed",
    "mail_sync_failed",
    "mail_message_sent",
    "mail_message_failed",
    "mail_delivery_unconfirmed",
)


def test_projection_is_registered_replayable_and_reversible() -> None:
    manifest = json.loads((ROOT / "db/release_migration_manifest.json").read_text())
    sql = MIGRATION.read_text()
    rollback = ROLLBACK.read_text()

    assert MIGRATION.name in manifest["ordered_migrations"]
    assert MIGRATION.name in manifest["groups"]["iam"]
    assert manifest["rollback_migrations"][MIGRATION.name] == f"rollback/{ROLLBACK.name}"
    assert "ON CONFLICT DO NOTHING" in sql
    assert "IF NOT EXISTS (SELECT 1 FROM pg_trigger" in sql
    assert "EXCEPTION WHEN OTHERS THEN" in sql
    for trigger in (
        "calendar_grant_feed_projection",
        "calendar_proposal_feed_projection",
        "calendar_legacy_delete_feed_projection",
        "mail_connection_feed_projection",
        "mail_information_request_feed_projection",
        "mail_sync_feed_projection",
        "mail_send_feed_projection",
    ):
        assert f"CREATE TRIGGER {trigger}" in sql
        assert f"DROP TRIGGER IF EXISTS {trigger}" in rollback


def test_projection_never_copies_calendar_or_mail_content_to_plaintext_feed() -> None:
    sql = MIGRATION.read_text()
    insert = sql.split("INSERT INTO feed_events (", 1)[1].split("ON CONFLICT DO NOTHING", 1)[0]

    assert "'connected_systems'" in insert
    assert "'{}'::jsonb" in insert
    for forbidden in (
        "payload_json",
        "gmail_message_id",
        "gmail_thread_id",
        "google_email",
        "provider_email",
        "error_message",
        "subject",
        "title",
        "recipient_count",
    ):
        assert forbidden not in insert
    assert "NEW.status = 'executed'" in sql
    assert "OLD.status = 'executing' AND OLD.expires_at > NOW()" in sql
    assert "EXISTS (SELECT 1 FROM actor_profiles WHERE user_id = OLD.user_id)" in sql
    assert "service = 'calendar' AND status = 'connected'" in sql
    assert "AFTER DELETE ON google_calendar_action_proposals" in sql
    assert "NEW.status = 'detected'" in sql
    assert "NEW.synced_count > 0" in sql
    assert "WHEN feed_type <> 'mail_sync_failed' THEN NEW.run_id" in sql
    assert "NEW.sync_mode = 'manual'" in sql
    assert "NEW.state IN ('sent', 'failed', 'outcome_unknown')" in sql


def test_release_contracts_probe_the_v252_projection_function() -> None:
    for name in ("dev_minimum_schema", "prod_core_schema", "uat_integrated_schema"):
        contract = json.loads((ROOT / f"db/contracts/{name}.json").read_text())
        assert "project_calendar_mail_feed" in contract["required_functions"]


def test_every_projected_event_has_a_web_and_native_feed_presentation() -> None:
    sql = MIGRATION.read_text()
    feed_contract = (WEB / "lib/services/feed-service.ts").read_text()
    renderer = (WEB / "lib/feed/feed-item-renderers.tsx").read_text()

    for event_type in EVENT_TYPES:
        assert f"'{event_type}'" in sql
        assert f'| "{event_type}"' in feed_contract
        assert f'case "{event_type}":' in renderer
