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
    assert "visibility_posture = 'private'" in sql
    assert "ELSE 'consent_required'" in sql


def test_atomic_pkm_mutation_rpc_is_release_and_contract_registered() -> None:
    contract = json.loads((ROOT / "db" / "contracts" / "uat_integrated_schema.json").read_text())
    manifest = json.loads((ROOT / "db" / "release_migration_manifest.json").read_text())
    assert contract["expected_migration_version"] >= 89
    assert "commit_pkm_domain_mutation_v2" in contract["required_functions"]
    assert "089_atomic_pkm_mutation_v2.sql" in manifest["ordered_migrations"]
