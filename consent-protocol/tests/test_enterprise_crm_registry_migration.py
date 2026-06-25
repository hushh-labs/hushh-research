import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = ROOT / "db" / "migrations"


def test_enterprise_crm_registry_migration_is_registered_at_release_head():
    migration = MIGRATIONS_DIR / "071_enterprise_crm_registry.sql"
    assert migration.exists()

    manifest = json.loads((ROOT / "db" / "release_migration_manifest.json").read_text())
    ordered = manifest["ordered_migrations"]

    # 071 is registered and unique, ordered immediately after 070.
    assert "071_enterprise_crm_registry.sql" in ordered
    assert len(ordered) == len(set(ordered))
    idx = ordered.index("071_enterprise_crm_registry.sql")
    assert ordered[idx - 1] == "070_developer_registry.sql"
    # Registered under the iam lane (alongside connected systems).
    assert "071_enterprise_crm_registry.sql" in manifest["groups"]["iam"]

    contract = json.loads((ROOT / "db" / "contracts" / "uat_integrated_schema.json").read_text())
    assert contract["migration_version_policy"] == "exact"


def test_enterprise_crm_registry_migration_creates_canonical_tables():
    sql = (MIGRATIONS_DIR / "071_enterprise_crm_registry.sql").read_text()

    assert "CREATE TABLE IF NOT EXISTS enterprise_crm_registry" in sql
    assert "CREATE TABLE IF NOT EXISTS crm_operation_endpoints" in sql

    # AES-256-GCM envelope columns (matches hushh_mcp/vault/encrypt.py EncryptedPayload).
    for column in (
        "crm_client_id_ciphertext",
        "crm_client_id_iv",
        "crm_client_id_tag",
        "crm_client_secret_ciphertext",
        "crm_client_secret_iv",
        "crm_client_secret_tag",
        "encryption_algorithm",
        "key_id",
    ):
        assert column in sql

    # The gateway URL is non-secret config and stored in plaintext.
    assert "crm_mcp_endpoint" in sql
    # Per-operation tool catalog references the registry row.
    assert "REFERENCES enterprise_crm_registry(crm_id)" in sql


def test_enterprise_crm_registry_stores_no_plaintext_credentials():
    """The registry must never declare a plaintext client_id/secret column."""
    sql = (MIGRATIONS_DIR / "071_enterprise_crm_registry.sql").read_text()

    # The migration DDL itself must only declare ciphertext envelope columns.
    assert "crm_client_id_ciphertext" in sql
    assert "crm_client_secret_ciphertext" in sql
    # No bare plaintext credential column may be declared in the DDL.
    assert "crm_client_id TEXT" not in sql
    assert "crm_client_secret TEXT" not in sql

    contract = json.loads((ROOT / "db" / "contracts" / "uat_integrated_schema.json").read_text())
    registry_columns = set(contract["required_tables"]["enterprise_crm_registry"])

    # Only ciphertext envelopes — never a raw secret column.
    assert "crm_client_id" not in registry_columns  # bare plaintext column name
    assert "crm_client_secret" not in registry_columns
    assert "crm_client_id_ciphertext" in registry_columns
    assert "crm_client_secret_ciphertext" in registry_columns
    # Decryption-key material must never be persisted in the row.
    assert "vault_data_key" not in registry_columns
    assert "client_secret_plaintext" not in registry_columns
