from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"
MANIFEST_PATH = REPO_ROOT / "db" / "release_migration_manifest.json"
SCHEMA_CONTRACT_PATH = REPO_ROOT / "db" / "contracts" / "uat_integrated_schema.json"

MIGRATION_NAME = "079_marketplace_delivery_envelopes.sql"


def test_marketplace_delivery_envelopes_migration_is_registered_at_release_head() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    contract = json.loads(SCHEMA_CONTRACT_PATH.read_text(encoding="utf-8"))

    assert MIGRATION_NAME in manifest["ordered_migrations"]
    assert manifest["ordered_migrations"].index(MIGRATION_NAME) > manifest[
        "ordered_migrations"
    ].index("078_marketplace_recipient_keys.sql")
    # The contract version tracks the release head, which this migration now is.
    assert contract["expected_migration_version"] == 80


def test_marketplace_delivery_envelopes_migration_creates_envelope_table() -> None:
    sql = (MIGRATIONS_DIR / MIGRATION_NAME).read_text(encoding="utf-8")

    assert "CREATE TABLE IF NOT EXISTS marketplace_delivery_envelopes" in sql
    # Keyed to the approved request, and delivery is torn down with it.
    assert "REFERENCES marketplace_access_requests(id) ON DELETE CASCADE" in sql
    # Ciphertext-only: sealed material, no plaintext slice column.
    assert "ciphertext TEXT NOT NULL" in sql
    assert "iv TEXT NOT NULL" in sql
    assert "sender_ephemeral_public_key_jwk JSONB NOT NULL" in sql
    assert "algorithm TEXT NOT NULL DEFAULT 'ECDH-P256-AES256-GCM'" in sql
    assert "idx_marketplace_delivery_envelopes_request" in sql
    # The request points at its latest delivered envelope (One Location analog).
    assert "latest_envelope_id UUID" in sql
    assert "ALTER TABLE marketplace_access_requests" in sql
