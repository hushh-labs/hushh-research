"""Release and privacy contract for Direct Message -> Feed projection."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION_NAME = "268_direct_message_feed_projection.sql"
ROLLBACK_NAME = "268_direct_message_feed_projection.rollback.sql"


def test_direct_message_feed_projection_is_recipient_only_plaintext_free_and_reversible() -> None:
    migration = (ROOT / "db" / "migrations" / MIGRATION_NAME).read_text(encoding="utf-8")
    rollback = (ROOT / "db" / "migrations" / "rollback" / ROLLBACK_NAME).read_text(encoding="utf-8")
    manifest = json.loads((ROOT / "db" / "release_migration_manifest.json").read_text())

    normalized = migration.lower()
    assert "project_direct_message_feed_event" in normalized
    assert "remove_direct_message_feed_event" in normalized
    assert "'direct_message_received'" in normalized
    assert "v_recipient_user_id" in normalized
    assert "new.sender_user_id" in normalized
    assert "new.id::text" in normalized
    assert "'{}'::jsonb" in normalized
    assert "feed_event_counterparts" in normalized
    assert "after insert on public.messages" in normalized
    assert "after delete on public.messages" in normalized
    # A Feed projection must never become a second plaintext or envelope store.
    assert "content_ciphertext" not in normalized
    assert "content_iv" not in normalized
    assert "message_preview" not in normalized

    assert "delete from public.feed_events" in rollback.lower()
    assert "direct_message_received" in rollback
    assert "delete from public.messages" not in rollback.lower()
    assert MIGRATION_NAME in manifest["ordered_migrations"]
    assert manifest["rollback_migrations"][MIGRATION_NAME] == f"rollback/{ROLLBACK_NAME}"


def test_direct_message_feed_projection_is_in_each_schema_contract() -> None:
    for contract_name in (
        "dev_minimum_schema.json",
        "uat_integrated_schema.json",
        "prod_core_schema.json",
    ):
        contract = json.loads((ROOT / "db" / "contracts" / contract_name).read_text())
        assert contract["expected_migration_version"] >= 268
        assert "project_direct_message_feed_event" in contract["required_functions"]
        assert "remove_direct_message_feed_event" in contract["required_functions"]
