"""Adopt reviewed legacy consent guards without replacing or bypassing their authority."""

# ruff: noqa: F401,F811 -- reuse the canonical disposable graduation fixture
from __future__ import annotations

import asyncio
import hashlib
from contextlib import closing
from dataclasses import replace
from pathlib import Path

import asyncpg
import psycopg2
import pytest
from sqlalchemy import create_engine
from sqlalchemy.exc import IntegrityError

from db import migrate
from db.db_client import DatabaseClient, DatabaseExecutionError
from db.migration_authority import (
    MigrationAuthorityError,
    MigrationMode,
    apply_manifest_entries,
    build_manifest_entries,
    manifest_checksum,
)
from db.private_agent_adoption import _authorization_attempts_sql, _qualification_sql, execution_sql
from hushh_mcp.services.byoc_setup_job_service import ByocSetupJobRepo
from tests.helpers.private_agent_adoption import (
    LEGACY_FUNCTIONS,
    LEGACY_GUARD_MUTATIONS,
    LEGACY_PREDECESSOR_DRIFT,
    LEGACY_PREDECESSOR_SCHEMA,
    LEGACY_TRIGGERS,
    RECEIPT_PREDECESSORS,
    assert_receipt_ledger_preserved,
)
from tests.pkm_conformance.postgres_harness import find_pg_bin
from tests.test_migrations_are_replay_safe import replay_pg

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "db/migrations"
FOUNDATION = "420_private_agent_lifecycle_foundation.sql"
IMMUTABLE_SHA256 = "78981e14e2dc4ef0d40a6275f785a5015367ea08d00ab7b4ef352538cb612f2d"
pytestmark = [pytest.mark.feature_drive_packets, pytest.mark.trace_loop]


def canonical_database(server, monkeypatch):
    database = "synthetic_consent_adoption"
    server.execute("CREATE DATABASE " + database)
    server.execute(
        "CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN"
    )
    monkeypatch.setattr(
        migrate,
        "release_migration_files",
        lambda _environment: tuple(
            name for name in migrate.RELEASE_MIGRATION_FILES if int(name[:3]) < 420
        ),
    )
    for key, value in {
        "DB_USER": "hushh",
        "DB_PASSWORD": "synthetic",
        "DB_HOST": "127.0.0.1",
        "DB_PORT": str(server.port),
        "DB_NAME": database,
        "DB_UNIX_SOCKET": server.dir,
        "GCP_PROJECT_ID": "local-schema-qualification",
        "ENVIRONMENT": "test",
        "HUSHH_RELEASE_ENVIRONMENT": "production",
        "HUSHH_MIGRATION_MODE": "replay",
    }.items():
        monkeypatch.setenv(key, value)
    connection = psycopg2.connect(host=server.dir, port=server.port, user="hushh", dbname=database)
    connection.autocommit = True
    with connection.cursor() as cursor:
        cursor.execute((ROOT / "db/legacy/init_legacy_schema.sql").read_text())

    async def initialize():
        pool = await asyncpg.create_pool(
            host=server.dir,
            port=server.port,
            user="hushh",
            database=database,
            min_size=1,
            max_size=2,
            command_timeout=60,
        )
        try:
            await migrate.run_init_migration(pool)
        finally:
            await pool.close()

    try:
        asyncio.run(initialize())
    except BaseException:
        connection.close()
        raise
    return connection, database


def install_legacy_guards(connection, *, triggers=True):
    with connection.cursor() as cursor:
        cursor.execute("""CREATE TABLE public.consumer_mcp_connections(
          connection_id TEXT PRIMARY KEY,user_id TEXT,generation BIGINT,authorization_floor_id BIGINT)""")
        cursor.execute(LEGACY_FUNCTIONS)
        if triggers:
            cursor.execute(LEGACY_TRIGGERS)


def guard_catalog(connection):
    with connection.cursor() as cursor:
        cursor.execute("""SELECT t.oid,t.tgname,t.tgenabled,t.tgfoid,
          pg_get_triggerdef(t.oid,true),pg_get_functiondef(p.oid),p.prosecdef,p.proconfig
          FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
          WHERE t.tgrelid='public.consent_audit'::regclass
          AND t.tgname LIKE 'zz_%consumer_memory%' ORDER BY t.tgname""")
        return cursor.fetchall()


def assert_absent_guard_qualification_blocks_concurrent_install(connection, server, database):
    with connection.cursor() as cursor:
        cursor.execute(
            "CREATE FUNCTION synthetic_adoption_lock_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$"
        )
    trigger = "CREATE TRIGGER zz_consumer_memory_consent BEFORE INSERT ON public.consent_audit FOR EACH ROW EXECUTE FUNCTION synthetic_adoption_lock_guard()"
    with (
        connection.cursor() as admitted,
        closing(
            psycopg2.connect(host=server.dir, port=server.port, user="hushh", dbname=database)
        ) as contender,
    ):
        contender.autocommit = True
        admitted.execute("BEGIN")
        try:
            admitted.execute(_qualification_sql())
            with contender.cursor() as writer:
                writer.execute("SET lock_timeout='200ms'; SET statement_timeout='2s'")
                writer.execute("BEGIN")
                try:
                    writer.execute("""INSERT INTO public.consent_audit
                      (token_id,user_id,agent_id,scope,action,issued_at) VALUES
                      ('synthetic-lock-proof','synthetic-adoption-writer',
                       'synthetic-adoption','synthetic.lock','REQUESTED',0) RETURNING id""")
                    assert writer.fetchone()[0] > 0
                finally:
                    writer.execute("ROLLBACK")
                with pytest.raises(psycopg2.errors.LockNotAvailable):
                    writer.execute(trigger)
                admitted.execute("ROLLBACK")
                # The exact DDL succeeds once admission releases its table lock.
                writer.execute(trigger)
                writer.execute("DROP TRIGGER zz_consumer_memory_consent ON public.consent_audit")
        finally:
            admitted.execute("ROLLBACK")
    assert guard_catalog(connection) == []
    with connection.cursor() as cursor:
        cursor.execute("DROP FUNCTION synthetic_adoption_lock_guard()")


def reject_guard_drift(connection, entry):
    with connection.cursor() as cursor:
        for mutation, cleanup in LEGACY_GUARD_MUTATIONS:
            cursor.execute(mutation)
            before = guard_catalog(connection)
            try:
                with pytest.raises(psycopg2.errors.RaiseException):
                    cursor.execute(execution_sql(entry))
                cursor.execute("ROLLBACK")
                assert guard_catalog(connection) == before
            finally:
                cursor.execute("ROLLBACK")
                cursor.execute(cleanup)


async def execute_mode(server, database, entry, mode):
    connection = await asyncpg.connect(
        host=server.dir, port=server.port, user="hushh", database=database
    )
    try:
        return await apply_manifest_entries(
            connection, (entry,), mode=mode, deploy_sha="synthetic-adoption-head"
        )
    finally:
        await connection.close()


def assert_pending_ledger_receipt(server, database, connection, entry):
    with connection.cursor() as cursor:
        cursor.execute((ROOT / "db/foundations/schema_migrations_v2.sql").read_text())
        # Established operational baseline is a fixture prerequisite; baseline/backup authorization is separate.
        cursor.execute(
            """INSERT INTO schema_migrations(migration_id,filename,checksum_sha256,status,baseline_through)
          VALUES('baseline:419','synthetic-baseline-419',%s,'baseline',419)""",
            (manifest_checksum(()),),
        )
    before = guard_catalog(connection)
    assert asyncio.run(execute_mode(server, database, entry, MigrationMode.LEDGER)) == (FOUNDATION,)
    with connection.cursor() as cursor:
        cursor.execute("SELECT * FROM schema_migrations WHERE migration_id='420'")
        receipt = cursor.fetchone()
        assert receipt[1:4] == (FOUNDATION, IMMUTABLE_SHA256, "applied")
        assert receipt[6] == "synthetic-adoption-head" and receipt[7] is None
    normalized = authorization_state(connection)
    assert asyncio.run(execute_mode(server, database, entry, MigrationMode.LEDGER)) == ()
    with connection.cursor() as cursor:
        cursor.execute("SELECT * FROM schema_migrations WHERE migration_id='420'")
        assert cursor.fetchone() == receipt
    assert guard_catalog(connection) == before
    assert authorization_state(connection) == normalized


@pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")
def test_immutable_foundation_preserves_qualified_guards_and_pending_ledger_receipt(
    replay_pg, monkeypatch
):
    [entry] = build_manifest_entries(MIGRATIONS, [FOUNDATION])
    assert entry.checksum_sha256 == IMMUTABLE_SHA256
    connection, database = canonical_database(replay_pg, monkeypatch)
    with closing(connection):
        # Neither retained guard exists in the ordinary canonical lineage.
        assert guard_catalog(connection) == []
        assert asyncio.run(execute_mode(replay_pg, database, entry, MigrationMode.REPLAY)) == (
            FOUNDATION,
        )
        assert guard_catalog(connection) == []
        assert_absent_guard_qualification_blocks_concurrent_install(connection, replay_pg, database)
        install_legacy_guards(connection)
        before = guard_catalog(connection)
        assert len(before) == 2
        with connection.cursor() as cursor:
            # Published420 refuses these substantive guards; preserve that immutable source.
            with pytest.raises(psycopg2.errors.RaiseException, match="triggers"):
                cursor.execute(entry.sql)
            cursor.execute("ROLLBACK")
        assert asyncio.run(execute_mode(replay_pg, database, entry, MigrationMode.REPLAY)) == (
            FOUNDATION,
        )
        assert guard_catalog(connection) == before
        reject_guard_drift(connection, entry)
        assert_pending_ledger_receipt(replay_pg, database, connection, entry)
    assert hashlib.sha256((MIGRATIONS / FOUNDATION).read_bytes()).hexdigest() == IMMUTABLE_SHA256


@pytest.mark.parametrize("drift", ["metadata", "body", "rehashed_body"])
def test_private_agent_adoption_refuses_changed_immutable_source(drift):
    [entry] = build_manifest_entries(MIGRATIONS, [FOUNDATION])
    body = entry.sql + "\n-- unreviewed source\n"
    altered = (
        replace(entry, checksum_sha256="0" * 64)
        if drift == "metadata"
        else replace(
            entry,
            sql=body,
            checksum_sha256=hashlib.sha256(body.encode()).hexdigest()
            if drift == "rehashed_body"
            else entry.checksum_sha256,
        )
    )
    with pytest.raises(MigrationAuthorityError, match="checksum"):
        execution_sql(altered)


def authorization_state(connection):
    with connection.cursor() as cursor:
        cursor.execute("""SELECT a.atttypid::regtype::text,a.attnotnull,
          pg_get_expr(d.adbin,d.adrelid),a.attgenerated,a.attidentity FROM pg_attribute a
          LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
          WHERE a.attrelid='public.byoc_setup_jobs'::regclass
          AND a.attname='authorization_attempts' AND NOT a.attisdropped""")
        column = cursor.fetchone()
        cursor.execute(
            "SELECT user_id,to_jsonb(j),ctid::text FROM public.byoc_setup_jobs j ORDER BY user_id"
        )
        return column, cursor.fetchall()


def receipt_state(connection):
    with connection.cursor() as cursor:
        cursor.execute("""SELECT to_jsonb(r),ctid::text FROM public.consent_audit_receipts r
          WHERE subject_id='synthetic-retained' ORDER BY id""")
        return cursor.fetchall()


def seed_legacy_authorization(connection, *, receipt_ledger=True):
    with connection.cursor() as cursor:
        canonical = authorization_state(connection)
        cursor.execute(_authorization_attempts_sql())
        assert authorization_state(connection) == canonical
        cursor.execute(
            "BEGIN; ALTER TABLE public.byoc_setup_jobs DROP COLUMN authorization_attempts"
        )
        try:
            absent = authorization_state(connection)
            assert absent[0] is None
            cursor.execute(_authorization_attempts_sql())
            assert authorization_state(connection) == absent
        finally:
            cursor.execute("ROLLBACK")
        predecessors = RECEIPT_PREDECESSORS if receipt_ledger else RECEIPT_PREDECESSORS[:1]
        for filename, digest in predecessors:
            source = (MIGRATIONS / "parked" / filename).read_bytes()
            assert hashlib.sha256(source).hexdigest() == digest
            cursor.execute(source.decode())
        cursor.execute(LEGACY_PREDECESSOR_SCHEMA)
        cursor.execute("""INSERT INTO public.consent_audit_receipts
          (subject_id,seq,event_type,issued_at_ms,prev_hash,hash,signature)
          VALUES('synthetic-retained',1,'synthetic-preserved',0,'','synthetic-hash','synthetic-signature')""")
        cursor.execute("""ALTER TABLE public.byoc_setup_jobs
          ALTER COLUMN authorization_attempts DROP NOT NULL,
          ALTER COLUMN authorization_attempts DROP DEFAULT;
          INSERT INTO public.byoc_setup_jobs(user_id,job_id,project_id,status,stage,authorization_attempts)
          VALUES('synthetic-null','synthetic-null-job','synthetic-unknown-project','failed','applying_iam',NULL),
          ('synthetic-retained','synthetic-old-job','synthetic-project','recorded','recorded',
           '{"opaque_fixture":{"retained":["marker",7]}}'::jsonb)""")
    return authorization_state(connection)


def reject_authorization_drift(connection, entry, before):
    mutations = (
        tuple(
            (ddl, "authorization_attempts")
            for ddl in (
                "ALTER TABLE public.byoc_setup_jobs ALTER COLUMN authorization_attempts TYPE json USING authorization_attempts::json",
                "ALTER TABLE public.byoc_setup_jobs ALTER COLUMN authorization_attempts SET DEFAULT '[]'::jsonb",
                "ALTER TABLE public.byoc_setup_jobs DROP COLUMN authorization_attempts; ALTER TABLE public.byoc_setup_jobs ADD COLUMN authorization_attempts jsonb GENERATED ALWAYS AS ('{}'::jsonb) STORED",
            )
        )
        + LEGACY_PREDECESSOR_DRIFT
        + (
            (
                "ALTER TABLE public.consent_audit_receipts ADD COLUMN IF NOT EXISTS ledger text NOT NULL DEFAULT 'consent'; "
                "ALTER TABLE public.consent_audit_receipts ALTER COLUMN ledger SET DEFAULT 'internal'",
                "column",
            ),
        )
    )
    with connection.cursor() as cursor:
        for ddl, failure in mutations:
            cursor.execute("BEGIN")
            try:
                cursor.execute(ddl)
                with pytest.raises(psycopg2.errors.RaiseException, match=failure):
                    cursor.execute(execution_sql(entry))
            finally:
                cursor.execute("ROLLBACK")
            assert authorization_state(connection) == before
        cursor.execute(
            "CREATE UNIQUE INDEX synthetic_adoption_drift ON public.personal_agent_registry(space_id)"
        )
        try:
            with pytest.raises(psycopg2.errors.RaiseException, match="indexes"):
                cursor.execute(execution_sql(entry))
            cursor.execute("ROLLBACK")
            assert authorization_state(connection) == before
        finally:
            cursor.execute("ROLLBACK")
            cursor.execute("DROP INDEX synthetic_adoption_drift")


def assert_installed_authorization_guard_is_not_bypassed(connection, entry, before):
    prefixes = (
        "CREATE OR REPLACE FUNCTION public.guard_byoc_authorization_attempts()",
        "CREATE TRIGGER zz_byoc_authorization_attempts BEFORE",
    )
    with connection.cursor() as cursor:
        cursor.execute("BEGIN")
        try:
            for prefix in prefixes:
                body = entry.sql.split("$object$" + prefix, 1)[1].split("$object$;", 1)[0]
                cursor.execute(prefix + body)
            with pytest.raises(psycopg2.Error, match="authorization recovery immutable"):
                cursor.execute(_authorization_attempts_sql())
        finally:
            cursor.execute("ROLLBACK")
    assert authorization_state(connection) == before


def assert_unknown_history_check_is_required(connection, entry):
    name = "byoc_setup_authorization_history_object"
    before = authorization_state(connection)
    with connection.cursor() as cursor:
        cursor.execute(
            """SELECT contype,convalidated,pg_get_constraintdef(oid,true)
          FROM pg_constraint WHERE conrelid='public.byoc_setup_jobs'::regclass
          AND conname=%s""",
            (name,),
        )
        check = cursor.fetchone()
        assert check == (
            "c",
            False,
            "CHECK (jsonb_typeof(authorization_attempts) = 'object'::text) NOT VALID",
        )
        for replacement in ("", f"ADD CONSTRAINT {name} CHECK (true) NOT VALID"):
            cursor.execute("BEGIN")
            try:
                cursor.execute(f"ALTER TABLE public.byoc_setup_jobs DROP CONSTRAINT {name}")
                if replacement:
                    cursor.execute("ALTER TABLE public.byoc_setup_jobs " + replacement)
                with pytest.raises(psycopg2.errors.RaiseException, match="authorization"):
                    cursor.execute(execution_sql(entry))
            finally:
                cursor.execute("ROLLBACK")
            assert authorization_state(connection) == before


def assert_unknown_authorization_is_fenced(connection, server, database):
    before = authorization_state(connection)
    engine = create_engine(
        "postgresql+psycopg2://",
        creator=lambda: psycopg2.connect(
            host=server.dir, port=server.port, user="hushh", dbname=database
        ),
    )
    try:
        repo = ByocSetupJobRepo(client=DatabaseClient(engine=engine))
        with pytest.raises(DatabaseExecutionError) as denied:
            asyncio.run(
                repo.start(user_id="synthetic-null", job_id="replacement", project_id="new-project")
            )
        assert isinstance(denied.value.__cause__, IntegrityError)
        assert isinstance(denied.value.__cause__.orig, psycopg2.errors.CheckViolation)
        assert (
            denied.value.__cause__.orig.diag.constraint_name
            == "byoc_setup_authorization_history_object"
        )
    finally:
        engine.dispose()
    with connection.cursor() as cursor:
        for sql in (
            "DELETE FROM public.byoc_setup_jobs WHERE user_id='synthetic-null'",
            "UPDATE public.byoc_setup_jobs SET authorization_attempts='{}'::jsonb WHERE user_id='synthetic-null'",
        ):
            with pytest.raises(psycopg2.Error):
                cursor.execute(sql)
            assert authorization_state(connection) == before
        cursor.execute("BEGIN")
        try:
            cursor.execute("""INSERT INTO public.byoc_setup_jobs(user_id,job_id,project_id)
              VALUES('synthetic-new','synthetic-new-job','new-project')
              RETURNING authorization_attempts""")
            assert cursor.fetchone() == ({},)
        finally:
            cursor.execute("ROLLBACK")
    assert authorization_state(connection) == before


@pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")
@pytest.mark.parametrize("mode", [MigrationMode.REPLAY, MigrationMode.LEDGER])
@pytest.mark.parametrize("receipt_ledger", [False, True], ids=["pre-913", "post-913"])
def test_legacy_unknown_authorization_preserves_wire_history_and_blocks_replacement(
    replay_pg, monkeypatch, mode, receipt_ledger
):
    [entry] = build_manifest_entries(MIGRATIONS, [FOUNDATION])
    connection, database = canonical_database(replay_pg, monkeypatch)
    with closing(connection):
        before = seed_legacy_authorization(connection, receipt_ledger=receipt_ledger)
        receipts = receipt_state(connection)
        assert len(receipts) == 1
        with connection.cursor() as cursor:
            cursor.execute("SELECT last_value,is_called FROM public.consent_audit_receipts_id_seq")
            receipt_sequence = cursor.fetchone()
        assert before[0] == ("jsonb", False, None, "", "")
        with connection.cursor() as cursor:
            with pytest.raises(psycopg2.errors.RaiseException, match="column"):
                cursor.execute(entry.sql)
            cursor.execute("ROLLBACK")
        assert authorization_state(connection) == before
        assert_installed_authorization_guard_is_not_bypassed(connection, entry, before)
        reject_authorization_drift(connection, entry, before)
        if mode is MigrationMode.LEDGER:
            assert_pending_ledger_receipt(replay_pg, database, connection, entry)
        else:
            assert asyncio.run(execute_mode(replay_pg, database, entry, mode)) == (FOUNDATION,)
        column, rows = authorization_state(connection)
        assert column == ("jsonb", True, "'{}'::jsonb", "", "")
        assert rows[0][1] == before[1][0][1]
        assert rows[1] == before[1][1]
        with connection.cursor() as cursor:
            cursor.execute("""SELECT authorization_attempts IS NOT NULL,
              authorization_attempts='null'::jsonb FROM public.byoc_setup_jobs
              WHERE user_id='synthetic-null'""")
            assert cursor.fetchone() == (True, True)
        assert_unknown_authorization_is_fenced(connection, replay_pg, database)
        assert_unknown_history_check_is_required(connection, entry)
        normalized = authorization_state(connection)
        expected = () if mode is MigrationMode.LEDGER else (FOUNDATION,)
        assert asyncio.run(execute_mode(replay_pg, database, entry, mode)) == expected
        assert authorization_state(connection) == normalized
        assert_receipt_ledger_preserved(connection, receipts, receipt_sequence)
    assert hashlib.sha256((MIGRATIONS / FOUNDATION).read_bytes()).hexdigest() == IMMUTABLE_SHA256
