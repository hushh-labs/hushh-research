import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = "337_initial_contacts_onboarding.sql"
COLUMNS = {
    "initial_contacts_source",
    "initial_contacts_welcome_acknowledged",
    "initial_contacts_circle_id",
}


def test_initial_contacts_lifecycle_is_registered_in_all_release_contracts():
    manifest = json.loads((ROOT / "db/release_migration_manifest.json").read_text(encoding="utf-8"))
    assert MIGRATION in manifest["ordered_migrations"]
    assert MIGRATION in manifest["groups"]["iam"]
    for contract_file in (ROOT / "db/contracts").glob("*_schema.json"):
        contract = json.loads(contract_file.read_text(encoding="utf-8"))
        assert COLUMNS <= set(contract["required_tables"]["vault_keys"])
        assert contract["expected_migration_version"] >= 337


def test_rollback_removes_metadata_without_deleting_shared_relationships():
    manifest = json.loads((ROOT / "db/release_migration_manifest.json").read_text(encoding="utf-8"))
    rollback = (
        (ROOT / "db/migrations" / manifest["rollback_migrations"][MIGRATION])
        .read_text(encoding="utf-8")
        .lower()
    )
    assert all(f"drop column if exists {column}" in rollback for column in COLUMNS)
    assert "delete from" not in rollback and "drop table" not in rollback
    migration = (ROOT / "db/migrations" / MIGRATION).read_text(encoding="utf-8").lower()
    assert "update public.vault_keys" not in migration
    assert "default false" not in migration
