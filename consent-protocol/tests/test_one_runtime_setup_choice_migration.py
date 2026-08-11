"""Release contract for the non-secret Connections setup preference."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION_NAME = "130_one_runtime_setup_choice.sql"
CONTRACTS = (
    ROOT / "db" / "contracts" / "dev_minimum_schema.json",
    ROOT / "db" / "contracts" / "uat_integrated_schema.json",
    ROOT / "db" / "contracts" / "prod_core_schema.json",
)


def test_runtime_setup_choice_is_released_as_a_strict_non_secret_field() -> None:
    migration = (ROOT / "db" / "migrations" / MIGRATION_NAME).read_text(encoding="utf-8")
    manifest = json.loads((ROOT / "db" / "release_migration_manifest.json").read_text("utf-8"))

    # Membership, not last-position: asserting this migration is *last* turns
    # every subsequent unrelated migration into a false failure here.
    assert MIGRATION_NAME in manifest["ordered_migrations"]
    assert MIGRATION_NAME in manifest["groups"]["iam"]
    assert "ADD COLUMN IF NOT EXISTS one_runtime_setup_choice TEXT" in migration
    assert "hushh_managed_vertex" in migration
    assert "byok_pending_vault" in migration
    assert "credential reference" in migration

    for contract_path in CONTRACTS:
        contract = json.loads(contract_path.read_text("utf-8"))
        assert contract["expected_migration_version"] >= 130
        assert "one_runtime_setup_choice" in contract["required_tables"]["vault_keys"]
