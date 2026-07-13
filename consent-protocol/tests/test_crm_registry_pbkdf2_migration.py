import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = ROOT / "db" / "migrations"
MIGRATION = "072_crm_registry_mulesoft_pbkdf2_cbc.sql"


def test_pbkdf2_migration_is_registered_at_release_head():
    assert (MIGRATIONS_DIR / MIGRATION).exists()

    manifest = json.loads((ROOT / "db" / "release_migration_manifest.json").read_text())
    ordered = manifest["ordered_migrations"]

    # 072 is no longer release head (073 follows it); assert it is present,
    # unique, ordered immediately after 071, and immediately before 073.
    assert MIGRATION in ordered
    assert len(ordered) == len(set(ordered))
    idx = ordered.index(MIGRATION)
    assert ordered[idx - 1] == "071_enterprise_crm_registry.sql"
    assert ordered[idx + 1] == "073_crm_registry_mulesoft_simplify.sql"
    assert MIGRATION in manifest["groups"]["iam"]

    contract = json.loads((ROOT / "db" / "contracts" / "uat_integrated_schema.json").read_text())
    assert contract["expected_migration_version"] >= 80
    assert contract["migration_version_policy"] == "exact"


def test_pbkdf2_migration_adds_interop_columns():
    sql = (MIGRATIONS_DIR / MIGRATION).read_text()

    # MuleSoft PBKDF2-AES256-CBC single-blob columns + non-secret KDF params.
    for column in (
        "crm_client_id_blob",
        "crm_client_secret_blob",
        "kdf_salt",
        "kdf_iterations",
    ):
        assert column in sql

    # GCM envelope columns are relaxed to nullable so a PBKDF2 row can omit them.
    assert "ALTER COLUMN crm_client_id_ciphertext DROP NOT NULL" in sql
    assert "ALTER COLUMN crm_client_secret_ciphertext DROP NOT NULL" in sql


def test_pbkdf2_migration_enforces_exactly_one_credential_shape():
    sql = (MIGRATIONS_DIR / MIGRATION).read_text()

    # A CHECK constraint ties encryption_algorithm to the populated columns so a
    # row cannot be half-GCM / half-PBKDF2 or carry an unknown algorithm.
    assert "crm_registry_credential_shape" in sql
    assert "aes-256-gcm" in sql
    assert "pbkdf2-hmacsha256-aes256-cbc" in sql


def test_pbkdf2_migration_introduces_no_plaintext_credential_column():
    sql = (MIGRATIONS_DIR / MIGRATION).read_text()

    # Every credential column added is ciphertext-only (a blob); never a raw secret.
    assert "crm_client_id TEXT" not in sql
    assert "crm_client_secret TEXT" not in sql

    contract = json.loads((ROOT / "db" / "contracts" / "uat_integrated_schema.json").read_text())
    cols = set(contract["required_tables"]["enterprise_crm_registry"])
    assert "crm_client_id" not in cols
    assert "crm_client_secret" not in cols
    assert {"crm_client_id_blob", "crm_client_secret_blob"} <= cols
    # The connector key is never persisted in the row — only non-secret KDF params.
    assert "connector_secrets_key" not in cols
    assert "kdf_salt" in cols
    assert "kdf_iterations" in cols
