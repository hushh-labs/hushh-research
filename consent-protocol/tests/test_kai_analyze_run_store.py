"""Tests for the durable coarse-checkpoint Kai/RIA analyze ("debate") run store.

Two concerns are covered:

1. **Governance lockstep** — migration 125 is registered in the release manifest
   and the schema contracts, and the migration is purely additive / REPLAY-safe.
2. **Cross-instance resume** — the whole point of the store: a checkpoint written
   by one process must be readable by a *different* engine pointed at the same
   database, proving a Cloud Run reconnect on a foreign instance can replay the
   terminal frame. We exercise this against the offline SQLite engine (which is
   the same ``db.db_client`` code path prod uses, minus Postgres), using a fresh
   engine for the read to simulate the second instance.
"""

from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
MIGRATION_NAME = "125_kai_analyze_run_store.sql"
MIGRATION = ROOT / "db" / "migrations" / MIGRATION_NAME
CONTRACTS = ROOT / "db" / "contracts"

# The table is a production-fanout mitigation. It lives in the integrated/core
# contracts; dev_minimum is an intentional subset and does not require it.
_TABLE_COLUMNS = {
    "run_id",
    "user_id",
    "debate_session_id",
    "ticker",
    "risk_profile",
    "status",
    "terminal_event",
    "terminal_payload",
    "started_at",
    "completed_at",
    "created_at",
    "updated_at",
}


def _json(path: Path) -> dict:
    return json.loads(path.read_text())


def _release_versions(manifest: dict) -> list[int]:
    return [
        int(name.split("_", 1)[0]) for name in manifest["ordered_migrations"] if name[:3].isdigit()
    ]


# ---------------------------------------------------------------------------
# Governance lockstep
# ---------------------------------------------------------------------------


def test_run_store_is_registered_in_release_manifest_and_contracts() -> None:
    manifest = _json(ROOT / "db" / "release_migration_manifest.json")
    release_versions = _release_versions(manifest)

    assert MIGRATION.exists()
    assert MIGRATION_NAME in manifest["ordered_migrations"]
    # Appending the migration must not duplicate an entry, and it must be the new
    # release ceiling so every contract's expected version lands on it.
    assert len(manifest["ordered_migrations"]) == len(set(manifest["ordered_migrations"]))
    assert max(release_versions) == 125

    for contract_name in (
        "dev_minimum_schema.json",
        "uat_integrated_schema.json",
        "prod_core_schema.json",
    ):
        contract = _json(CONTRACTS / contract_name)
        assert contract["expected_migration_version"] == max(release_versions), contract_name

    # The table is required only by the integrated + core contracts (dev_minimum
    # is a deliberate subset — see the 10-table gap between it and prod_core).
    for contract_name in ("uat_integrated_schema.json", "prod_core_schema.json"):
        required_tables = _json(CONTRACTS / contract_name)["required_tables"]
        assert "kai_analyze_runs" in required_tables, contract_name
        assert set(required_tables["kai_analyze_runs"]) == _TABLE_COLUMNS, contract_name


def test_run_store_migration_is_additive_and_replay_safe() -> None:
    sql = MIGRATION.read_text()

    assert "CREATE TABLE IF NOT EXISTS kai_analyze_runs" in sql
    for column in _TABLE_COLUMNS:
        assert column in sql, column
    # Coarse mirror only — the terminal frame is a JSON blob, no per-token columns.
    assert "terminal_payload" in sql
    # Indexes must be replay-safe too.
    assert "CREATE INDEX IF NOT EXISTS idx_kai_analyze_runs_user_session" in sql
    assert "CREATE INDEX IF NOT EXISTS idx_kai_analyze_runs_updated_at" in sql
    # Never destructive: the release pipeline re-runs this on every deploy.
    assert "DROP TABLE" not in sql
    assert "DROP COLUMN" not in sql
    # The consent token must never be persisted to this mirror.
    assert "consent_token" not in sql.lower()


# ---------------------------------------------------------------------------
# Cross-instance resume (offline SQLite, same db_client code path)
# ---------------------------------------------------------------------------

# SQLite-compatible mirror of the migration-125 shape. The offline schema file
# does not know about kai_analyze_runs, so the "first instance" creates it.
_SQLITE_DDL = """
CREATE TABLE IF NOT EXISTS kai_analyze_runs (
    run_id             TEXT PRIMARY KEY,
    user_id            TEXT NOT NULL,
    debate_session_id  TEXT,
    ticker             TEXT,
    risk_profile       TEXT,
    status             TEXT NOT NULL DEFAULT 'running',
    terminal_event     TEXT,
    terminal_payload   TEXT,
    started_at         TEXT,
    completed_at       TEXT,
    created_at         TEXT,
    updated_at         TEXT
)
"""


@pytest.fixture()
def offline_db(tmp_path, monkeypatch):
    """Boot the offline SQLite engine on a real file shared across engines."""
    db_file = tmp_path / "kai-run-store.db"
    monkeypatch.setenv("DB_OFFLINE", "1")
    monkeypatch.setenv("OFFLINE_DB_PATH", str(db_file))

    import db.connection as connection
    import db.db_client as db_client
    import db.offline_db as offline_db_mod

    importlib.reload(offline_db_mod)
    db_client._engine = None
    db_client._db_client = None
    connection._pool = None

    # "First instance": create the table the migration would have created.
    from db.db_client import get_db

    get_db().execute_raw(_SQLITE_DDL)

    yield

    if db_client._engine is not None:
        db_client._engine.dispose()
    db_client._engine = None
    db_client._db_client = None
    connection._pool = None


def _simulate_fresh_instance() -> None:
    """Dispose the current engine and force a new one on the same file.

    This is the crux of the cross-instance test: the read must go through a
    genuinely separate SQLAlchemy engine (a stand-in for a different Cloud Run
    instance), not the connection that wrote the row.
    """
    import db.connection as connection
    import db.db_client as db_client

    if db_client._engine is not None:
        db_client._engine.dispose()
    db_client._engine = None
    db_client._db_client = None
    connection._pool = None


def test_terminal_checkpoint_round_trips_to_a_fresh_instance(offline_db) -> None:
    from hushh_mcp.services.kai_analyze_run_store import (
        load_terminal_checkpoint,
        save_start_checkpoint,
        save_terminal_checkpoint,
    )

    # Instance A: run starts, then completes with a terminal DecisionCard frame.
    assert save_start_checkpoint(
        run_id="run-1",
        user_id="user-1",
        debate_session_id="sess-1",
        ticker="AAPL",
        risk_profile="balanced",
    )
    payload = {"decision": "BUY", "confidence": 0.82, "run_id": "run-1"}
    assert save_terminal_checkpoint(
        run_id="run-1",
        user_id="user-1",
        status="completed",
        terminal_event="decision_card",
        terminal_payload=payload,
    )

    # Instance B: a different engine on the same DB reads the terminal frame.
    _simulate_fresh_instance()
    loaded = load_terminal_checkpoint(run_id="run-1", user_id="user-1")

    assert loaded is not None
    assert loaded["status"] == "completed"
    assert loaded["terminal_event"] == "decision_card"
    assert loaded["terminal_payload"]["decision"] == "BUY"
    assert loaded["terminal_payload"]["confidence"] == 0.82
    # Identity columns from the start checkpoint survive the terminal upsert.
    assert loaded["ticker"] == "AAPL"
    assert loaded["debate_session_id"] == "sess-1"


def test_terminal_checkpoint_self_heals_without_a_prior_start(offline_db) -> None:
    # Flag flipped mid-run: only the terminal write happens. The upsert must
    # still produce a complete, loadable row.
    from hushh_mcp.services.kai_analyze_run_store import (
        load_terminal_checkpoint,
        save_terminal_checkpoint,
    )

    assert save_terminal_checkpoint(
        run_id="run-2",
        user_id="user-1",
        status="completed",
        terminal_event="decision_card",
        terminal_payload={"decision": "HOLD"},
        ticker="MSFT",
        debate_session_id="sess-2",
    )

    _simulate_fresh_instance()
    loaded = load_terminal_checkpoint(run_id="run-2", user_id="user-1")
    assert loaded is not None
    assert loaded["terminal_payload"]["decision"] == "HOLD"
    assert loaded["ticker"] == "MSFT"


def test_load_is_none_for_unknown_run(offline_db) -> None:
    from hushh_mcp.services.kai_analyze_run_store import load_terminal_checkpoint

    assert load_terminal_checkpoint(run_id="does-not-exist", user_id="user-1") is None


def test_load_is_none_for_a_run_still_running(offline_db) -> None:
    # A start checkpoint with no terminal frame must not be replayable.
    from hushh_mcp.services.kai_analyze_run_store import (
        load_terminal_checkpoint,
        save_start_checkpoint,
    )

    assert save_start_checkpoint(run_id="run-3", user_id="user-1")
    _simulate_fresh_instance()
    assert load_terminal_checkpoint(run_id="run-3", user_id="user-1") is None


def test_load_enforces_ownership(offline_db) -> None:
    # A different user must never be able to read another user's terminal frame.
    from hushh_mcp.services.kai_analyze_run_store import (
        load_terminal_checkpoint,
        save_terminal_checkpoint,
    )

    assert save_terminal_checkpoint(
        run_id="run-4",
        user_id="owner",
        status="completed",
        terminal_event="decision_card",
        terminal_payload={"decision": "SELL"},
    )

    _simulate_fresh_instance()
    assert load_terminal_checkpoint(run_id="run-4", user_id="intruder") is None
    assert load_terminal_checkpoint(run_id="run-4", user_id="owner") is not None
