from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from contextlib import closing
from dataclasses import replace
from pathlib import Path

import psycopg2
import pytest
from psycopg2 import sql as pg_sql

from db.migration_authority import (
    _REFERRAL_POLICY_V3_OBSERVED_UAT_SHA256,
    MigrationAuthorityError,
    MigrationMode,
    _replay_sql,
    _stable_hash,
    apply_manifest_entries,
    build_manifest_entries,
    establish_baseline,
    load_preservation_evidence,
    manifest_checksum,
)


@pytest.fixture
def referral_replay_postgres():
    """An isolated schema in CI, or a disposable socket-only local cluster."""
    ci_url = os.getenv("ONE_COMMAND_TEST_DATABASE_URL", "")
    if ci_url:
        dsn = ci_url.replace("postgresql+psycopg2://", "postgresql://", 1)
        schema = f"referral_replay_{uuid.uuid4().hex}"
        admin = psycopg2.connect(dsn)
        admin.autocommit = True
        try:
            with admin.cursor() as cursor:
                cursor.execute(pg_sql.SQL("CREATE SCHEMA {}").format(pg_sql.Identifier(schema)))
            # psycopg2 masks the password in conn.dsn; reuse the original for other sessions.
            fixture_dsn = psycopg2.extensions.make_dsn(dsn, options=f"-c search_path={schema}")
            conn = psycopg2.connect(fixture_dsn)
            try:
                yield conn, fixture_dsn
            finally:
                conn.close()
                with admin.cursor() as cursor:
                    cursor.execute(
                        pg_sql.SQL("DROP SCHEMA {} CASCADE").format(pg_sql.Identifier(schema))
                    )
        finally:
            admin.close()
        return

    if hasattr(os, "geteuid") and os.geteuid() == 0:
        pytest.skip("Disposable PostgreSQL requires a non-root test user")
    configured = os.getenv("HUSSH_POSTGRES_TEST_BINDIR", "")
    pg_config = shutil.which("pg_config")
    if configured:
        bindir = Path(configured)
    elif pg_config:
        bindir = Path(
            subprocess.check_output(  # noqa: S603 - discovered local server toolchain
                [pg_config, "--bindir"], text=True, timeout=5
            ).strip()
        )
    else:
        pytest.skip("PostgreSQL server binaries are not available")
    if not all((bindir / command).is_file() for command in ("initdb", "pg_ctl", "postgres")):
        pytest.skip("PostgreSQL server binaries are incomplete")

    directory = Path(tempfile.mkdtemp(prefix="hussh-referral-replay-"))
    data = directory / "data"
    port = 20000 + secrets.randbelow(40000)
    started = False

    def run(command: str, *arguments: object) -> None:
        subprocess.run(  # noqa: S603 - isolated server toolchain, authored arguments
            [str(bindir / command), *map(str, arguments)],
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        )

    try:
        run(
            "initdb",
            "-D",
            data,
            "-A",
            "trust",
            "-U",
            "referral_fixture_owner",
            "--no-locale",
            "--encoding=UTF8",
        )
        run(
            "pg_ctl",
            "-D",
            data,
            "-l",
            directory / "server.log",
            "-o",
            f"-k {directory} -h '' -p {port}",
            "-w",
            "-t",
            "20",
            "start",
        )
        started = True
        conn = psycopg2.connect(
            host=str(directory), port=port, dbname="postgres", user="referral_fixture_owner"
        )
        try:
            yield conn, conn.dsn
        finally:
            conn.close()
    finally:
        if started:
            run("pg_ctl", "-D", data, "-m", "immediate", "-w", "-t", "20", "stop")
        shutil.rmtree(directory)


def test_referral_v2_replay_accepts_only_an_intact_later_lineage(referral_replay_postgres):
    """The published SQL fails on v3; the pinned replay leaves that policy untouched."""
    fixture_conn, fixture_dsn = referral_replay_postgres
    entry = build_manifest_entries(
        Path(__file__).resolve().parents[1] / "db/migrations",
        ("289_one_referral_program_settings_v2.sql",),
    )[0]
    adapted_sql = _replay_sql(entry)
    assert entry.sql != adapted_sql
    with closing(fixture_conn) as conn:
        conn.autocommit = True
        with conn.cursor() as cursor:
            cursor.execute("""
                CREATE TABLE one_referral_program_settings (
                  version INTEGER PRIMARY KEY,
                  qualification_policy_version INTEGER NOT NULL,
                  points JSONB NOT NULL, milestones JSONB NOT NULL,
                  streak_rules JSONB NOT NULL, flash_windows JSONB NOT NULL,
                  weekly_schedule JSONB NOT NULL, prize_catalogue JSONB NOT NULL,
                  tie_break_rules JSONB NOT NULL, fulfillment_config JSONB NOT NULL,
                  feature_active BOOLEAN NOT NULL,
                  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                  activated_at TIMESTAMPTZ, retired_at TIMESTAMPTZ
                );
                CREATE UNIQUE INDEX one_referral_program_settings_single_active
                  ON one_referral_program_settings ((TRUE))
                  WHERE activated_at IS NOT NULL AND retired_at IS NULL;
                CREATE TABLE synthetic_reward_reference (
                  settings_version INTEGER REFERENCES one_referral_program_settings(version)
                );
                INSERT INTO one_referral_program_settings (
                  version, qualification_policy_version, points, milestones,
                  streak_rules, flash_windows, weekly_schedule, prize_catalogue,
                  tie_break_rules, fulfillment_config, feature_active, activated_at
                ) VALUES (1, 1, '{}', '[]', '{}', '[]', '{}', '[]', '{}', '{}', FALSE, NOW());
            """)
            cursor.execute(adapted_sql)
            cursor.execute(adapted_sql)
            cursor.execute("INSERT INTO synthetic_reward_reference VALUES (2)")
            catalogue_sql = (
                Path(__file__).resolve().parents[1]
                / "db/migrations/338_one_referral_usd_catalogue.sql"
            ).read_text(encoding="utf-8")
            cursor.execute(catalogue_sql)
            cursor.execute(catalogue_sql)
            cursor.execute("""
                SELECT encode(sha256(convert_to(jsonb_build_object(
                  'qualification_policy_version', qualification_policy_version,
                  'points', points, 'milestones', milestones, 'streak_rules', streak_rules,
                  'flash_windows', flash_windows, 'weekly_schedule', weekly_schedule,
                  'prize_catalogue', prize_catalogue, 'tie_break_rules', tie_break_rules,
                  'fulfillment_config', fulfillment_config, 'feature_active', feature_active
                )::text, 'UTF8')), 'hex')
                  FROM one_referral_program_settings WHERE version = 3
            """)
            fixture_policy_hash = cursor.fetchone()[0]
            assert adapted_sql.count(_REFERRAL_POLICY_V3_OBSERVED_UAT_SHA256) == 1
            # Exercise the published catalogue against the production fingerprint;
            # a synthetic successor/hash substitution would hide rollout drift.
            assert fixture_policy_hash == _REFERRAL_POLICY_V3_OBSERVED_UAT_SHA256
            cursor.execute("SELECT * FROM one_referral_program_settings ORDER BY version")
            before = cursor.fetchall()
            with pytest.raises(psycopg2.Error, match="version 2 exists but is not the active"):
                cursor.execute(entry.sql)
            cursor.execute("ROLLBACK")
            cursor.execute(adapted_sql)
            cursor.execute(adapted_sql)
            cursor.execute("SELECT * FROM one_referral_program_settings ORDER BY version")
            assert cursor.fetchall() == before
            cursor.execute("SELECT settings_version FROM synthetic_reward_reference")
            assert cursor.fetchall() == [(2,)]

            # UAT 2026-10-15: migration 347 activated version 4 and retired 3,
            # and every later replay of 289 failed on a hard "exactly one v3"
            # pin. The published 347 settings block must leave 289 idempotent.
            lifecycle_sql = (
                Path(__file__).resolve().parents[1]
                / "db/migrations/347_one_referral_dashboard_lifecycle.sql"
            ).read_text(encoding="utf-8")
            start = lifecycle_sql.index(
                "DO $$\nDECLARE prior one_referral_program_settings%ROWTYPE;"
            )
            settings_v4_sql = lifecycle_sql[
                start : lifecycle_sql.index("END $$;", start) + len("END $$;")
            ]
            cursor.execute(settings_v4_sql)
            cursor.execute(settings_v4_sql)
            cursor.execute("SELECT * FROM one_referral_program_settings ORDER BY version")
            with_v4 = cursor.fetchall()
            assert [row[0] for row in with_v4] == [1, 2, 3, 4]
            cursor.execute(adapted_sql)
            cursor.execute(adapted_sql)
            cursor.execute("SELECT * FROM one_referral_program_settings ORDER BY version")
            assert cursor.fetchall() == with_v4
            # Migration 338 pinned the same "v3 stays active" assumption and
            # failed the replay right after 289 was fixed (UAT run 38739715393).
            catalogue_entry = build_manifest_entries(
                Path(__file__).resolve().parents[1] / "db/migrations",
                ("338_one_referral_usd_catalogue.sql",),
            )[0]
            adapted_catalogue_sql = _replay_sql(catalogue_entry)
            assert catalogue_entry.sql != adapted_catalogue_sql
            with pytest.raises(psycopg2.Error, match="does not match the active USD catalogue"):
                cursor.execute(catalogue_entry.sql)
            cursor.execute("ROLLBACK")
            cursor.execute(adapted_catalogue_sql)
            cursor.execute(adapted_catalogue_sql)
            cursor.execute("SELECT * FROM one_referral_program_settings ORDER BY version")
            assert cursor.fetchall() == with_v4
            cursor.execute(
                "UPDATE one_referral_program_settings SET retired_at = NOW() WHERE version = 4"
            )
            with pytest.raises(psycopg2.Error, match="active USD catalogue"):
                cursor.execute(adapted_catalogue_sql)
            cursor.execute("ROLLBACK")
            cursor.execute(
                "UPDATE one_referral_program_settings SET retired_at = NULL WHERE version = 4"
            )
            for mutation, restoration, message in [
                (
                    "UPDATE one_referral_program_settings SET milestones = '[]'::jsonb WHERE version = 3",
                    "UPDATE one_referral_program_settings SET milestones = %s::jsonb WHERE version = 3",
                    "active USD catalogue",
                ),
                (
                    "UPDATE one_referral_program_settings SET retired_at = retired_at + INTERVAL '1 second' WHERE version = 3",
                    "UPDATE one_referral_program_settings SET retired_at = (SELECT activated_at FROM one_referral_program_settings WHERE version = 4) WHERE version = 3",
                    "active USD catalogue",
                ),
            ]:
                cursor.execute(mutation)
                with pytest.raises(psycopg2.Error, match=message):
                    cursor.execute(adapted_catalogue_sql)
                cursor.execute("ROLLBACK")
                cursor.execute(
                    restoration, (json.dumps(with_v4[2][3]),) if "%s" in restoration else None
                )
            # A lineage that ends without an active policy is still refused.
            cursor.execute(
                "UPDATE one_referral_program_settings SET retired_at = NOW() WHERE version = 4"
            )
            with pytest.raises(psycopg2.Error, match="ending in one active policy"):
                cursor.execute(adapted_sql)
            cursor.execute("ROLLBACK")
            cursor.execute(
                "UPDATE one_referral_program_settings SET retired_at = NULL WHERE version = 4"
            )
            # Version 4 is admitted only with the contents migration 347 authored.
            cursor.execute(
                "UPDATE one_referral_program_settings SET milestones = '[]'::jsonb WHERE version = 4"
            )
            with pytest.raises(psycopg2.Error, match="version 4 contents differ"):
                cursor.execute(adapted_sql)
            cursor.execute("ROLLBACK")
            cursor.execute(
                "UPDATE one_referral_program_settings SET milestones = %s::jsonb WHERE version = 4",
                (json.dumps(with_v4[3][3]),),
            )
            cursor.execute("DELETE FROM one_referral_program_settings WHERE version = 4")
            cursor.execute(
                "UPDATE one_referral_program_settings SET retired_at = NULL WHERE version = 3"
            )
            cursor.execute("SELECT * FROM one_referral_program_settings ORDER BY version")
            assert cursor.fetchall() == before

            cursor.execute(
                "UPDATE one_referral_program_settings SET points = '{}' WHERE version = 2"
            )
            with pytest.raises(psycopg2.Error, match="configuration does not match"):
                cursor.execute(adapted_sql)
            cursor.execute("ROLLBACK")
            cursor.execute(
                "UPDATE one_referral_program_settings SET points = %s::jsonb WHERE version = 2",
                (json.dumps(before[1][2]),),
            )
            cursor.execute("""
                UPDATE one_referral_program_settings
                   SET milestones = '[{"milestone_key":"unreviewed"}]'::jsonb
                 WHERE version = 3
            """)
            with pytest.raises(psycopg2.Error, match="contents differ from the reviewed"):
                cursor.execute(adapted_sql)
            cursor.execute("ROLLBACK")
            cursor.execute(
                "UPDATE one_referral_program_settings SET milestones = %s::jsonb WHERE version = 3",
                (json.dumps(before[2][3]),),
            )
            cursor.execute("""
                UPDATE one_referral_program_settings
                   SET activated_at = activated_at + INTERVAL '1 second'
                 WHERE version = 3
            """)
            with pytest.raises(psycopg2.Error, match="lineage is incomplete"):
                cursor.execute(adapted_sql)
            cursor.execute("ROLLBACK")
            cursor.execute("""
                UPDATE one_referral_program_settings
                   SET activated_at = (SELECT retired_at FROM one_referral_program_settings
                                        WHERE version = 2)
                 WHERE version = 3
            """)

            # The lineage table lock must still permit ordinary inserts whose
            # foreign key checks read the currently active settings row.
            cursor.execute(
                "BEGIN; LOCK TABLE one_referral_program_settings IN SHARE ROW EXCLUSIVE MODE"
            )
            try:
                with closing(psycopg2.connect(fixture_dsn)) as reader:
                    reader.autocommit = True
                    with reader.cursor() as reader_cursor:
                        reader_cursor.execute("SET lock_timeout = '500ms'")
                        reader_cursor.execute("INSERT INTO synthetic_reward_reference VALUES (3)")
            finally:
                cursor.execute("ROLLBACK")

            # A policy writer can hold a v2 row lock before its UPDATE asks
            # for a table write lock. Replay must not wait for that row while
            # holding SHARE ROW EXCLUSIVE, or the two sessions deadlock.
            with closing(psycopg2.connect(fixture_dsn)) as writer:
                writer.autocommit = True
                with writer.cursor() as writer_cursor:
                    writer_cursor.execute("BEGIN")
                    writer_cursor.execute(
                        "SELECT version FROM one_referral_program_settings WHERE version = 2 FOR UPDATE"
                    )
                    started = threading.Event()
                    replay_pid: list[int] = []
                    replay_errors: list[Exception] = []
                    slowed_replay = adapted_sql.replace(
                        "  LOCK TABLE one_referral_program_settings IN SHARE ROW EXCLUSIVE MODE;",
                        "  LOCK TABLE one_referral_program_settings IN SHARE ROW EXCLUSIVE MODE;\n"
                        "  PERFORM pg_sleep(0.5);",
                        1,
                    )

                    def run_replay() -> None:
                        try:
                            with closing(psycopg2.connect(fixture_dsn)) as replay_conn:
                                replay_conn.autocommit = True
                                with replay_conn.cursor() as replay_cursor:
                                    replay_cursor.execute("SELECT pg_backend_pid()")
                                    replay_pid.append(replay_cursor.fetchone()[0])
                                    started.set()
                                    replay_cursor.execute(slowed_replay)
                        except Exception as error:  # noqa: BLE001 - assert thread result below
                            replay_errors.append(error)
                            started.set()

                    thread = threading.Thread(target=run_replay)
                    thread.start()
                    try:
                        assert started.wait(timeout=3)
                        assert replay_pid, replay_errors
                        deadline = time.monotonic() + 3
                        while time.monotonic() < deadline:
                            writer_cursor.execute(
                                """
                                SELECT 1 FROM pg_locks
                                 WHERE pid = %s
                                   AND relation = 'one_referral_program_settings'::regclass
                                   AND mode = 'ShareRowExclusiveLock' AND granted
                            """,
                                (replay_pid[0],),
                            )
                            if writer_cursor.fetchone():
                                break
                            time.sleep(0.01)
                        else:
                            pytest.fail("replay never acquired the policy table lock")
                        writer_cursor.execute("SET LOCAL statement_timeout = '3s'")
                        writer_cursor.execute(
                            "UPDATE one_referral_program_settings SET points = points WHERE version = 2"
                        )
                        writer_cursor.execute("COMMIT")
                    finally:
                        thread.join(timeout=5)
                        if (
                            writer.get_transaction_status()
                            != psycopg2.extensions.TRANSACTION_STATUS_IDLE
                        ):
                            writer_cursor.execute("ROLLBACK")
                    assert not thread.is_alive()
                    assert not replay_errors


@pytest.mark.parametrize(
    "filename", ("289_one_referral_program_settings_v2.sql", "338_one_referral_usd_catalogue.sql")
)
def test_referral_replay_rejects_changed_published_source(filename):
    entry = build_manifest_entries(
        Path(__file__).resolve().parents[1] / "db/migrations",
        (filename,),
    )[0]
    with pytest.raises(MigrationAuthorityError, match="checksum changed"):
        _replay_sql(replace(entry, sql=entry.sql + "\n-- changed"))


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
@pytest.mark.parametrize("mode", [MigrationMode.REPLAY, MigrationMode.LEDGER])
async def test_concurrent_index_opt_in_runs_outside_transaction(tmp_path: Path, mode):
    (tmp_path / "114_existing.sql").write_text("SELECT 114", encoding="utf-8")
    sql = (
        "-- migration: transactional=false\n"
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS test_idx ON test_table(id);\n"
    )
    (tmp_path / "203_index.sql").write_text(sql, encoding="utf-8")
    entries = build_manifest_entries(tmp_path, ("114_existing.sql", "203_index.sql"))
    assert entries[0].transactional is True
    assert entries[1].transactional is False

    class ConcurrentConnection(FakeConnection):
        async def execute(self, statement, *args):
            if statement == sql:
                assert not self.in_transaction
            return await super().execute(statement, *args)

    conn = ConcurrentConnection()
    conn.rows["baseline:114"] = {
        "migration_id": "baseline:114",
        "filename": "release_migration_manifest.json@114",
        "checksum_sha256": manifest_checksum(entries[:1]),
        "status": "baseline",
        "baseline_through": 114,
    }
    await apply_manifest_entries(conn, entries, mode=mode)
    assert sql in conn.executed_sql
    if mode is MigrationMode.LEDGER:
        assert conn.rows["203"]["status"] == "applied"
    else:
        assert "203" not in conn.rows
    assert conn.locked is False


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
@pytest.mark.parametrize("history", ["applied", "baselined"])
@pytest.mark.parametrize(
    "version,filename,checksum",
    [
        (
            295,
            "295_direct_message_attachments.sql",
            "f76a5e6e71d1979dbcd71d2e3c5ad390c1aa9f018742946bee2dcea3831d4edc",
        ),
        (
            288,
            "288_drive_request_feed_stream.sql",
            "b13a15ee0d27a4c78efd99718adb1996ecb8c54254dbf1377a250d8791424ee6",
        ),
        (
            289,
            "289_one_referral_program_settings_v2.sql",
            "52a25acc61327f6b7f3b69c905fae9425844c934ac7a1000e040d7f5b2737c65",
        ),
        (
            361,
            "361_system_push_outbox.sql",
            "41bb1bf983b3a79df83ddb2ae2106ff8132ee2f73d666183cd9b7b8bb5f94608",
        ),
        (
            329,
            "329_drive_request_cent_prices.sql",
            "ee91dfcc494deda10e84e0a06b506a93022c3416264c160ae6541db5786dda4a",
        ),
        (
            212,
            "212_location_command_runtime.sql",
            "c10a587ce907e5913df4eeec25a4d71ef1aa8a709d8fccccf2eb223e23448d3d",
        ),
        (
            231,
            "231_document_review_authority.sql",
            "55dfd1bdff4326fdaf8eea96a72cc32685b545a2e185489f4adcd5bb95f19337",
        ),
        (
            248,
            "248_adk_chat_action_authority.sql",
            "8922c7430b8fc04d4430f6e127d93605f878d402ba67ca751dbb09da41f036a7",
        ),
    ],
)
async def test_legacy_replay_repair_preserves_historical_ledger_checksums(
    history, version, filename, checksum
):
    entries = build_manifest_entries(
        Path(__file__).resolve().parents[1] / "db/migrations",
        (filename,),
    )
    historical = replace(
        entries[0],
        checksum_sha256=checksum,
    )
    through = version - 1 if history == "applied" else version
    conn = FakeConnection()
    conn.rows[f"baseline:{through}"] = {
        "migration_id": f"baseline:{through}",
        "checksum_sha256": manifest_checksum(())
        if history == "applied"
        else manifest_checksum((historical,)),
        "status": "baseline",
        "baseline_through": through,
    }
    if history == "applied":
        conn.rows[str(version)] = {
            "migration_id": str(version),
            "filename": historical.filename,
            "checksum_sha256": historical.checksum_sha256,
            "status": "applied",
        }
    original_rows = {key: dict(value) for key, value in conn.rows.items()}
    assert await apply_manifest_entries(conn, entries, mode=MigrationMode.LEDGER) == ()
    assert await apply_manifest_entries(conn, entries, mode=MigrationMode.OBSERVE) == ()
    assert conn.rows == original_rows
    assert entries[0].sql not in conn.executed_sql


@pytest.mark.asyncio
@pytest.mark.parametrize("drift", ["metadata", "body", "both"])
@pytest.mark.parametrize(
    "filename",
    [
        "295_direct_message_attachments.sql",
        "288_drive_request_feed_stream.sql",
        "289_one_referral_program_settings_v2.sql",
        "298_stripe_mode_isolation.sql",
        "304_connect_bank_payout_reconciliation.sql",
        "361_system_push_outbox.sql",
        "329_drive_request_cent_prices.sql",
        "212_location_command_runtime.sql",
        "231_document_review_authority.sql",
        "248_adk_chat_action_authority.sql",
    ],
)
async def test_legacy_replay_rejects_unknown_or_forged_source_before_execution(drift, filename):
    entry = build_manifest_entries(
        Path(__file__).resolve().parents[1] / "db/migrations",
        (filename,),
    )[0]
    sql = entry.sql if drift == "metadata" else entry.sql + "\n-- unknown body"
    checksum = (
        "0" * 64
        if drift == "metadata"
        else hashlib.sha256(sql.encode("utf-8")).hexdigest()
        if drift == "both"
        else entry.checksum_sha256
    )
    changed = replace(entry, sql=sql, checksum_sha256=checksum)
    conn = FakeConnection()
    with pytest.raises(MigrationAuthorityError, match="replay source checksum changed"):
        await apply_manifest_entries(conn, (changed,), mode=MigrationMode.REPLAY)
    assert conn.executed_sql == []
    assert conn.locked is False


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


class _ProbeConnection:
    """The second connection the lock probe reads from. Answers only the two
    read-only catalog queries it is allowed to send."""

    def __init__(self, blockers: list[dict]) -> None:
        self.blockers = blockers
        self.sql: list[str] = []

    async def fetch(self, sql: str, *_args):
        self.sql.append(sql)
        assert "pg_blocking_pids" in sql
        return self.blockers

    async def fetchrow(self, sql: str, *_args):
        self.sql.append(sql)
        assert "pg_locks" in sql
        return {"relation": "consent_audit", "mode": "AccessExclusiveLock"}


class _ProbePool:
    def __init__(self, probe_conn: _ProbeConnection) -> None:
        self.probe_conn = probe_conn
        self.acquired = 0

    def acquire(self, *, timeout: float | None = None):
        pool = self

        class _Ctx:
            async def __aenter__(self_inner):
                pool.acquired += 1
                return pool.probe_conn

            async def __aexit__(self_inner, *_exc):
                return False

        return _Ctx()


_BLOCKER_ROW = {
    "pid": 4242,
    "application_name": "consent api\n'; DROP TABLE x; --",
    "state": "idle in transaction",
    "wait_event_type": "Client",
    "wait_event": "ClientRead",
    "xact_age_s": 42,
    "query_age_s": 40,
}


# Captured at import, before any test's no_sleep fixture replaces asyncio.sleep.
_real_sleep = asyncio.sleep


class WaitingContention(ContendingConnection):
    """Like ContendingConnection, but the contended statement actually waits
    before timing out, the way Postgres does, so the probe has time to look."""

    def get_server_pid(self) -> int:
        return 777

    async def execute(self, sql: str, *args):
        if self.target_sql in sql and "lock_timeout" not in sql:
            await _real_sleep(0.05)
        return await super().execute(sql, *args)


@pytest.mark.asyncio
async def test_lock_contention_names_the_blocking_session(tmp_path: Path, monkeypatch, capsys):
    """Six UAT deploys died on 55P03 with nothing saying WHO held the lock.
    The retry line and the final failure must now name the blocker."""
    monkeypatch.setattr("db.migration_authority._LOCK_PROBE_MAX_INTERVAL_S", 0.005)
    monkeypatch.setattr("db.migration_authority._LOCK_RETRY_BASE_DELAY_S", 0.001)
    probe_conn = _ProbeConnection([_BLOCKER_ROW])
    conn = WaitingContention("SELECT 115", fail_times=99)

    with pytest.raises(_LockTimeout):
        await apply_manifest_entries(
            conn,
            _entries(tmp_path),
            mode=MigrationMode.REPLAY,
            lock_probe_pool=_ProbePool(probe_conn),
        )

    err = capsys.readouterr().err
    assert "waiting for AccessExclusiveLock on consent_audit" in err
    assert "blocked by pid=4242" in err
    assert "state=idle_in_transaction" in err
    assert "xact_age=42s query_age=40s" in err
    assert "gave up after 4 lock attempts; waiting for" in err
    # application_name is client-controlled free text: bounded and defanged.
    assert "app=consent_api____DROP_TABLE_x__--" in err


def test_the_blocker_probe_never_reads_query_text():
    """Another session's SQL can carry personal information. The probe may
    read pid, application_name, state, wait event and ages -- never ``query``."""
    from db import migration_authority

    for sql in (migration_authority._BLOCKERS_SQL, migration_authority._WAITING_ON_SQL):
        assert not re.search(r"\bquery\b(?!_start)", sql), sql
        assert not re.search(r"\b(INSERT|UPDATE|DELETE|ALTER|DROP|LOCK)\b", sql, re.I), sql


@pytest.mark.asyncio
async def test_a_fast_migration_never_touches_the_probe_connection(tmp_path: Path):
    """The probe starts after its first interval, so the ordinary millisecond
    migration costs nothing -- not even a second connection."""
    pool = _ProbePool(_ProbeConnection([]))
    conn = WaitingContention("SELECT never-matches", fail_times=0)

    applied = await apply_manifest_entries(
        conn, _entries(tmp_path), mode=MigrationMode.REPLAY, lock_probe_pool=pool
    )

    assert len(applied) == 2
    assert pool.acquired == 0


@pytest.mark.asyncio
async def test_a_broken_probe_never_changes_the_migration_outcome(
    tmp_path: Path, monkeypatch, capsys
):
    monkeypatch.setattr("db.migration_authority._LOCK_PROBE_MAX_INTERVAL_S", 0.005)
    monkeypatch.setattr("db.migration_authority._LOCK_RETRY_BASE_DELAY_S", 0.001)

    class _BrokenPool:
        def acquire(self, *, timeout: float | None = None):
            raise TimeoutError("pool exhausted")

    conn = WaitingContention("SELECT 115", fail_times=1)
    applied = await apply_manifest_entries(
        conn, _entries(tmp_path), mode=MigrationMode.REPLAY, lock_probe_pool=_BrokenPool()
    )

    assert "20260721_ABC_new.sql" in applied, "the retry still succeeds"
    assert "blocker probe unavailable [TimeoutError]" in capsys.readouterr().err
