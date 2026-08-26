from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION_NAME = "176_one_location_nearby_check_in_preferences.sql"
ROLLBACK_NAME = "176_one_location_nearby_check_in_preferences.rollback.sql"
TABLE = "one_location_nearby_check_in_preferences"
REQUIRED_COLUMNS = {
    "user_id",
    "visible",
    "allow_connection_requests",
    "created_at",
    "updated_at",
}


def _manifest() -> dict:
    return json.loads((ROOT / "db/release_migration_manifest.json").read_text())


def test_nearby_check_in_preferences_migration_is_release_governed_and_reversible() -> None:
    migration = (ROOT / "db/migrations" / MIGRATION_NAME).read_text()
    rollback = (ROOT / "db/migrations/rollback" / ROLLBACK_NAME).read_text()
    manifest = _manifest()

    assert f"CREATE TABLE IF NOT EXISTS {TABLE}" in migration
    assert "REFERENCES actor_profiles(user_id) ON DELETE CASCADE" in migration
    assert "visible BOOLEAN NOT NULL DEFAULT TRUE" in migration
    assert "allow_connection_requests BOOLEAN NOT NULL DEFAULT FALSE" in migration
    assert f"DROP TABLE IF EXISTS {TABLE}" in rollback
    assert "migration_176_rollback_refused_nonempty_table" in rollback
    assert MIGRATION_NAME in manifest["ordered_migrations"]
    assert MIGRATION_NAME in manifest["groups"]["iam"]


def test_every_selected_schema_contract_requires_the_preferences_table() -> None:
    manifest = _manifest()
    base_head = max(int(name.split("_", 1)[0]) for name in manifest["ordered_migrations"])
    uat_head = max(
        base_head,
        *(int(name.split("_", 1)[0]) for name in manifest["environment_overlays"]["uat"]),
    )
    contracts = {
        "prod_core_schema.json": base_head,
        "dev_minimum_schema.json": base_head,
        "uat_integrated_schema.json": uat_head,
    }

    for filename, expected_head in contracts.items():
        contract = json.loads((ROOT / "db/contracts" / filename).read_text())
        assert contract["expected_migration_version"] == expected_head
        assert set(contract["required_tables"][TABLE]) == REQUIRED_COLUMNS


def test_runtime_data_plane_owns_the_preferences_table() -> None:
    contract = json.loads(
        (
            ROOT.parent / "docs/reference/architecture/runtime-db-data-plane-contract.json"
        ).read_text()
    )
    family = next(item for item in contract["table_families"] if item["id"] == "one_location_agent")

    assert TABLE in family["exact_tables"]
