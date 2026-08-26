from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION_NAME = "177_connection_voice_preferences.sql"
ROLLBACK_NAME = "177_connection_voice_preferences.rollback.sql"
TABLE = "connection_voice_preferences"
REQUIRED_COLUMNS = {
    "user_id",
    "share_scopes_from_last_request",
    "created_at",
    "updated_at",
}


def _manifest() -> dict:
    return json.loads((ROOT / "db/release_migration_manifest.json").read_text())


def test_connection_voice_preferences_migration_is_release_governed_and_reversible() -> None:
    migration = (ROOT / "db/migrations" / MIGRATION_NAME).read_text()
    rollback = (ROOT / "db/migrations/rollback" / ROLLBACK_NAME).read_text()
    manifest = _manifest()

    assert f"CREATE TABLE IF NOT EXISTS {TABLE}" in migration
    assert "REFERENCES actor_profiles(user_id) ON DELETE CASCADE" in migration
    assert "share_scopes_from_last_request BOOLEAN NOT NULL DEFAULT FALSE" in migration
    assert f"DROP TABLE IF EXISTS {TABLE}" in rollback
    assert "migration_177_rollback_refused_nonempty_table" in rollback
    assert MIGRATION_NAME in manifest["ordered_migrations"]
    assert MIGRATION_NAME in manifest["groups"]["iam"]


def test_selected_schema_contracts_require_the_preferences_table() -> None:
    manifest = _manifest()
    base_head = max(int(name.split("_", 1)[0]) for name in manifest["ordered_migrations"])
    uat_head = max(
        base_head,
        *(int(name.split("_", 1)[0]) for name in manifest["environment_overlays"]["uat"]),
    )
    contracts = {
        "prod_core_schema.json": base_head,
        "uat_integrated_schema.json": uat_head,
    }

    for filename, expected_head in contracts.items():
        contract = json.loads((ROOT / "db/contracts" / filename).read_text())
        assert contract["expected_migration_version"] == expected_head
        assert set(contract["required_tables"][TABLE]) == REQUIRED_COLUMNS

    # dev_minimum intentionally omits the whole connection-graph table family
    # (connection_requests/connections are absent there too) - this table
    # follows the same precedent rather than being added alone.
    dev_minimum = json.loads((ROOT / "db/contracts/dev_minimum_schema.json").read_text())
    assert TABLE not in dev_minimum["required_tables"]
    assert dev_minimum["expected_migration_version"] == base_head


def test_runtime_data_plane_owns_the_preferences_table() -> None:
    contract = json.loads(
        (
            ROOT.parent / "docs/reference/architecture/runtime-db-data-plane-contract.json"
        ).read_text()
    )
    family = next(
        item for item in contract["table_families"] if item["id"] == "two_way_connection_graph"
    )

    assert TABLE in family["exact_tables"]
