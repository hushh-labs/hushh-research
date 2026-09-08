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


class AbortingConnection(FakeConnection):
    """A connection that behaves like Postgres after a statement error.

    Once a statement fails inside a transaction, every further command is
    refused until the transaction ends. `pg_advisory_unlock` is a command, so
    the cleanup in `apply_manifest_entries`' `finally` runs straight into it --
    which is how six UAT deploys reported `InFailedSQLTransactionError` when
    the real failure was a lock timeout. See R28 in the safe-changes ledger.
    """

    class InFailedSQLTransaction(RuntimeError):
        pass

    async def fetchval(self, sql: str, *args):
        if self.in_transaction and "pg_advisory_unlock" in sql:
            raise self.InFailedSQLTransaction(
                "current transaction is aborted, commands ignored until end of transaction block"
            )
        return await super().fetchval(sql, *args)


@pytest.mark.asyncio
async def test_replay_failure_reports_the_migration_not_the_cleanup(tmp_path: Path, capsys):
    entries = _entries(tmp_path)
    conn = AbortingConnection()
    conn.fail_sql = "SELECT 115"

    with pytest.raises(RuntimeError) as excinfo:
        await apply_manifest_entries(conn, entries, mode=MigrationMode.REPLAY)

    # The migration's own error, not the advisory unlock's.
    assert "synthetic migration failure" in str(excinfo.value)
    assert not isinstance(excinfo.value, AbortingConnection.InFailedSQLTransaction)

    # And it names which of the manifest's files stopped the run.
    assert any("20260721_ABC_new.sql" in note for note in getattr(excinfo.value, "__notes__", []))
    assert "MIGRATION FAILED: 20260721_ABC_new.sql" in capsys.readouterr().err

    # The rollback ran even in replay mode, so the lock was actually released.
    assert conn.locked is False


@pytest.mark.asyncio
async def test_failure_log_never_quotes_the_database_message(tmp_path: Path, capsys):
    """A Postgres error can carry row values; the log must not repeat them."""
    entries = _entries(tmp_path)
    conn = FakeConnection()
    conn.fail_sql = "SELECT 115"

    with pytest.raises(RuntimeError):
        await apply_manifest_entries(conn, entries, mode=MigrationMode.REPLAY)

    stderr = capsys.readouterr().err
    assert "MIGRATION FAILED: 20260721_ABC_new.sql" in stderr
    assert "synthetic migration failure" not in stderr
    assert "RuntimeError" in stderr


@pytest.mark.asyncio
async def test_successful_migration_does_not_hide_unlock_failure():
    class UnlockFailure(FakeConnection):
        async def fetchval(self, sql, *args):
            if "pg_advisory_unlock" in sql:
                raise RuntimeError("synthetic unlock failure")
            return await super().fetchval(sql, *args)

    with pytest.raises(RuntimeError, match="synthetic unlock failure"):
        await apply_manifest_entries(UnlockFailure(), (), mode=MigrationMode.REPLAY)


class _LockTimeout(Exception):
    """Stands in for asyncpg.exceptions.LockNotAvailableError.

    The retry decision reads ``sqlstate`` and nothing else, so a synthetic
    exception carrying 55P03 exercises the real branch.
    """

    sqlstate = "55P03"


class _CheckViolation(Exception):
    """A genuinely broken migration -- 23514, never retryable."""

    sqlstate = "23514"


class ContendingConnection(FakeConnection):
    """Fails the target statement with a lock timeout N times, then succeeds."""

    def __init__(self, target_sql: str, fail_times: int, exc: Exception | None = None) -> None:
        super().__init__()
        self.target_sql = target_sql
        self.fail_times = fail_times
        self.attempts = 0
        self.exc = exc or _LockTimeout("canceling statement due to lock timeout")

    async def execute(self, sql: str, *args):
        if self.target_sql in sql and "lock_timeout" not in sql:
            self.attempts += 1
            if self.attempts <= self.fail_times:
                self.in_transaction = True
                raise self.exc
        return await super().execute(sql, *args)


@pytest.fixture
def no_sleep(monkeypatch):
    """Record the backoff schedule without spending it."""
    slept: list[float] = []

    async def _fake_sleep(seconds: float) -> None:
        slept.append(seconds)

    monkeypatch.setattr("db.migration_authority.asyncio.sleep", _fake_sleep)
    monkeypatch.setattr("db.migration_authority.time.perf_counter", lambda: 0.0)
    return slept


@pytest.mark.asyncio
async def test_lock_contention_retries_and_then_succeeds(tmp_path: Path, no_sleep):
    """A busy database must not fail the deploy. This is the 2026-09-07 outage:
    runs 34142917051 and 34143403982 both died on 55P03 with no second attempt."""
    entries = _entries(tmp_path)
    conn = ContendingConnection("SELECT 115", fail_times=2)

    applied = await apply_manifest_entries(conn, entries, mode=MigrationMode.REPLAY)

    assert "20260721_ABC_new.sql" in applied
    assert conn.attempts == 3, "should have retried twice then succeeded"
    assert no_sleep == [1.0, 2.0], "backoff must be exponential and bounded"
    assert conn.locked is False


@pytest.mark.asyncio
async def test_a_broken_migration_is_not_retried(tmp_path: Path, no_sleep):
    """A constraint violation is not contention. Retrying it burns the deploy
    window and reports the same error later, so it must fail on attempt one."""
    entries = _entries(tmp_path)
    conn = ContendingConnection("SELECT 115", fail_times=99, exc=_CheckViolation("violated"))

    with pytest.raises(_CheckViolation):
        await apply_manifest_entries(conn, entries, mode=MigrationMode.REPLAY)

    assert conn.attempts == 1, "a real SQL error must not be retried"
    assert no_sleep == [], "no backoff should be spent on a broken migration"
    assert conn.locked is False


@pytest.mark.asyncio
async def test_retries_are_bounded_and_the_failure_says_so(tmp_path: Path, no_sleep, capsys):
    """Sustained contention must still end, and the log must say it gave up on
    locks rather than looking like a broken migration."""
    entries = _entries(tmp_path)
    conn = ContendingConnection("SELECT 115", fail_times=99)

    with pytest.raises(_LockTimeout):
        await apply_manifest_entries(conn, entries, mode=MigrationMode.REPLAY)

    assert conn.attempts == 4, "bounded at _LOCK_RETRY_ATTEMPTS"
    assert no_sleep == [1.0, 2.0, 4.0]
    err = capsys.readouterr().err
    assert "20260721_ABC_new.sql" in err, "must still name the failing migration (R28)"
    assert "gave up after 4 lock attempts" in err
    assert "sqlstate=55P03" in err
    assert conn.locked is False


@pytest.mark.asyncio
async def test_connection_is_rolled_back_between_lock_attempts(tmp_path: Path, no_sleep):
    """R28: a retry on an aborted connection would raise
    InFailedSQLTransactionError and mask the real error. Each attempt must start
    from a usable connection."""
    entries = _entries(tmp_path)
    conn = ContendingConnection("SELECT 115", fail_times=1)

    await apply_manifest_entries(conn, entries, mode=MigrationMode.REPLAY)

    assert conn.executed_sql.count("ROLLBACK") >= 1, "must roll back before retrying"
    assert conn.in_transaction is False


class ResetFailsConnection(ContendingConnection):
    """The lock times out, and the cleanup that follows fails too."""

    async def execute(self, sql: str, *args):
        if sql == "ROLLBACK":
            raise RuntimeError("connection is gone")
        return await super().execute(sql, *args)


@pytest.mark.asyncio
async def test_a_failed_reset_never_replaces_the_lock_error(tmp_path: Path, no_sleep):
    """R28 on the retry path. The cleanup runs on a just-failed connection, so
    it can fail too -- and if it did, its RuntimeError would be reported as the
    cause and the real 55P03 would vanish, exactly as six UAT deploys reported
    'current transaction is aborted' instead of the lock timeout."""
    entries = _entries(tmp_path)
    conn = ResetFailsConnection("SELECT 115", fail_times=99)

    with pytest.raises(_LockTimeout) as caught:
        await apply_manifest_entries(conn, entries, mode=MigrationMode.REPLAY)

    assert conn.attempts == 1, "a dead connection has nothing to retry with"
    assert any("connection reset failed" in n for n in getattr(caught.value, "__notes__", []))
    assert conn.locked is False


@pytest.mark.asyncio
async def test_run_wide_retry_budget_stops_a_long_contended_run(
    tmp_path: Path, no_sleep, monkeypatch
):
    """Per-migration bounds alone let a 174-entry lane spend ~78 minutes
    retrying while holding the advisory lock and the release fence -- worse
    availability than the bug. The run budget ends it."""
    monkeypatch.setattr("db.migration_authority._LOCK_RETRY_RUN_BUDGET_S", 1.0)
    entries = _entries(tmp_path)
    conn = ContendingConnection("SELECT 115", fail_times=99)

    with pytest.raises(_LockTimeout):
        await apply_manifest_entries(conn, entries, mode=MigrationMode.REPLAY)

    assert no_sleep == [1.0], "budget of 1.0s affords exactly the first 1s backoff"
    assert conn.attempts == 2, "then it reports instead of retrying"
    assert conn.locked is False


@pytest.mark.asyncio
async def test_failed_attempt_duration_consumes_run_retry_budget(tmp_path, no_sleep, monkeypatch):
    monkeypatch.setattr("db.migration_authority._LOCK_RETRY_RUN_BUDGET_S", 5.0)
    clock = [0.0]
    monkeypatch.setattr("db.migration_authority.time.perf_counter", lambda: clock[0])

    class SlowContention(ContendingConnection):
        async def execute(self, sql, *args):
            if "SELECT 115" in sql:
                clock[0] += 5.0
            return await super().execute(sql, *args)

    conn = SlowContention("SELECT 115", fail_times=99)
    with pytest.raises(_LockTimeout):
        await apply_manifest_entries(conn, _entries(tmp_path), mode=MigrationMode.REPLAY)
    assert conn.attempts == 1
    assert no_sleep == []
