from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION_NAME = "198_actor_identity_verified_phone_uniqueness.sql"
MIGRATION = ROOT / "db" / "migrations" / MIGRATION_NAME
ROLLBACK = (
    ROOT
    / "db"
    / "migrations"
    / "rollback"
    / "198_actor_identity_verified_phone_uniqueness.rollback.sql"
)
MANIFEST = ROOT / "db" / "release_migration_manifest.json"
SCHEMA_CONTRACTS = (
    ROOT / "db" / "contracts" / "dev_minimum_schema.json",
    ROOT / "db" / "contracts" / "prod_core_schema.json",
    ROOT / "db" / "contracts" / "uat_integrated_schema.json",
)

SQL = MIGRATION.read_text(encoding="utf-8")


def _executable(sql: str) -> str:
    return "\n".join(
        line.split("--", 1)[0] for line in sql.splitlines() if not line.lstrip().startswith("--")
    )


def test_verified_phone_uniqueness_migration_is_release_governed() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))

    assert MIGRATION_NAME in manifest["ordered_migrations"]
    assert MIGRATION_NAME in manifest["groups"]["iam"]
    assert manifest["ordered_migrations"].index(MIGRATION_NAME) > manifest[
        "ordered_migrations"
    ].index("197_one_agent_message_feedback.sql")

    for contract_path in SCHEMA_CONTRACTS:
        contract = json.loads(contract_path.read_text(encoding="utf-8"))
        assert contract["expected_migration_version"] >= 198


def test_migration_clears_every_unsafe_verified_binding_before_enforcement() -> None:
    malformed_at = SQL.index("UPDATE actor_identity_cache")
    duplicates_at = SQL.index("WITH ambiguous_verified_phones AS MATERIALIZED")
    check_at = SQL.index("ADD CONSTRAINT actor_identity_cache_verified_phone_e164_check")
    index_at = SQL.index("CREATE UNIQUE INDEX IF NOT EXISTS")

    assert "LOCK TABLE actor_identity_cache IN SHARE ROW EXCLUSIVE MODE" in SQL
    assert malformed_at < duplicates_at < check_at < index_at
    assert "phone_number IS NULL" in SQL[malformed_at:duplicates_at]
    assert "phone_number !~ '^[+][1-9][0-9]{1,14}$'" in SQL[malformed_at:duplicates_at]
    assert "phone_number = NULL" in SQL[malformed_at:duplicates_at]
    assert "phone_verified = FALSE" in SQL[malformed_at:duplicates_at]
    assert "last_synced_at = TIMESTAMPTZ 'epoch'" in SQL[malformed_at:duplicates_at]

    duplicate_cleanup = SQL[duplicates_at:check_at]
    assert "GROUP BY phone_number" in duplicate_cleanup
    assert "HAVING COUNT(*) > 1" in duplicate_cleanup
    assert "phone_number = NULL" in duplicate_cleanup
    assert "phone_verified = FALSE" in duplicate_cleanup
    assert "last_synced_at = TIMESTAMPTZ 'epoch'" in duplicate_cleanup
    for heuristic_winner in (
        "ROW_NUMBER",
        "MIN(user_id)",
        "MAX(user_id)",
        "ORDER BY updated_at",
        "ORDER BY last_synced_at",
    ):
        assert heuristic_winner not in duplicate_cleanup


def test_schema_guards_are_canonical_partial_and_replay_safe() -> None:
    executable = _executable(SQL)

    assert executable.strip().startswith("BEGIN;")
    assert executable.strip().endswith("COMMIT;")
    assert "IF NOT EXISTS (" in executable
    assert "conname = 'actor_identity_cache_verified_phone_e164_check'" in executable
    assert "ADD CONSTRAINT actor_identity_cache_verified_phone_e164_check" in executable
    assert "phone_verified = FALSE" in executable
    assert "phone_number ~ '^[+][1-9][0-9]{1,14}$'" in executable
    assert "CREATE UNIQUE INDEX IF NOT EXISTS uq_actor_identity_cache_verified_phone" in executable
    assert "ON actor_identity_cache(phone_number)" in executable
    assert "WHERE phone_verified = TRUE AND phone_number IS NOT NULL" in executable
    assert "CONCURRENTLY" not in executable


def test_migration_and_rollback_never_expose_or_restore_phone_data() -> None:
    rollback = ROLLBACK.read_text(encoding="utf-8")
    rollback_executable = _executable(rollback)

    assert "irreversible" in SQL.lower()
    assert "re-verify" in SQL.lower()
    assert "irreversible" in rollback.lower()
    assert "re-verify" in rollback.lower()
    assert "RETURNING" not in _executable(SQL)
    assert "RAISE NOTICE" not in _executable(SQL)
    assert "DROP INDEX IF EXISTS uq_actor_identity_cache_verified_phone" in rollback_executable
    assert (
        "DROP CONSTRAINT IF EXISTS actor_identity_cache_verified_phone_e164_check"
        in rollback_executable
    )
    assert "UPDATE actor_identity_cache" not in rollback_executable
    assert "INSERT INTO actor_identity_cache" not in rollback_executable
