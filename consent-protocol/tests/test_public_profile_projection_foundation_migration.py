from __future__ import annotations

import json
from pathlib import Path

import pytest

from tests.pkm_conformance.postgres_harness import find_pg_bin
from tests.test_migrations_are_replay_safe import replay_pg  # noqa: F401

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
    assert contract["expected_migration_version"] >= 91
    assert {"public_profile_handle", "publication_provenance", "publication_confirmed_at"} <= set(
        columns
    )
    assert "091_public_profile_projection_cutover.sql" in manifest["ordered_migrations"]


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


def test_selected_profile_bridge_has_release_foundation_and_preserving_rollback():
    manifest = json.loads((ROOT / "db/release_migration_manifest.json").read_text())
    foundation = "399_public_profile_release_foundation.sql"
    ordered = manifest["ordered_migrations"]
    assert ordered.count(foundation) == 1
    assert ordered.index(foundation) < ordered.index("403_public_profile_bridge.sql")
    rollback = manifest["rollback_migrations"][foundation]
    assert (ROOT / "db/migrations" / rollback).is_file()
    for name in ("prod_core_schema", "uat_integrated_schema", "dev_minimum_schema"):
        contract = json.loads((ROOT / f"db/contracts/{name}.json").read_text())
        assert {"claim_batch", "claim_batch_key", "assessment_request"} <= set(
            contract["required_tables"]["one_profile_discovery_jobs"]
        )
        assert "prepared_payload" in contract["required_tables"]["one_public_profile_entities"]


@pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")
def test_profile_release_foundation_preserves_feed_and_erasure_on_replay(replay_pg):  # noqa: F811
    from psycopg2.errors import CheckViolation, UndefinedTable

    pg = replay_pg
    migrations = ROOT / "db/migrations"
    pg.execute("""
        CREATE TABLE actor_profiles(user_id TEXT PRIMARY KEY);
        CREATE TABLE feed_events(user_id TEXT, source_domain TEXT NOT NULL,
            source_row_id TEXT, CONSTRAINT feed_events_source_domain_check
            CHECK (source_domain IN ('consent','location','kai','kyc',
                'connected_systems','connections','pwm')));
        CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    """)
    pg.apply_file(migrations / "201_account_deletion_tombstones.sql")
    pg.execute("INSERT INTO feed_events VALUES ('active-owner','pwm','kept-event')")
    before = pg.execute(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
        "WHERE conname='feed_events_source_domain_check'"
    )
    with pytest.raises(UndefinedTable):
        pg.apply_file(migrations / "403_public_profile_bridge.sql")
    foundation = migrations / "399_public_profile_release_foundation.sql"
    for _ in range(2):
        pg.apply_file(foundation)
        pg.apply_file(migrations / "403_public_profile_bridge.sql")
    assert (
        pg.execute(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
            "WHERE conname='feed_events_source_domain_check'"
        )
        == before
    )
    tables = pg.execute(
        "SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace "
        "AND relrowsecurity AND relname LIKE 'one_%profile%'"
    )
    assert len(tables) == 8
    for (table,) in tables:
        assert pg.execute(
            "SELECT has_table_privilege('anon',%s,'SELECT'), "
            "has_table_privilege('authenticated',%s,'SELECT'), "
            "has_table_privilege('service_role',%s,'SELECT')",
            (table, table, table),
        ) == [(False, False, True)]
    pg.execute(
        "INSERT INTO one_profile_discovery_jobs(user_id,consent_version) "
        "VALUES ('active-owner','synthetic-policy')"
    )
    pg.execute(
        "INSERT INTO account_deletion_tombstones(user_id_hash) "
        "VALUES ('sha256:' || encode(digest('deleted-owner','sha256'),'hex'))"
    )
    with pytest.raises(CheckViolation, match="account identity is deleted"):
        pg.execute(
            "INSERT INTO one_profile_discovery_jobs(user_id,consent_version) "
            "VALUES ('deleted-owner','synthetic-policy')"
        )
    pg.apply_file(migrations / "rollback/399_public_profile_release_foundation.rollback.sql")
    assert pg.execute("SELECT user_id FROM one_profile_discovery_jobs") == [("active-owner",)]
    assert pg.execute("SELECT source_row_id FROM feed_events") == [("kept-event",)]
