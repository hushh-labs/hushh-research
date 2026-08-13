from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_external_crm_dynamic_registry_migration_is_release_managed() -> None:
    migration = (ROOT / "db/migrations/149_external_crm_dynamic_registry.sql").read_text("utf-8")
    rollback = (
        ROOT / "db/migrations/rollback/149_external_crm_dynamic_registry.rollback.sql"
    ).read_text("utf-8")
    manifest = json.loads((ROOT / "db/release_migration_manifest.json").read_text("utf-8"))

    assert "149_external_crm_dynamic_registry.sql" in manifest["ordered_migrations"]
    assert "gateway_credential_profile" in migration
    assert "crm_connection_mode" in migration
    assert "dynamic_registry" in migration
    assert "external_crm" in migration
    assert "Deactivate dynamic-registry CRM rows" in rollback
