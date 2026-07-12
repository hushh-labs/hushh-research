from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_public_profile_foundation_requires_explicit_publication_provenance() -> None:
    sql = (ROOT / "db/migrations/090_public_profile_projection_foundation.sql").read_text()
    assert "public_profile_handle" in sql
    assert "publication_provenance" in sql
    assert "metadata->>'owner_confirmed'" in sql
    assert "THEN 'consent_required'" in sql
    assert "ELSE 'private'" in sql
    assert "never an attr.* consent scope" in sql


def test_public_profile_foundation_is_release_registered() -> None:
    contract = json.loads((ROOT / "db/contracts/uat_integrated_schema.json").read_text())
    manifest = json.loads((ROOT / "db/release_migration_manifest.json").read_text())
    columns = contract["required_tables"]["pkm_default_available_projections"]
    assert contract["expected_migration_version"] == 91
    assert {"public_profile_handle", "publication_provenance", "publication_confirmed_at"} <= set(
        columns
    )
    assert manifest["ordered_migrations"][-1] == "091_public_profile_projection_cutover.sql"


def test_public_profile_cutover_removes_default_available_scope_posture() -> None:
    sql = (ROOT / "db/migrations/091_public_profile_projection_cutover.sql").read_text()
    assert "CHECK (visibility_posture IN ('private', 'consent_required'))" in sql
    assert "missing_publication_provenance" in sql
    assert "not a PKM scope or encrypted-consent authority" in sql


def test_publication_writer_records_explicit_owner_provenance() -> None:
    source = (ROOT / "hushh_mcp/services/personal_knowledge_model_service.py").read_text()
    assert '"publication_provenance": "explicit_vault_owner_projection_v1"' in source
    assert '"owner_confirmed": True' in source
    assert '"publication_contract": "public_profile_projection.v1"' in source


def test_public_projection_readers_fail_closed_without_provenance() -> None:
    pkm_source = (ROOT / "hushh_mcp/services/personal_knowledge_model_service.py").read_text()
    marketplace_source = (ROOT / "hushh_mcp/services/marketplace_catalog_service.py").read_text()
    assert '.neq("publication_provenance", "")' in pkm_source
    assert marketplace_source.count('.neq("publication_provenance", "")') >= 2
    assert 'if not str(row.get("publication_provenance") or "").strip()' in pkm_source
