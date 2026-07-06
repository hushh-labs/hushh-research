from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"
MANIFEST_PATH = REPO_ROOT / "db" / "release_migration_manifest.json"
SCHEMA_CONTRACT_PATH = REPO_ROOT / "db" / "contracts" / "uat_integrated_schema.json"

MIGRATION_NAME = "078_marketplace_recipient_keys.sql"


def test_marketplace_recipient_keys_migration_is_registered_at_release_head() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    contract = json.loads(SCHEMA_CONTRACT_PATH.read_text(encoding="utf-8"))

    assert MIGRATION_NAME in manifest["ordered_migrations"]
    assert manifest["ordered_migrations"].index(MIGRATION_NAME) > manifest[
        "ordered_migrations"
    ].index("077_marketplace_opportunity_signals.sql")
    assert contract["expected_migration_version"] == 78


def test_marketplace_recipient_keys_migration_creates_recipient_key_table() -> None:
    sql = (MIGRATIONS_DIR / MIGRATION_NAME).read_text(encoding="utf-8")

    assert "CREATE TABLE IF NOT EXISTS marketplace_recipient_keys" in sql
    assert "public_key_jwk JSONB NOT NULL" in sql
    assert "algorithm TEXT NOT NULL DEFAULT 'ECDH-P256-AES256-GCM'" in sql
    assert "status IN ('active', 'rotated', 'revoked')" in sql
    assert "marketplace_recipient_keys_unique_key" in sql
    assert "UNIQUE (user_id, key_id)" in sql
    assert "idx_marketplace_recipient_keys_active" in sql
