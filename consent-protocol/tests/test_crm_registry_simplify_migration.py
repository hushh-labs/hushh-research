import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = ROOT / "db" / "migrations"
MIGRATION = "073_crm_registry_mulesoft_simplify.sql"


def test_simplify_migration_is_registered_at_release_head():
    assert (MIGRATIONS_DIR / MIGRATION).exists()

    manifest = json.loads((ROOT / "db" / "release_migration_manifest.json").read_text())
    ordered = manifest["ordered_migrations"]

    # 073 is unique and ordered between the CRM PBKDF2 migration and later PKM head.
    assert len(ordered) == len(set(ordered))
    idx = ordered.index(MIGRATION)
    assert ordered[idx - 1] == "072_crm_registry_mulesoft_pbkdf2_cbc.sql"
    assert ordered[idx + 1] == "074_pkm_scope_registry_owner_consent_override.sql"
    assert MIGRATION in manifest["groups"]["iam"]

    contract = json.loads((ROOT / "db" / "contracts" / "uat_integrated_schema.json").read_text())
    assert contract["expected_migration_version"] == 80
    assert contract["migration_version_policy"] == "exact"


def test_simplify_migration_adds_delete_endpoint():
    sql = (MIGRATIONS_DIR / MIGRATION).read_text()

    # Salesforce delete uses a different endpoint path than CRUD-read.
    assert "crm_delete_endpoint" in sql

    contract = json.loads((ROOT / "db" / "contracts" / "uat_integrated_schema.json").read_text())
    cols = set(contract["required_tables"]["enterprise_crm_registry"])
    assert "crm_delete_endpoint" in cols
    # The original CRUD endpoint column is preserved (not dropped/renamed away).
    assert "crm_mcp_endpoint" in cols


def test_simplify_migration_relaxes_kdf_params_but_keeps_blobs_required():
    sql = (MIGRATIONS_DIR / MIGRATION).read_text()

    # The credential-shape guard is rebuilt; a PBKDF2 row must still carry both
    # ciphertext blobs, but salt/iterations are no longer mandatory on the row
    # (they resolve from connector config when omitted).
    assert "crm_registry_credential_shape" in sql
    assert "crm_client_id_blob     IS NOT NULL" in sql
    assert "crm_client_secret_blob IS NOT NULL" in sql
    # kdf_salt / kdf_iterations must NOT be required by the new constraint body.
    # (They may appear in comments, so check the CHECK clause specifically.)
    check_start = sql.index("ADD CONSTRAINT crm_registry_credential_shape")
    check_body = sql[check_start:]
    assert "kdf_salt               IS NOT NULL" not in check_body
    assert "kdf_iterations         IS NOT NULL" not in check_body


def test_simplify_migration_introduces_no_plaintext_credential_column():
    sql = (MIGRATIONS_DIR / MIGRATION).read_text()

    # No raw-secret column is ever added; credentials stay ciphertext-only.
    assert "crm_client_id TEXT" not in sql
    assert "crm_client_secret TEXT" not in sql

    contract = json.loads((ROOT / "db" / "contracts" / "uat_integrated_schema.json").read_text())
    cols = set(contract["required_tables"]["enterprise_crm_registry"])
    assert "crm_client_id" not in cols
    assert "crm_client_secret" not in cols
    # The connector key/password is never persisted in the row.
    assert "connector_secrets_key" not in cols
    assert "crm_delete_endpoint" not in {"crm_client_id", "crm_client_secret"}
