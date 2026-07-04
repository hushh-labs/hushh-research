import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = ROOT / "db" / "migrations"


def test_developer_registry_migration_is_registered_at_release_head():
    migration = MIGRATIONS_DIR / "070_developer_registry.sql"
    assert migration.exists()

    manifest = json.loads((ROOT / "db" / "release_migration_manifest.json").read_text())
    ordered = manifest["ordered_migrations"]

    # 070 is registered and unique (071 enterprise_crm_registry is the new head).
    assert "070_developer_registry.sql" in ordered
    assert len(ordered) == len(set(ordered))
    # Registered under its own developer lane.
    assert "070_developer_registry.sql" in manifest["groups"]["developer"]

    contract = json.loads((ROOT / "db" / "contracts" / "uat_integrated_schema.json").read_text())
    assert contract["expected_migration_version"] == 75
    assert contract["migration_version_policy"] == "exact"


def test_developer_registry_migration_creates_canonical_tables():
    sql = (MIGRATIONS_DIR / "070_developer_registry.sql").read_text()

    assert "CREATE TABLE IF NOT EXISTS developer_applications" in sql
    assert "CREATE TABLE IF NOT EXISTS developer_apps" in sql
    assert "CREATE TABLE IF NOT EXISTS developer_tokens" in sql

    # Historical renames must be carried so a DB created from the old
    # developer_api_keys table converges to the canonical names.
    assert "developer_api_keys RENAME TO developer_tokens" in sql
    assert "RENAME COLUMN key_prefix TO token_prefix" in sql
    assert "RENAME COLUMN key_hash TO token_hash" in sql


def test_developer_registry_tables_match_runtime_ensure_tables_contract():
    """Migration 070 must register the same tables ensure_tables() creates."""
    contract = json.loads((ROOT / "db" / "contracts" / "uat_integrated_schema.json").read_text())
    required = contract["required_tables"]

    for table in ("developer_applications", "developer_apps", "developer_tokens"):
        assert table in required, f"{table} missing from uat schema contract"

    # Token rows must never expose a raw secret column; only hashes persist.
    token_columns = set(required["developer_tokens"])
    assert "token_hash" in token_columns
    assert "token_prefix" in token_columns
    assert "raw_token" not in token_columns
    assert "secret" not in token_columns
