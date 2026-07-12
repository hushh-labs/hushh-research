from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_scope_policy_v2_migration_and_checked_contract_move_together() -> None:
    sql = (ROOT / "db" / "migrations" / "087_scope_policy_v2.sql").read_text()
    contract = json.loads((ROOT / "db" / "contracts" / "uat_integrated_schema.json").read_text())
    manifest = json.loads((ROOT / "db" / "release_migration_manifest.json").read_text())

    assert "ADD COLUMN IF NOT EXISTS allowed_capabilities" in sql
    assert "cap.one.invoke" in sql
    assert "agent.one.orchestrate" in sql
    assert "scope_retired" in sql
    assert "allowed_capabilities" in contract["required_tables"]["developer_apps"]
    assert "087_scope_policy_v2.sql" in manifest["ordered_migrations"]
