from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
from uuid import uuid4

import asyncpg
import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load(name: str, relative_path: str):
    spec = importlib.util.spec_from_file_location(name, REPO_ROOT / relative_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


preservation = _load("db_preservation_manifest", "scripts/ops/db_preservation_manifest.py")
restore = _load("restore_logical_backup_clone", "scripts/ops/restore_logical_backup_clone.py")


def test_preservation_output_is_restricted_to_ignored_tmp():
    accepted = preservation._required_tmp_output(REPO_ROOT, str(REPO_ROOT / "tmp/report.json"))
    assert accepted == (REPO_ROOT / "tmp/report.json").resolve()
    with pytest.raises(ValueError, match="ignored tmp"):
        preservation._required_tmp_output(REPO_ROOT, str(REPO_ROOT / "report.json"))


def test_catalog_comparison_allows_additions_but_not_removals():
    before = {
        "tables": [{"table_name": "a"}],
        "columns": [{"table_name": "a", "column_name": "id"}],
    }
    after = {
        "tables": [{"table_name": "a"}, {"table_name": "b"}],
        "columns": [
            {"table_name": "a", "column_name": "id"},
            {"table_name": "a", "column_name": "optional"},
        ],
    }
    assert preservation._catalog_is_additive(before, after) is True
    assert preservation._catalog_is_additive(after, before) is False


def test_restore_target_must_be_an_isolated_database_name():
    with pytest.raises(ValueError, match="isolated"):
        restore._target_env("postgresql://user:password@localhost/production")
    env, database = restore._target_env(
        "postgresql://user:password@localhost/uat_restore_rehearsal"
    )
    assert database == "uat_restore_rehearsal"
    assert env["PGDATABASE"] == database


def test_backup_and_restore_preserve_grants_for_exact_clone_comparison():
    # Production backups are now Cloud SQL automated backups + PITR, so the
    # former logical-backup script is gone; the restore-clone tool remains the
    # exact-clone path and must still preserve grants.
    paths = (REPO_ROOT / "scripts/ops/restore_logical_backup_clone.py",)
    for path in paths:
        assert "--no-privileges" not in path.read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_preservation_comparison_requires_source_reference(tmp_path: Path, monkeypatch):
    output = REPO_ROOT / "tmp" / "missing-reference-report.json"
    args = argparse.Namespace(
        database_url="postgresql://unused",
        output=str(output),
        reference="",
        comparison_mode="preservation",
        restore_evidence="",
        backup_checksum_sha256="a" * 64,
        statement_timeout=1.0,
    )

    class FakeConnection:
        async def execute(self, _sql):
            return None

        async def fetchrow(self, _sql):
            return {"database_name": "clone", "version": "160000"}

        async def close(self):
            return None

    async def connect(*_args, **_kwargs):
        return FakeConnection()

    monkeypatch.setattr(preservation.asyncpg, "connect", connect)
    with pytest.raises(RuntimeError, match="requires a source reference"):
        await preservation.run(args)


@pytest.mark.asyncio
async def test_capture_imports_backup_snapshot_and_remains_consistent_and_read_only():
    dsn = os.getenv("SCOPE_COMMERCE_TEST_DSN") or os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not dsn:
        pytest.skip("isolated PostgreSQL fixture is not configured")
    writer = await asyncpg.connect(dsn)
    exporter = await asyncpg.connect(dsn)
    schema = "preservation_snapshot_" + uuid4().hex
    transaction = exporter.transaction(isolation="repeatable_read", readonly=True)
    try:
        await writer.execute(f'CREATE SCHEMA "{schema}"')
        await writer.execute(f'CREATE TABLE "{schema}".records (id INTEGER PRIMARY KEY)')
        await writer.execute(f'INSERT INTO "{schema}".records VALUES (1)')
        await transaction.start()
        snapshot = await exporter.fetchval("SELECT pg_export_snapshot()")
        await writer.execute(f'INSERT INTO "{schema}".records VALUES (2)')
        async with preservation._snapshot_connection(dsn, 5, snapshot) as captured:
            assert await captured.fetchval(f'SELECT count(*) FROM "{schema}".records') == 1
        async with preservation._snapshot_connection(dsn, 5) as current:
            assert await current.fetchval(f'SELECT count(*) FROM "{schema}".records') == 2
            await writer.execute(f'INSERT INTO "{schema}".records VALUES (3)')
            assert await current.fetchval(f'SELECT count(*) FROM "{schema}".records') == 2
        with pytest.raises(asyncpg.ReadOnlySQLTransactionError):
            async with preservation._snapshot_connection(dsn, 5) as captured:
                await captured.execute(f'DELETE FROM "{schema}".records')
    finally:
        await exporter.close()
        await writer.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
        await writer.close()


@pytest.mark.parametrize("snapshot", ["x", "00000003-0000001B-1'; SELECT 1--"])
@pytest.mark.asyncio
async def test_capture_rejects_malformed_snapshot_before_connect(snapshot, monkeypatch):
    async def forbidden_connect(*_args, **_kwargs):
        pytest.fail("malformed snapshots must never reach a database")

    monkeypatch.setattr(preservation.asyncpg, "connect", forbidden_connect)
    with pytest.raises(ValueError, match="snapshot identifier"):
        async with preservation._snapshot_connection("unused", 1, snapshot):
            pytest.fail("malformed snapshot was admitted")


@pytest.mark.asyncio
async def test_row_digest_preserves_information_across_text_collations_and_numeric_keys():
    dsn = os.getenv("SCOPE_COMMERCE_TEST_DSN") or os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not dsn:
        pytest.skip("isolated PostgreSQL fixture is not configured")
    conn = await asyncpg.connect(dsn)
    names = ["preservation_order_" + uuid4().hex for _ in range(2)]
    try:
        for table, collation in zip(names, ["C", "und-x-icu"], strict=True):
            await conn.execute(
                f'CREATE TABLE public."{table}" (id INTEGER, label TEXT COLLATE "{collation}", note TEXT, PRIMARY KEY (id, label))'
            )
            await conn.executemany(
                f'INSERT INTO public."{table}" VALUES ($1, $2, $3)',
                [(2, "Z", "first"), (2, "a", "second"), (10, "_", "last")],
            )
        manifests = [
            await preservation._table_manifest(conn, table, ["id", "label", "note"])
            for table in names
        ]
        assert {k: v for k, v in manifests[0].items() if k != "table"} == {
            k: v for k, v in manifests[1].items() if k != "table"
        }
        expected_rows = [(2, "Z", "first"), (2, "a", "second"), (10, "_", "last")]
        hashes = [
            hashlib.md5(
                json.dumps(
                    dict(zip(["id", "label", "note"], row, strict=True)), separators=(",", ":")
                ).encode(),
                usedforsecurity=False,
            ).hexdigest()
            for row in expected_rows
        ]
        assert (
            manifests[0]["deterministic_row_digest_sha256"]
            == hashlib.sha256("".join(value + "\n" for value in hashes).encode()).hexdigest()
        )
        expected_bounds = await conn.fetchval(
            "SELECT md5(ROW(2, 'Z'::text)::text || '|' || ROW(10, '_'::text)::text)"
        )
        assert manifests[0]["primary_key_range_digest"] == expected_bounds
        await conn.execute(f'UPDATE public."{names[1]}" SET note=$1 WHERE label=$2', "changed", "a")
        changed = await preservation._table_manifest(conn, names[1], ["id", "label", "note"])
        assert (
            changed["deterministic_row_digest_sha256"]
            != manifests[0]["deterministic_row_digest_sha256"]
        )
    finally:
        for table in names:
            await conn.execute(f'DROP TABLE IF EXISTS public."{table}"')
        await conn.close()
