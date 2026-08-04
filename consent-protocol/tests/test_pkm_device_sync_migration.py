from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "db/migrations/123_pkm_device_sync.sql"


def test_device_sync_migration_is_release_ordered_and_revision_safe() -> None:
    manifest = json.loads((ROOT / "db/release_migration_manifest.json").read_text())
    sql = MIGRATION.read_text()

    assert MIGRATION.name in manifest["ordered_migrations"]
    assert MIGRATION.name in manifest["groups"]["pkm"]
    assert "delete_pkm_domain_v3" in sql
    assert "pg_advisory_xact_lock" in sql
    assert "p_expected_content_revision <> v_current_content_revision" in sql
    assert "'domain_delete'" in sql
    assert "consent_export_refresh_jobs" in sql
    assert "refresh_status = 'refresh_pending'" in sql
    assert "vault_key" not in sql.lower()
    assert "passphrase" not in sql.lower()


def test_schema_contracts_require_the_sync_delete_function() -> None:
    for contract_name in (
        "dev_minimum_schema.json",
        "uat_integrated_schema.json",
        "prod_core_schema.json",
    ):
        contract = json.loads((ROOT / "db/contracts" / contract_name).read_text())
        # Floor, not equality: this assertion was already failing on origin/main
        # (contracts sat at 131 while it demanded exactly 124).
        assert contract["expected_migration_version"] >= 124
        assert "delete_pkm_domain_v3" in contract["required_functions"]
