from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"
MANIFEST_PATH = REPO_ROOT / "db" / "release_migration_manifest.json"
SCHEMA_CONTRACT_PATH = REPO_ROOT / "db" / "contracts" / "uat_integrated_schema.json"


def test_named_circle_migration_is_registered_as_release_head() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    schema = json.loads(SCHEMA_CONTRACT_PATH.read_text(encoding="utf-8"))
    migration_name = "117_one_location_named_circles.sql"

    assert manifest["ordered_migrations"][-1] == migration_name
    assert migration_name in manifest["groups"]["iam"]
    assert schema["expected_migration_version"] == 117
    assert (MIGRATIONS_DIR / migration_name).exists()
    assert (MIGRATIONS_DIR / "rollback" / "117_one_location_named_circles_down.sql").exists()


def test_named_circle_schema_is_metadata_only_hash_only_and_additive() -> None:
    migration = (MIGRATIONS_DIR / "117_one_location_named_circles.sql").read_text(encoding="utf-8")
    schema = json.loads(SCHEMA_CONTRACT_PATH.read_text(encoding="utf-8"))
    required = schema["required_tables"]

    assert "CREATE TABLE IF NOT EXISTS one_location_circles" in migration
    assert "CREATE TABLE IF NOT EXISTS one_location_circle_memberships" in migration
    assert "CREATE TABLE IF NOT EXISTS one_location_circle_invite_codes" in migration
    assert "code_hash CHAR(64) NOT NULL UNIQUE" in migration
    assert "raw_code" not in migration
    assert "invite_code TEXT" not in migration
    assert migration.count("REFERENCES actor_profiles(user_id) ON DELETE CASCADE") >= 3
    assert "UNIQUE INDEX IF NOT EXISTS uq_one_location_circle_active_invite" in migration
    assert "UNIQUE INDEX IF NOT EXISTS uq_one_location_circle_active_owner" in migration
    assert "ADD COLUMN IF NOT EXISTS source_circle_id UUID" in migration
    assert "REFERENCES one_location_circles(id) ON DELETE CASCADE" in migration
    assert "REFERENCES one_location_circles(id) ON DELETE SET NULL" not in migration
    assert "INSERT INTO connections" not in migration
    assert "INSERT INTO trusted_connections" not in migration
    assert "one_location_circles" in required
    assert "one_location_circle_memberships" in required
    assert "one_location_circle_invite_codes" in required
    assert "source_circle_id" in required["one_location_share_grants"]


def test_named_circle_rollback_removes_only_the_additive_shape() -> None:
    rollback = (MIGRATIONS_DIR / "rollback" / "117_one_location_named_circles_down.sql").read_text(
        encoding="utf-8"
    )

    assert "DROP COLUMN IF EXISTS source_circle_id" in rollback
    assert "DROP TABLE IF EXISTS one_location_circle_invite_codes" in rollback
    assert "DROP TABLE IF EXISTS one_location_circle_memberships" in rollback
    assert "DROP TABLE IF EXISTS one_location_circles" in rollback
    assert "DROP TABLE IF EXISTS connections" not in rollback
    assert "DROP TABLE IF EXISTS trusted_connections" not in rollback
