from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = "346_one_location_recipient_feed_clear.sql"
ROLLBACK = "rollback/346_one_location_recipient_feed_clear.rollback.sql"
COLUMN = "recipient_cleared_at"


def _manifest() -> dict:
    return json.loads((ROOT / "db/release_migration_manifest.json").read_text(encoding="utf-8"))


def test_recipient_feed_clear_is_additive_and_keeps_state_on_rollback() -> None:
    migration = (ROOT / "db/migrations" / MIGRATION).read_text(encoding="utf-8")
    rollback = (ROOT / "db/migrations" / ROLLBACK).read_text(encoding="utf-8").lower()

    # Nullable, no default and no backfill: no table rewrite under the serving
    # revision, which reads grants with SELECT g.* and ignores the column.
    assert (
        f"ADD COLUMN IF NOT EXISTS {COLUMN} TIMESTAMPTZ;" in migration
        and "DEFAULT" not in migration
        and "UPDATE " not in migration
    )
    # A code rollback keeps people's clears, as 331_feed_dismissal does.
    assert "drop" not in rollback and "delete" not in rollback


def test_recipient_feed_clear_is_registered_in_every_release_contract() -> None:
    manifest = _manifest()
    assert MIGRATION in manifest["ordered_migrations"]
    assert manifest["rollback_migrations"][MIGRATION] == ROLLBACK
    version = int(MIGRATION.split("_", 1)[0])
    for contract_file in sorted((ROOT / "db/contracts").glob("*_schema.json")):
        contract = json.loads(contract_file.read_text(encoding="utf-8"))
        assert contract["expected_migration_version"] >= version, contract_file.name
        grants = contract["required_tables"].get("one_location_share_grants")
        if grants is not None:
            assert COLUMN in grants, contract_file.name
