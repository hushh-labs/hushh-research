from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"
MANIFEST_PATH = REPO_ROOT / "db" / "release_migration_manifest.json"
SCHEMA_CONTRACT_PATH = REPO_ROOT / "db" / "contracts" / "uat_integrated_schema.json"

MIGRATION_NAME = "082_marketplace_request_revoked_status.sql"


def test_revoked_status_migration_is_registered_at_release_head() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    contract = json.loads(SCHEMA_CONTRACT_PATH.read_text(encoding="utf-8"))

    ordered = manifest["ordered_migrations"]
    assert MIGRATION_NAME in ordered
    assert len(ordered) == len(set(ordered))
    # This migration is the new release head.
    assert ordered.index(MIGRATION_NAME) > ordered.index("081_marketplace_delivery_envelopes.sql")
    assert contract["expected_migration_version"] >= 82
    assert contract["migration_version_policy"] == "exact"


def test_revoked_status_migration_widens_the_status_check() -> None:
    sql = (MIGRATIONS_DIR / MIGRATION_NAME).read_text(encoding="utf-8")

    # Drops the original inline CHECK (auto-named <table>_<column>_check) and
    # re-adds one that admits 'revoked' so owner-scoped revoke can persist.
    assert "DROP CONSTRAINT IF EXISTS marketplace_access_requests_status_check" in sql
    assert "CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'revoked'))" in sql
