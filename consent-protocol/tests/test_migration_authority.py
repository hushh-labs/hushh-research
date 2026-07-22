from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from db.migration_authority import (
    MigrationAuthorityError,
    MigrationMode,
    _stable_hash,
    apply_manifest_entries,
    build_manifest_entries,
    establish_baseline,
    load_preservation_evidence,
    manifest_checksum,
)


class FakeConnection:
    def __init__(self) -> None:
        self.lock_available = True
        self.locked = False
        self.rows: dict[str, dict] = {}
        self.executed_sql: list[str] = []
        self.fail_sql: str | None = None
        self.in_transaction = False
        self.transaction_entries = 0

    class _Transaction:
        def __init__(self, connection: "FakeConnection") -> None:
            self.connection = connection

        async def __aenter__(self):
            self.connection.in_transaction = True
            self.connection.transaction_entries += 1
            return self

        async def __aexit__(self, _exc_type, _exc, _traceback):
            self.connection.in_transaction = False
            return False

    def transaction(self):
        return self._Transaction(self)

    def is_in_transaction(self) -> bool:
        return self.in_transaction

    async def fetchval(self, sql: str, *_args):
        if "pg_try_advisory_lock" in sql:
            if not self.lock_available or self.locked:
                return False
            self.locked = True
            return True
        if "pg_advisory_unlock" in sql:
            self.locked = False
            return True
        raise AssertionError(sql)

    async def fetch(self, sql: str, *_args):
        if "FROM schema_migrations" in sql:
            return list(self.rows.values())
        raise AssertionError(sql)

    async def fetchrow(self, sql: str, *args):
        if "current_database()" in sql:
            return {"database_name": "test_db", "version": "160000"}
        if "FROM schema_migrations" in sql:
            return self.rows.get(str(args[0]))
        raise AssertionError(sql)

    async def execute(self, sql: str, *args):
        self.executed_sql.append(sql)
        if self.fail_sql and self.fail_sql in sql:
            self.in_transaction = True
            raise RuntimeError("synthetic migration failure")
        if sql == "ROLLBACK":
            self.in_transaction = False
        if "INSERT INTO schema_migrations" in sql and "ON CONFLICT" in sql:
            migration_id, filename, checksum, status, duration, deploy_sha, failure_class = args
            self.rows[migration_id] = {
                "migration_id": migration_id,
                "filename": filename,
                "checksum_sha256": checksum,
                "status": status,
                "duration_ms": duration,
                "deploy_sha": deploy_sha,
                "failure_class": failure_class,
                "baseline_through": None,
            }
        elif "INSERT INTO schema_migrations" in sql:
            (
                migration_id,
                filename,
                checksum,
                deploy_sha,
                through,
                manifest_id,
                db_hash,
                catalog,
                backup_checksum,
            ) = args
            self.rows[migration_id] = {
                "migration_id": migration_id,
                "filename": filename,
                "checksum_sha256": checksum,
                "status": "baseline",
                "deploy_sha": deploy_sha,
                "baseline_through": through,
                "preservation_manifest_id": manifest_id,
                "database_identity_hash": db_hash,
                "catalog_sha256": catalog,
                "backup_checksum_sha256": backup_checksum,
            }
        return "OK"


def _entries(tmp_path: Path):
    (tmp_path / "114_existing.sql").write_text("SELECT 114", encoding="utf-8")
    (tmp_path / "20260721_ABC_new.sql").write_text("SELECT 115", encoding="utf-8")
    return build_manifest_entries(
        tmp_path,
        ("114_existing.sql", "20260721_ABC_new.sql"),
    )


@pytest.mark.asyncio
async def test_observe_executes_no_migration_bodies(tmp_path: Path):
    entries = _entries(tmp_path)
    conn = FakeConnection()

    observed = await apply_manifest_entries(conn, entries, mode=MigrationMode.OBSERVE)
    assert observed == ()
    assert "SELECT 114" not in conn.executed_sql
    assert "SELECT 115" not in conn.executed_sql
    assert conn.rows == {}


@pytest.mark.asyncio
async def test_ledger_requires_verified_baseline(tmp_path: Path):
    conn = FakeConnection()
    with pytest.raises(MigrationAuthorityError, match="requires an established"):
        await apply_manifest_entries(conn, _entries(tmp_path), mode=MigrationMode.LEDGER)
    assert "SELECT 114" not in conn.executed_sql


@pytest.mark.asyncio
async def test_checksum_drift_fails_before_sql_execution(tmp_path: Path):
    entries = _entries(tmp_path)
    conn = FakeConnection()
    conn.rows["baseline:114"] = {
        "migration_id": "baseline:114",
        "filename": "release_migration_manifest.json@114",
        "checksum_sha256": manifest_checksum((entries[0],)),
        "status": "baseline",
        "baseline_through": 114,
    }
    changed = entries[0].__class__(
        migration_id=entries[0].migration_id,
        filename=entries[0].filename,
        checksum_sha256="0" * 64,
        sql="SELECT 'changed'",
    )

    with pytest.raises(MigrationAuthorityError, match="checksum changed"):
        await apply_manifest_entries(
            conn,
            (changed, entries[1]),
            mode=MigrationMode.LEDGER,
        )
    assert "SELECT 'changed'" not in conn.executed_sql


@pytest.mark.asyncio
async def test_advisory_lock_prevents_second_runner(tmp_path: Path):
    conn = FakeConnection()
    conn.lock_available = False
    with pytest.raises(MigrationAuthorityError, match="owns the database advisory lock"):
        await apply_manifest_entries(conn, _entries(tmp_path), mode=MigrationMode.REPLAY)


@pytest.mark.asyncio
async def test_failure_is_recorded_and_lock_is_released(tmp_path: Path):
    entries = _entries(tmp_path)
    conn = FakeConnection()
    conn.rows["baseline:114"] = {
        "migration_id": "baseline:114",
        "filename": "release_migration_manifest.json@114",
        "checksum_sha256": manifest_checksum((entries[0],)),
        "status": "baseline",
        "baseline_through": 114,
    }
    conn.fail_sql = "SELECT 115"
    with pytest.raises(RuntimeError, match="synthetic migration failure"):
        await apply_manifest_entries(conn, entries, mode=MigrationMode.LEDGER)
    assert conn.rows["20260721_ABC"]["status"] == "failed"
    assert conn.rows["20260721_ABC"]["failure_class"] == "RuntimeError"
    assert conn.locked is False


@pytest.mark.asyncio
async def test_baseline_skips_historical_entries_only(tmp_path: Path, monkeypatch):
    entries = _entries(tmp_path)
    conn = FakeConnection()
    monkeypatch.setenv("HUSSH_DEPLOY_ENV", "uat")
    evidence = {
        "status": "ok",
        "schema_status": "ok",
        "preservation_status": "ok",
        "preservation_manifest_id": "manifest-1",
        "database_identity_hash": "sha256:"
        + _stable_hash({"database_name": "test_db", "version": "160000"}),
        "catalog_sha256": "a" * 64,
        "restore_status": "ok",
        "evidence_kind": "baseline_authorization",
        "backup_checksum_sha256": "b" * 64,
    }
    marker = await establish_baseline(
        conn,
        (entries[0],),
        evidence=evidence,
        deploy_sha="abc123",
    )
    assert marker == "baseline:114"
    assert conn.rows[marker]["backup_checksum_sha256"] == "b" * 64
    assert await establish_baseline(conn, (entries[0],), evidence=evidence) == marker

    changed_evidence = {**evidence, "backup_checksum_sha256": "c" * 64}
    with pytest.raises(MigrationAuthorityError, match="preservation evidence changed"):
        await establish_baseline(conn, (entries[0],), evidence=changed_evidence)

    applied = await apply_manifest_entries(conn, entries, mode=MigrationMode.LEDGER)
    assert applied == ("20260721_ABC_new.sql",)
    assert conn.transaction_entries == 1
    assert "SELECT 114" not in conn.executed_sql
    assert "SELECT 115" in conn.executed_sql

    changed_historical = entries[0].__class__(
        migration_id=entries[0].migration_id,
        filename=entries[0].filename,
        checksum_sha256="0" * 64,
        sql="SELECT 'changed'",
    )
    with pytest.raises(MigrationAuthorityError, match="Baselined migration manifest"):
        await apply_manifest_entries(
            conn,
            (changed_historical, entries[1]),
            mode=MigrationMode.LEDGER,
        )


@pytest.mark.asyncio
async def test_baseline_rejects_unverified_backup_checksum(tmp_path: Path, monkeypatch):
    entries = _entries(tmp_path)
    conn = FakeConnection()
    monkeypatch.setenv("HUSSH_DEPLOY_ENV", "uat")
    with pytest.raises(MigrationAuthorityError, match="verified backup checksum"):
        await establish_baseline(
            conn,
            (entries[0],),
            evidence={
                "status": "ok",
                "schema_status": "ok",
                "preservation_status": "ok",
                "preservation_manifest_id": "manifest-1",
                "database_identity_hash": "sha256:"
                + _stable_hash({"database_name": "test_db", "version": "160000"}),
                "catalog_sha256": "a" * 64,
                "restore_status": "ok",
                "evidence_kind": "baseline_authorization",
                "backup_checksum_sha256": "not-a-checksum",
            },
        )


def test_preservation_evidence_requires_fresh_complete_status(tmp_path: Path):
    report = tmp_path / "preservation.json"
    report.write_text(
        json.dumps(
            {
                "status": "ok",
                "schema_status": "ok",
                "preservation_status": "ok",
                "database_identity_hash": "sha256:opaque",
                "preservation_manifest_id": "manifest-1",
                "catalog_sha256": "a" * 64,
                "restore_status": "ok",
                "evidence_kind": "baseline_authorization",
                "backup_checksum_sha256": "b" * 64,
                "created_at_epoch": int(time.time()),
            }
        ),
        encoding="utf-8",
    )
    assert load_preservation_evidence(report)["status"] == "ok"

    payload = json.loads(report.read_text(encoding="utf-8"))
    payload["preservation_status"] = "fail"
    report.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(MigrationAuthorityError, match="must both be ok"):
        load_preservation_evidence(report)
