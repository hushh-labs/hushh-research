from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_atomic_pkm_mutation_rpc_covers_every_commit_surface() -> None:
    sql = (ROOT / "db" / "migrations" / "089_atomic_pkm_mutation_v2.sql").read_text()
    for table in (
        "pkm_blobs",
        "pkm_manifests",
        "pkm_manifest_paths",
        "pkm_scope_registry",
        "pkm_events",
        "pkm_migration_state",
        "consent_export_refresh_jobs",
        "consent_exports",
    ):
        assert table in sql
    assert "pg_advisory_xact_lock" in sql
    assert "p_expected_content_revision" in sql
    assert "merge_pkm_domain_summary" in sql
    assert "row_data.visibility_posture" in sql
    assert "unsupported_pkm_scope_visibility_posture" in sql


def test_atomic_pkm_mutation_rpc_is_release_and_contract_registered() -> None:
    contract = json.loads((ROOT / "db" / "contracts" / "uat_integrated_schema.json").read_text())
    manifest = json.loads((ROOT / "db" / "release_migration_manifest.json").read_text())
    assert contract["expected_migration_version"] >= 96
    assert "commit_pkm_domain_mutation_v2" in contract["required_functions"]
    assert "commit_pkm_domain_mutation_v3" in contract["required_functions"]
    assert "089_atomic_pkm_mutation_v2.sql" in manifest["ordered_migrations"]
    assert "096_atomic_pkm_mutation_v3_scope_posture.sql" in manifest["ordered_migrations"]


def test_atomic_pkm_mutation_v3_preserves_scope_posture_fields() -> None:
    sql = (ROOT / "db" / "migrations" / "096_atomic_pkm_mutation_v3_scope_posture.sql").read_text()
    assert "commit_pkm_domain_mutation_v2" in sql
    assert "default_projection_ready = COALESCE(row_data.default_projection_ready" in sql
    assert "default_projection_updated_at = row_data.default_projection_updated_at" in sql
    assert "owner_consent_override = COALESCE(row_data.owner_consent_override" in sql
    assert "visibility_posture = row_data.visibility_posture" in sql
    assert "unsupported_pkm_scope_visibility_posture" in sql
    assert "v_result := commit_pkm_domain_mutation_v2" in sql
