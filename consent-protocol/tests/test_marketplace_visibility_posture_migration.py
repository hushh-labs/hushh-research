from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"
MANIFEST_PATH = REPO_ROOT / "db" / "release_migration_manifest.json"
SCHEMA_CONTRACT_PATH = REPO_ROOT / "db" / "contracts" / "uat_integrated_schema.json"


def test_marketplace_visibility_posture_migration_is_registered() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    schema_contract = json.loads(SCHEMA_CONTRACT_PATH.read_text(encoding="utf-8"))
    migration_name = "066_marketplace_visibility_posture.sql"

    assert migration_name in manifest["ordered_migrations"]
    assert migration_name in manifest["groups"]["iam"]
    assert manifest["ordered_migrations"].index(migration_name) > manifest[
        "ordered_migrations"
    ].index("065_one_location_retention_indexes.sql")
    assert schema_contract["expected_migration_version"] == 79


def test_marketplace_visibility_posture_migration_adds_safe_visibility_columns() -> None:
    sql = (MIGRATIONS_DIR / "066_marketplace_visibility_posture.sql").read_text(encoding="utf-8")

    assert "ADD COLUMN IF NOT EXISTS exposure_enabled BOOLEAN NOT NULL DEFAULT TRUE" in sql
    assert "ADD COLUMN IF NOT EXISTS visibility_posture TEXT NOT NULL" in sql
    assert "marketplace_public_profiles_visibility_posture_check" in sql
    assert "visibility_posture IN" in sql
    assert "private" in sql
    assert "default_available" in sql
    assert "idx_marketplace_public_profiles_visibility" in sql
