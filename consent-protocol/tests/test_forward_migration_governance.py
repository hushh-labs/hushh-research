# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Contract tests for Wave 1 SQL ledger envelopes, forward governance, and parked freeze."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
from pathlib import Path

import pytest

from db.migration_authority import (
    MigrationAuthorityError,
    MigrationManifestEntryV2,
    MigrationMode,
    build_manifest_entries,
)
from db.migration_forward_governance import (
    FROZEN_PARKED_MIGRATIONS,
    inspect_migration_sql_governance,
    verify_parked_lane_freeze,
)
from db.migration_sql_envelope import (
    is_outer_transaction_control,
    prepare_execution_sql,
    scan_top_level_sql_statements,
)
from db.private_agent_adoption import execution_sql

REPO_ROOT = Path(__file__).resolve().parents[2]
DB_DIR = REPO_ROOT / "consent-protocol" / "db"
MIGRATIONS_DIR = DB_DIR / "migrations"
PARKED_DIR = MIGRATIONS_DIR / "parked"
DEV_MANIFEST_PATH = DB_DIR / "dev_migration_manifest.json"


def _synthetic_entry(
    filename: str, sql: str, *, transactional: bool = True
) -> MigrationManifestEntryV2:
    return MigrationManifestEntryV2(
        migration_id=filename.split("_", 1)[0],
        filename=filename,
        checksum_sha256=hashlib.sha256(sql.encode("utf-8")).hexdigest(),
        sql=sql,
        transactional=transactional,
    )


def test_every_repo_migration_and_adapter_produces_clean_ledger_envelope() -> None:
    """All 411+ canonical and 82 parked SQL files unwrap without mutating checksums."""

    for folder in (MIGRATIONS_DIR, PARKED_DIR):
        filenames = tuple(sorted(path.name for path in folder.glob("*.sql")))
        entries = build_manifest_entries(folder, filenames)
        assert entries
        for entry in entries:
            raw_bytes = (folder / entry.filename).read_bytes()
            assert entry.checksum_sha256 == hashlib.sha256(raw_bytes).hexdigest()
            adapted = execution_sql(entry, replay=None)
            prepared = prepare_execution_sql(
                entry,
                adapted,
                mode_value=MigrationMode.LEDGER.value,
                error_cls=MigrationAuthorityError,
            )
            stmts = scan_top_level_sql_statements(
                prepared,
                filename=entry.filename,
                error_cls=MigrationAuthorityError,
            )
            assert stmts, f"{entry.filename} produced zero statements"
            assert not any(is_outer_transaction_control(stmt.keywords) for stmt in stmts), (
                f"{entry.filename} retained outer transaction control in ledger mode"
            )
            assert (
                prepare_execution_sql(
                    entry,
                    adapted,
                    mode_value=MigrationMode.REPLAY.value,
                    error_cls=MigrationAuthorityError,
                )
                == adapted
            )


def test_envelope_lexer_preserves_savepoints_and_rejects_malformed_envelopes() -> None:
    savepoint_sql = (
        "BEGIN;\n"
        "SAVEPOINT sp_probe;\n"
        "ROLLBACK TO SAVEPOINT sp_probe;\n"
        "RELEASE SAVEPOINT sp_probe;\n"
        "COMMIT;"
    )
    entry = _synthetic_entry("458_savepoint_ok.sql", savepoint_sql)
    unwrapped = prepare_execution_sql(
        entry,
        savepoint_sql,
        mode_value="ledger",
        error_cls=MigrationAuthorityError,
    )
    assert "SAVEPOINT sp_probe;" in unwrapped
    assert "BEGIN;" not in unwrapped and "COMMIT;" not in unwrapped

    bad_cases = (
        ("459_unclosed.sql", "BEGIN;\nSELECT 1;\n", True),
        ("459_orphan_commit.sql", "SELECT 1;\nCOMMIT;\n", True),
        ("459_multi_tx.sql", "BEGIN;\nSELECT 1;\nCOMMIT;\nBEGIN;\nSELECT 2;\nCOMMIT;\n", True),
        (
            "459_isolation_mod.sql",
            "BEGIN ISOLATION LEVEL SERIALIZABLE;\nSELECT 1;\nCOMMIT;\n",
            True,
        ),
        ("459_top_rollback.sql", "BEGIN;\nSELECT 1;\nROLLBACK;\n", True),
        (
            "459_nontx_wrapped.sql",
            "BEGIN;\nCREATE INDEX CONCURRENTLY idx_x ON t(a);\nCOMMIT;\n",
            False,
        ),
    )
    for name, bad_sql, tx_flag in bad_cases:
        bad_entry = _synthetic_entry(name, bad_sql, transactional=tx_flag)
        with pytest.raises(MigrationAuthorityError):
            prepare_execution_sql(
                bad_entry,
                bad_sql,
                mode_value="ledger",
                error_cls=MigrationAuthorityError,
            )


def test_forward_governance_enforces_unwrapped_ddl_concurrent_header_and_actor_spine() -> None:
    spec = importlib.util.spec_from_file_location(
        "verify_release_migration_contract_wave1",
        REPO_ROOT / "scripts" / "ops" / "verify_release_migration_contract.py",
    )
    assert spec is not None and spec.loader is not None
    verifier = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = verifier
    spec.loader.exec_module(verifier)
    report = verifier.build_report()
    assert report["status"] == "ok", report["violations"]

    clean_459 = (
        "-- Comment mentioning REFERENCES vault_keys(user_id) is ignored\n"
        "CREATE TABLE IF NOT EXISTS wave1_clean (\n"
        "  actor_id UUID PRIMARY KEY REFERENCES actor_profiles(actor_id) ON DELETE CASCADE,\n"
        "  note TEXT NOT NULL DEFAULT 'REFERENCES vault_keys(user_id)'\n"
        ");\n"
    )
    assert (
        inspect_migration_sql_governance(
            "459_clean_actor_table.sql",
            clean_459,
            numeric_version=459,
            enforce_forward_rules=True,
        )
        == []
    )

    assert inspect_migration_sql_governance(
        "459_wrapped.sql",
        "BEGIN;\nSELECT 1;\nCOMMIT;\n",
        numeric_version=459,
        enforce_forward_rules=True,
    ) == ["forward_migration_outer_transaction_forbidden:459_wrapped.sql"]

    assert inspect_migration_sql_governance(
        "459_vault_fk.sql",
        "CREATE TABLE bad_t (user_id TEXT REFERENCES vault_keys(user_id));\n",
        numeric_version=459,
        enforce_forward_rules=True,
    ) == ["forward_migration_actor_spine_violation:459_vault_fk.sql"]

    assert inspect_migration_sql_governance(
        "459_concurrent_missing_header.sql",
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bad ON bad_t (user_id);\n",
        numeric_version=459,
        enforce_forward_rules=True,
    ) == [
        "concurrent_ddl_requires_single_nontransactional_migration:459_concurrent_missing_header.sql"
    ]

    assert inspect_migration_sql_governance(
        "459_late_directive.sql",
        "-- leading comment\n-- migration: transactional=false\nSELECT 1;\n",
        numeric_version=459,
        enforce_forward_rules=True,
    ) == ["invalid_migration_directive:459_late_directive.sql"]


def test_parked_split_brain_lane_allows_graduation_and_blocks_new_entries(tmp_path: Path) -> None:
    assert len(FROZEN_PARKED_MIGRATIONS) == 82
    assert verify_parked_lane_freeze(DEV_MANIFEST_PATH, PARKED_DIR) == []

    parked_copy = tmp_path / "parked"
    parked_copy.mkdir()
    graduated_subset = sorted(FROZEN_PARKED_MIGRATIONS)[:-1]
    for name in graduated_subset:
        (parked_copy / name).write_text("BEGIN;\nSELECT 1;\nCOMMIT;\n", encoding="utf-8")

    manifest_copy = tmp_path / "dev_migration_manifest.json"
    manifest_copy.write_text(
        json.dumps(
            {
                "ordered_migrations": graduated_subset,
                "deferred_release_migrations": [
                    {"filename": "249_one_chat_history_legacy_cutover.sql"}
                ],
            }
        ),
        encoding="utf-8",
    )
    assert verify_parked_lane_freeze(manifest_copy, parked_copy) == []

    (parked_copy / "990_new_split_brain.sql").write_text("SELECT 1;\n", encoding="utf-8")
    manifest_copy.write_text(
        json.dumps(
            {
                "ordered_migrations": [*graduated_subset, "990_new_split_brain.sql"],
                "deferred_release_migrations": [
                    {"filename": "249_one_chat_history_legacy_cutover.sql"},
                    {"filename": "458_location_feed_confirmed_incidents.sql"},
                ],
            }
        ),
        encoding="utf-8",
    )
    violations = verify_parked_lane_freeze(manifest_copy, parked_copy)
    assert "parked_lane_frozen_new_entries_forbidden:990_new_split_brain.sql" in violations
    assert (
        "dev_manifest_new_deferred_release_migration_forbidden:458_location_feed_confirmed_incidents.sql"
        in violations
    )
