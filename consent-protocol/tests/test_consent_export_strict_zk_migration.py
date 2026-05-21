from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
MIGRATION_PATH = REPO_ROOT / "db" / "migrations" / "062_consent_exports_export_key_guard.sql"
MANIFEST_PATH = REPO_ROOT / "db" / "release_migration_manifest.json"
MIGRATE_PATH = REPO_ROOT / "db" / "migrate.py"


def test_consent_exports_export_key_guard_migration_blocks_legacy_key_storage() -> None:
    sql = MIGRATION_PATH.read_text(encoding="utf-8")

    assert "consent_exports_no_legacy_export_key" in sql
    assert "CHECK (export_key IS NULL)" in sql
    assert "SET export_key = NULL" in sql
    assert "WHEN wrapped_key_bundle IS NULL THEN 'stale'" in sql
    assert "wrapped_key_bundle = export_key::jsonb" in sql


def test_consent_exports_export_key_guard_is_in_release_and_pkm_lanes() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    ordered = manifest["ordered_migrations"]

    assert "062_consent_exports_export_key_guard.sql" in ordered
    assert ordered.index("062_consent_exports_export_key_guard.sql") > ordered.index(
        "035_strict_zero_knowledge_consent_exports.sql"
    )
    assert "062_consent_exports_export_key_guard.sql" in manifest["groups"]["pkm"]


def test_consent_evolution_explicit_mode_runs_export_key_guard() -> None:
    migrate_py = MIGRATE_PATH.read_text(encoding="utf-8")

    assert '"035_strict_zero_knowledge_consent_exports.sql"' in migrate_py
    assert '"062_consent_exports_export_key_guard.sql"' in migrate_py
