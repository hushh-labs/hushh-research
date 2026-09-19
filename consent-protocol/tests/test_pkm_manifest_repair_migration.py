from pathlib import Path

ROOT = Path(__file__).parents[1]
MIGRATION = ROOT / "db/migrations/226_pkm_manifest_path_repair.sql"
ROLLBACK = ROOT / "db/migrations/rollback/226_pkm_manifest_path_repair.rollback.sql"


def test_manifest_repair_migration_is_revision_checked_and_metadata_only():
    sql = MIGRATION.read_text(encoding="utf-8")

    assert "CREATE OR REPLACE FUNCTION repair_pkm_manifest_paths_v1" in sql
    assert "p_expected_content_revision INTEGER" in sql
    assert "p_expected_manifest_revision INTEGER" in sql
    assert "repair_receipt_id" in sql
    assert "SET manifest_revision = p_next_manifest_revision" in sql
    assert "target.id = incoming.id" in sql
    assert "DELETE FROM pkm_manifest_paths" not in sql
    assert "DELETE FROM pkm_scope_registry" not in sql
    assert "INSERT INTO pkm_events" in sql
    assert "'repair_kind', 'historical_entity_path_token'" in sql


def test_manifest_repair_rollback_drops_exact_function_signature():
    rollback = ROLLBACK.read_text(encoding="utf-8")
    assert "DROP FUNCTION IF EXISTS repair_pkm_manifest_paths_v1" in rollback
    assert rollback.count("TEXT") == 3
    assert rollback.count("INTEGER") == 3
    assert rollback.count("JSONB") == 6
