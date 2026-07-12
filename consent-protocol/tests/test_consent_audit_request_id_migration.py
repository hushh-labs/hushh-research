import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION_NAME = "087_consent_audit_request_id_text.sql"


def test_consent_audit_request_id_migration_is_registered_at_release_head():
    migration = ROOT / "db" / "migrations" / MIGRATION_NAME
    assert migration.exists()

    sql = migration.read_text(encoding="utf-8")
    assert "ALTER TABLE consent_audit" in sql
    assert "ALTER COLUMN request_id TYPE TEXT" in sql

    manifest = json.loads((ROOT / "db" / "release_migration_manifest.json").read_text())
    assert manifest["ordered_migrations"][-1] == MIGRATION_NAME
    assert MIGRATION_NAME in manifest["groups"]["iam"]

    contract = json.loads((ROOT / "db" / "contracts" / "uat_integrated_schema.json").read_text())
    assert contract["expected_migration_version"] == 87
    assert contract["migration_version_policy"] == "exact"
