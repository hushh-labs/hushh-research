# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Real-PostgreSQL atomicity proof for MigrationMode.LEDGER (R33).

Verifies that historical ``BEGIN; ... COMMIT;`` wrapped migrations, unwrapped
transactional migrations, PL/pgSQL ``$$`` blocks, and ``transactional=false``
concurrent index builds execute cleanly under ``MigrationMode.LEDGER`` without
prematurely committing the outer ``asyncpg`` transaction or leaking warnings.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import asyncpg
import pytest

from db import migration_authority
from db.migration_authority import (
    MigrationMode,
    apply_manifest_entries,
    build_manifest_entries,
    establish_baseline,
)
from tests.pkm_conformance import postgres_harness
from tests.pkm_conformance.postgres_harness import TempPostgres, find_pg_bin


def _stable_hash(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


async def _seed_baseline(
    conn: asyncpg.Connection,
    base_entry: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HUSSH_DEPLOY_ENV", "uat")
    await conn.execute(base_entry.sql)
    version = str(await conn.fetchval("SHOW server_version_num"))
    db_name = str(await conn.fetchval("SELECT current_database()"))
    evidence = {
        "status": "ok",
        "schema_status": "ok",
        "preservation_status": "ok",
        "preservation_manifest_id": "wave1-atomicity-proof",
        "database_identity_hash": "sha256:"
        + _stable_hash({"database_name": db_name, "version": version}),
        "catalog_sha256": "a" * 64,
        "restore_status": "ok",
        "evidence_kind": "baseline_authorization",
        "backup_checksum_sha256": "b" * 64,
    }
    marker = await establish_baseline(conn, (base_entry,), evidence=evidence, deploy_sha="wave1")
    assert marker == f"baseline:{base_entry.numeric_version}"


@pytest.fixture
def isolated_ledger_pg(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(postgres_harness, "MIGRATIONS", [])
    server = TempPostgres()
    try:
        server.start()
        yield server
    finally:
        server.stop()


@pytest.mark.asyncio
@pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")
async def test_wrapped_migration_failure_rolls_back_ddl_atomically_in_ledger_mode(
    isolated_ledger_pg: TempPostgres,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / "100_base.sql").write_text(
        "BEGIN;\nCREATE TABLE IF NOT EXISTS wave1_base (id INT PRIMARY KEY);\nCOMMIT;\n",
        encoding="utf-8",
    )
    (tmp_path / "101_wrapped_fail.sql").write_text(
        "BEGIN;\nCREATE TABLE wave1_should_rollback (id INT PRIMARY KEY);\nSELECT 1 / 0;\nCOMMIT;\n",
        encoding="utf-8",
    )
    entries = build_manifest_entries(tmp_path, ("100_base.sql", "101_wrapped_fail.sql"))

    conn = await asyncpg.connect(
        host=isolated_ledger_pg.dir,
        port=isolated_ledger_pg.port,
        user="hushh",
        database="postgres",
    )
    try:
        await _seed_baseline(conn, entries[0], monkeypatch)
        with pytest.raises(asyncpg.DivisionByZeroError):
            await apply_manifest_entries(conn, entries, mode=MigrationMode.LEDGER)

        leaked = await conn.fetchval("SELECT to_regclass('public.wave1_should_rollback')")
        status = await conn.fetchval(
            "SELECT status FROM schema_migrations WHERE migration_id = '101'"
        )
        assert leaked is None
        assert status == "failed"
    finally:
        await conn.close()


@pytest.mark.asyncio
@pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")
async def test_wrapped_migration_rolls_back_ddl_when_ledger_receipt_write_fails(
    isolated_ledger_pg: TempPostgres,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """R33 core proof: inner COMMIT must never commit DDL ahead of _record_result."""

    (tmp_path / "100_base.sql").write_text(
        "CREATE TABLE IF NOT EXISTS wave1_r33_base (id INT PRIMARY KEY);\n",
        encoding="utf-8",
    )
    (tmp_path / "101_wrapped_r33.sql").write_text(
        "BEGIN;\n"
        "CREATE TABLE wave1_r33_atomic (id INT PRIMARY KEY);\n"
        "INSERT INTO wave1_r33_atomic (id) VALUES (42);\n"
        "COMMIT;\n",
        encoding="utf-8",
    )
    entries = build_manifest_entries(tmp_path, ("100_base.sql", "101_wrapped_r33.sql"))
    original_record = migration_authority._record_result
    fail_applied_once = True

    async def fault_injected_record(conn: Any, **kwargs: Any) -> None:
        nonlocal fail_applied_once
        if kwargs.get("status") == "applied" and fail_applied_once:
            fail_applied_once = False
            raise RuntimeError("simulated ledger receipt write failure")
        await original_record(conn, **kwargs)

    monkeypatch.setattr(migration_authority, "_record_result", fault_injected_record)

    conn = await asyncpg.connect(
        host=isolated_ledger_pg.dir,
        port=isolated_ledger_pg.port,
        user="hushh",
        database="postgres",
    )
    warnings: list[str] = []
    conn.add_log_listener(lambda _c, msg: warnings.append(str(msg.message)))
    try:
        await _seed_baseline(conn, entries[0], monkeypatch)
        with pytest.raises(RuntimeError, match="simulated ledger receipt write failure"):
            await apply_manifest_entries(conn, entries, mode=MigrationMode.LEDGER)

        assert await conn.fetchval("SELECT to_regclass('public.wave1_r33_atomic')") is None
        assert (
            await conn.fetchval("SELECT status FROM schema_migrations WHERE migration_id = '101'")
            == "failed"
        )

        applied = await apply_manifest_entries(conn, entries, mode=MigrationMode.LEDGER)
        assert applied == ("101_wrapped_r33.sql",)
        assert await conn.fetchval("SELECT id FROM wave1_r33_atomic") == 42
        assert (
            await conn.fetchval("SELECT status FROM schema_migrations WHERE migration_id = '101'")
            == "applied"
        )
        assert not any("transaction" in msg.lower() for msg in warnings), warnings
    finally:
        await conn.close()


@pytest.mark.asyncio
@pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")
async def test_ledger_applies_wrapped_plpgsql_unwrapped_and_concurrent_with_zero_warnings(
    isolated_ledger_pg: TempPostgres,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / "100_base.sql").write_text(
        "CREATE TABLE IF NOT EXISTS wave1_mix (id INT PRIMARY KEY);\n",
        encoding="utf-8",
    )
    wrapped_sql = (
        "-- leading comment\n"
        "BEGIN;\n"
        "ALTER TABLE wave1_mix ADD COLUMN label TEXT;\n"
        "DO $fn$\n"
        "BEGIN\n"
        "  INSERT INTO wave1_mix (id, label) VALUES (1, 'BEGIN; COMMIT;')\n"
        "  ON CONFLICT (id) DO NOTHING;\n"
        "END\n"
        "$fn$;\n"
        "COMMIT;\n"
        "-- trailing rollback guidance\n"
    )
    (tmp_path / "101_wrapped_plpgsql.sql").write_text(wrapped_sql, encoding="utf-8")
    (tmp_path / "102_unwrapped.sql").write_text(
        "ALTER TABLE wave1_mix ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;\n",
        encoding="utf-8",
    )
    (tmp_path / "103_concurrent_idx.sql").write_text(
        "-- migration: transactional=false\n"
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wave1_mix_active ON wave1_mix (active);\n",
        encoding="utf-8",
    )
    files = (
        "100_base.sql",
        "101_wrapped_plpgsql.sql",
        "102_unwrapped.sql",
        "103_concurrent_idx.sql",
    )
    entries = build_manifest_entries(tmp_path, files)
    expected_sha = hashlib.sha256(wrapped_sql.encode("utf-8")).hexdigest()
    assert entries[1].checksum_sha256 == expected_sha

    conn = await asyncpg.connect(
        host=isolated_ledger_pg.dir,
        port=isolated_ledger_pg.port,
        user="hushh",
        database="postgres",
    )
    warnings: list[str] = []
    conn.add_log_listener(lambda _c, msg: warnings.append(str(msg.message)))
    try:
        await _seed_baseline(conn, entries[0], monkeypatch)
        applied = await apply_manifest_entries(conn, entries, mode=MigrationMode.LEDGER)
        assert applied == ("101_wrapped_plpgsql.sql", "102_unwrapped.sql", "103_concurrent_idx.sql")
        second = await apply_manifest_entries(conn, entries, mode=MigrationMode.LEDGER)
        assert second == ()
        stored_sha = await conn.fetchval(
            "SELECT checksum_sha256 FROM schema_migrations WHERE migration_id = '101'"
        )
        assert stored_sha == expected_sha
        assert await conn.fetchval("SELECT label FROM wave1_mix WHERE id = 1") == "BEGIN; COMMIT;"
        assert not any("transaction" in msg.lower() for msg in warnings), warnings
    finally:
        await conn.close()
