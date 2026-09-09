from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path


def test_database_failure_report_excludes_connection_details(monkeypatch, tmp_path, capsys):
    root = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location("migration_report_privacy", root / "scripts/ops/db_migration_release_guard.py")
    guard = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, guard)
    spec.loader.exec_module(guard)
    report = tmp_path / "report.json"
    monkeypatch.setattr(sys, "argv", ["guard", "--report-path", str(report), "--print-json"])

    async def failed(_contract):
        raise RuntimeError("synthetic-secret-dsn-and-provider-body")

    monkeypatch.setattr(guard, "_run_db_contract_check", failed)
    assert guard._run(guard._parse_args()) == 1
    result = json.loads(report.read_text())
    assert "db_contract_check_failed:RuntimeError" in result["violations"]
    assert "synthetic-secret-dsn-and-provider-body" not in report.read_text() + capsys.readouterr().out
