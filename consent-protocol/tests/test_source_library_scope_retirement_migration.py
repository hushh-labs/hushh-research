from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = "142_source_library_scope_retirement.sql"


def test_source_library_retirement_migration_is_registered_in_every_owning_lane() -> None:
    manifest = json.loads((ROOT / "db" / "release_migration_manifest.json").read_text())

    assert MIGRATION in manifest["ordered_migrations"]
    for group in ("iam", "pkm", "developer"):
        assert MIGRATION in manifest["groups"][group]


def test_source_library_retirement_migration_closes_live_delivery_without_deleting_audit() -> None:
    sql = (ROOT / "db" / "migrations" / MIGRATION).read_text()

    assert "INSERT INTO consent_audit" in sql
    assert "'REVOKED'" in sql
    assert "'CANCELLED'" in sql
    assert "DELETE FROM consent_exports" in sql
    assert "DELETE FROM consent_export_refresh_jobs" in sql
    assert "DELETE FROM consent_audit" not in sql
    assert "attr.source_library.%" in sql
    assert "top_level_scope_paths = ARRAY[]::TEXT[]" in sql
    assert "externalizable_paths = ARRAY[]::TEXT[]" in sql
    assert "exposure_eligibility = FALSE" in sql
    assert "visibility_posture = 'private'" in sql
    assert "DELETE FROM pkm_default_available_projections" in sql
