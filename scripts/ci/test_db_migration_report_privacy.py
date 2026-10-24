from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest


@pytest.fixture
def guard(monkeypatch):
    root = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location(
        "migration_report_privacy", root / "scripts/ops/db_migration_release_guard.py"
    )
    guard = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, guard)
    spec.loader.exec_module(guard)
    return guard


def test_database_failure_report_excludes_connection_details(
    guard, monkeypatch, tmp_path, capsys
):
    report = tmp_path / "report.json"
    monkeypatch.setattr(
        sys, "argv", ["guard", "--report-path", str(report), "--print-json"]
    )

    async def failed(_contract):
        raise RuntimeError("synthetic-secret-dsn-and-provider-body")

    monkeypatch.setattr(guard, "_run_db_contract_check", failed)
    assert guard._run(guard._parse_args()) == 1
    result = json.loads(report.read_text())
    assert "db_contract_check_failed:RuntimeError" in result["violations"]
    assert (
        "synthetic-secret-dsn-and-provider-body"
        not in report.read_text() + capsys.readouterr().out
    )


@pytest.mark.asyncio
async def test_catalog_batch_preserves_missing_and_acl_visible_contract(
    guard, monkeypatch
):
    class Connection:
        calls = 0
        closed = False

        async def fetch(self, query, names):
            self.calls += 1
            if "to_regclass" in query:
                return [
                    {
                        "table_name": name,
                        "relation": f"public.{name}" if name != "absent" else None,
                    }
                    for name in names
                ]
            if "information_schema.columns" in query:
                assert "table_schema = 'public'" in query
                return [
                    {"table_name": "healthy", "column_name": "id"},
                    {"table_name": "healthy", "column_name": "extra"},
                    {"table_name": "partial", "column_name": "id"},
                ]
            assert "pg_proc" in query and "n.nspname = 'public'" in query
            # A same-named function in another namespace cannot satisfy public.
            return [{"proname": "public_probe"}]

        async def close(self):
            self.closed = True

    connection = Connection()

    async def connect(*_args, **_kwargs):
        return connection

    monkeypatch.setattr(guard, "_build_database_url_from_env", lambda: "synthetic")
    monkeypatch.setattr(guard.asyncpg, "connect", connect)
    contract = {
        "required_tables": {
            "healthy": ["id"],
            "invisible": ["id"],
            "absent": ["id"],
            "partial": ["z", "a"],
        },
        "required_functions": ["public_probe", "other_namespace_only"],
    }
    result, violations = await guard._run_db_contract_check(contract)
    assert result == {
        "tables": {
            "healthy": {"exists": True, "missing_columns": [], "column_count": 2},
            "invisible": {"exists": True, "missing_columns": ["id"], "column_count": 0},
            "absent": {"exists": False, "missing_columns": ["id"]},
            "partial": {
                "exists": True,
                "missing_columns": ["a", "z"],
                "column_count": 1,
            },
        },
        "functions": {"public_probe": True, "other_namespace_only": False},
    }
    assert violations == [
        "missing_columns:invisible:id",
        "missing_table:absent",
        "missing_columns:partial:a,z",
        "missing_function:other_namespace_only",
    ]
    assert connection.calls == 3
    assert connection.closed


@pytest.mark.asyncio
async def test_catalog_batch_closes_connection_after_failed_read(guard, monkeypatch):
    class Connection:
        closed = False

        async def fetch(self, *_args):
            raise RuntimeError("synthetic catalog failure")

        async def close(self):
            self.closed = True

    connection = Connection()

    async def connect(*_args, **_kwargs):
        return connection

    monkeypatch.setattr(guard, "_build_database_url_from_env", lambda: "synthetic")
    monkeypatch.setattr(guard.asyncpg, "connect", connect)
    with pytest.raises(RuntimeError, match="synthetic catalog failure"):
        await guard._run_db_contract_check({"required_tables": {"example": ["id"]}})
    assert connection.closed
