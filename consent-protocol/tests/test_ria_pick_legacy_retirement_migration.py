"""Contract coverage for the product-authorized RIA Picks clean start."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION_NAME = "129_ria_pick_legacy_retirement.sql"
CONTRACTS = (
    ROOT / "db" / "contracts" / "dev_minimum_schema.json",
    ROOT / "db" / "contracts" / "uat_integrated_schema.json",
    ROOT / "db" / "contracts" / "prod_core_schema.json",
)


def test_legacy_ria_picks_are_retired_without_exporting_their_values() -> None:
    migration = (ROOT / "db" / "migrations" / MIGRATION_NAME).read_text(encoding="utf-8")
    manifest = json.loads((ROOT / "db" / "release_migration_manifest.json").read_text("utf-8"))

    assert MIGRATION_NAME in manifest["ordered_migrations"]
    assert MIGRATION_NAME in manifest["groups"]["iam"]
    assert MIGRATION_NAME in manifest["groups"]["pkm"]
    assert "CREATE TABLE IF NOT EXISTS ria_pick_legacy_retirements" in migration
    assert "DROP TABLE IF EXISTS ria_pick_upload_rows" in migration
    assert "DROP TABLE IF EXISTS ria_pick_uploads" in migration
    assert "legacy_picks_clean_start" in migration
    assert "package_metadata" not in migration
    assert "artifact_projection" not in migration

    for contract_path in CONTRACTS:
        contract = json.loads(contract_path.read_text("utf-8"))
        tables = contract["required_tables"]
        assert contract["expected_migration_version"] >= 129
        assert "ria_pick_uploads" not in tables
        assert tables["ria_pick_legacy_retirements"] == [
            "legacy_upload_id",
            "ria_profile_id",
            "owner_user_id",
            "top_pick_count",
            "retired_at",
            "reason",
        ]
