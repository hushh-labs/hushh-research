from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION_NAME = "199_one_location_auto_approve_multi_circle_scope.sql"
ROLLBACK_NAME = "199_one_location_auto_approve_multi_circle_scope.rollback.sql"
TABLE = "one_location_auto_approve_preferences"
REQUIRED_COLUMNS = {
    "user_id",
    "enabled",
    "scope_kind",
    "circle_id",
    "circle_ids",
    "enabled_at",
    "rule_version",
    "created_at",
    "updated_at",
}


def _manifest() -> dict:
    return json.loads((ROOT / "db/release_migration_manifest.json").read_text())


def test_multi_circle_scope_migration_is_release_governed_and_reversible() -> None:
    migration = (ROOT / "db/migrations" / MIGRATION_NAME).read_text()
    rollback = (ROOT / "db/migrations/rollback" / ROLLBACK_NAME).read_text()
    manifest = _manifest()

    assert f"ALTER TABLE {TABLE}" in migration
    assert "ADD COLUMN IF NOT EXISTS circle_ids UUID[]" in migration
    # circle_id (singular) is untouched -- existing single-Circle preferences
    # must keep working without a data migration.
    assert "DROP COLUMN" not in migration
    assert "scope_kind = 'circles'" in migration
    assert "cardinality(circle_ids) > 0" in migration

    # Rollback fails closed: anyone on the new scope is disabled, not
    # silently reinterpreted, before the column is dropped.
    assert "SET enabled = FALSE" in rollback
    assert "WHERE scope_kind = 'circles'" in rollback
    assert "DROP COLUMN IF EXISTS circle_ids" in rollback

    assert MIGRATION_NAME in manifest["ordered_migrations"]
    assert MIGRATION_NAME in manifest["groups"]["iam"]


def test_every_selected_schema_contract_requires_the_multi_circle_column() -> None:
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
