from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "db" / "migrations" / "180_one_location_circle_feed_durability.sql"
ROLLBACK = (
    ROOT / "db" / "migrations" / "rollback" / "180_one_location_circle_feed_durability.rollback.sql"
)
CIRCLE_SERVICE = ROOT / "hushh_mcp" / "services" / "one_location_circle_service.py"


def _sql(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_completed_circle_events_are_ledger_backed_and_feed_projected() -> None:
    sql = _sql(MIGRATION)
    service = _sql(CIRCLE_SERVICE)

    for event_type in (
        "location_circle_code_joined",
        "location_circle_member_invite_accepted",
        "circle_member_added",
    ):
        assert f"'{event_type}'" in sql
        assert f'event_type="{event_type}"' in service

    assert "INSERT INTO one_location_events" in service
    assert "FeedService().record_event" not in service
    assert "CREATE TRIGGER one_location_circle_events_feed_fanout" in sql
    assert "source_row_id_value := CASE NEW.event_type" in sql
    assert "':member:'" in sql
    assert "NEW.metadata->>'invite_id'" in sql
    assert "COALESCE(NEW.actor_user_id, NEW.id::TEXT)" in sql
    assert "ELSE NEW.id::TEXT" in sql
    assert "ON CONFLICT DO NOTHING" in sql


def test_circle_projection_has_an_exact_bounded_plaintext_contract() -> None:
    sql = _sql(MIGRATION)
    metadata_keys = set(re.findall(r"NEW\.metadata\s*->>\s*'([^']+)'", sql))
    assert metadata_keys == {
        "added_by_label",
        "circle_id",
        "circle_name",
        "counterpart_label",
        "invite_id",
    }
    assert "COALESCE(NEW.metadata, '{}'::jsonb)" not in sql
    for forbidden in (
        "access_token",
        "account_id",
        "ciphertext",
        "coordinates",
        "phone_number",
        "user_id', NEW.metadata",
    ):
        assert forbidden not in sql
    assert "LEFT(BTRIM(NEW.metadata->>'circle_name'), 80)" in sql
    assert "LEFT(BTRIM(NEW.metadata->>'counterpart_label'), 256)" in sql


def test_circle_feed_migration_is_in_the_release_contract() -> None:
    manifest = json.loads(
        (ROOT / "db" / "release_migration_manifest.json").read_text(encoding="utf-8")
    )
    assert MIGRATION.name in manifest["ordered_migrations"]
    assert MIGRATION.name in manifest["groups"]["iam"]
    assert ROLLBACK.exists()
    assert "one_location_circle_events_feed_fanout" in _sql(ROLLBACK)
