from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"
MANIFEST_PATH = REPO_ROOT / "db" / "release_migration_manifest.json"
SCHEMA_CONTRACT_PATH = REPO_ROOT / "db" / "contracts" / "uat_integrated_schema.json"


def test_one_location_public_invite_migration_sequence_is_current_and_unique() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    schema_contract = json.loads(SCHEMA_CONTRACT_PATH.read_text(encoding="utf-8"))
    ordered = manifest["ordered_migrations"]
    migration_name = "064_one_location_public_invites.sql"

    assert migration_name in ordered
    assert (MIGRATIONS_DIR / migration_name).exists()
    assert ordered.index(migration_name) > ordered.index("063_pkm_default_available_visibility.sql")
    assert "062_one_location_public_invites.sql" not in ordered
    assert "062_one_location_public_invites.sql" not in {
        path.name for path in MIGRATIONS_DIR.glob("*one_location_public_invites.sql")
    }
    assert len(ordered) == len(set(ordered))
    assert schema_contract["expected_migration_version"] == 64
    assert migration_name in manifest["groups"]["iam"]


def test_one_location_public_invite_migration_has_hash_only_and_abuse_indexes() -> None:
    sql = (MIGRATIONS_DIR / "064_one_location_public_invites.sql").read_text(encoding="utf-8")

    assert "public_code_hash" in sql
    assert "public_code TEXT" not in sql
    assert "public_token" not in sql
    assert "idx_one_location_public_invite_submissions_phone_once" in sql
    assert "idx_one_location_public_invite_submissions_fingerprint_window" in sql
