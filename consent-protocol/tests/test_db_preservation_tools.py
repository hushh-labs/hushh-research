from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path

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
    paths = (
        REPO_ROOT / "scripts/ops/supabase_logical_backup.py",
        REPO_ROOT / "consent-protocol/scripts/ops/supabase_logical_backup.py",
        REPO_ROOT / "scripts/ops/restore_logical_backup_clone.py",
    )
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
