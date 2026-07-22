from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = "115_one_location_connection_visibility.sql"


def test_connection_visibility_migration_is_in_release_and_schema_contracts() -> None:
    manifest = json.loads((ROOT / "db/release_migration_manifest.json").read_text())
    ordered = manifest["ordered_migrations"]

    assert ordered[-1] == MIGRATION
    assert MIGRATION in manifest["groups"]["iam"]
    assert (ROOT / "db/migrations" / MIGRATION).exists()

    for contract_name in (
        "uat_integrated_schema.json",
        "dev_minimum_schema.json",
        "prod_core_schema.json",
    ):
        contract = json.loads((ROOT / "db/contracts" / contract_name).read_text())
        required = contract["required_tables"]
        assert contract["expected_migration_version"] == 115
        assert "access_origin" in required["one_location_share_grants"]
        assert "one_location_visibility_preferences" in required
        assert "one_location_visibility_exclusions" in required


def test_connection_visibility_migration_is_coordinate_free_and_pair_unique() -> None:
    sql = (ROOT / "db/migrations" / MIGRATION).read_text().lower()

    assert "idx_one_location_visibility_active_pair" in sql
    assert "connections_visibility" in sql
    for prohibited in ("latitude", "longitude", "address", "map_payload"):
        assert prohibited not in sql
