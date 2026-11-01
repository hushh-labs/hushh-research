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

from db import private_agent_adoption
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
    assert_notification_successor_survives_420_replay,
    assert_pending_ledger_receipt,
    authorization_state,
    canonical_database,
    custody_catalog,
    execute_mode,
    guard_catalog,
    install_custody_fixture,
    install_legacy_guards,
    receipt_state,
)
from tests.pkm_conformance.postgres_harness import find_pg_bin
from tests.test_migrations_are_replay_safe import replay_pg

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "db/migrations"
FOUNDATION = "420_private_agent_lifecycle_foundation.sql"
IMMUTABLE_SHA256 = "78981e14e2dc4ef0d40a6275f785a5015367ea08d00ab7b4ef352538cb612f2d"
pytestmark = [pytest.mark.feature_drive_packets, pytest.mark.trace_loop]


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
        # Preserve the corrected validator, its ACL and its refusal boundary.
        assert_notification_successor_survives_420_replay(connection, replay_pg, database, entry)
        # The next release must preserve423's installed admission guard while
        # replaying immutable420, rather than rejecting or removing it.
        successor = (MIGRATIONS / "423_account_shared_provider_authority.sql").read_text()
        with connection.cursor() as cursor:
            cursor.execute(successor)
        assert asyncio.run(execute_mode(replay_pg, database, entry, MigrationMode.REPLAY)) == (
            FOUNDATION,
        )
        with connection.cursor() as cursor:
            cursor.execute("SELECT public.account_provider_cleanup_contract_version()")
            assert cursor.fetchone()[0] == 2
            cursor.execute("""CREATE OR REPLACE FUNCTION public.guard_account_shared_provider_authority()
                RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public
                AS $$ BEGIN RETURN NEW; END $$""")
        try:
            with pytest.raises(asyncpg.RaiseError, match="shared provider authority successor"):
                asyncio.run(execute_mode(replay_pg, database, entry, MigrationMode.REPLAY))
        finally:
            with connection.cursor() as cursor:
                cursor.execute(successor)
        with connection.cursor() as cursor:
            cursor.execute("""CREATE OR REPLACE FUNCTION public.account_provider_cleanup_contract_version()
                RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT NULL::integer $$""")
        try:
            with pytest.raises(asyncpg.RaiseError, match="shared provider authority successor"):
                asyncio.run(execute_mode(replay_pg, database, entry, MigrationMode.REPLAY))
        finally:
            with connection.cursor() as cursor:
                cursor.execute(successor)
    assert hashlib.sha256((MIGRATIONS / FOUNDATION).read_bytes()).hexdigest() == IMMUTABLE_SHA256


@pytest.mark.parametrize("filename", [FOUNDATION, "421_cloud_removal_recovery.sql"])
@pytest.mark.parametrize("drift", ["metadata", "body", "rehashed_body"])
def test_private_agent_adoption_refuses_changed_immutable_source(drift, filename):
    [entry] = build_manifest_entries(MIGRATIONS, [filename])
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


@pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")
def test_installed_custody_family_survives_replay_and_refuses_partial_authority(
    replay_pg, monkeypatch
):
    entries = build_manifest_entries(MIGRATIONS, [FOUNDATION, "421_cloud_removal_recovery.sql"])
    connection, database = canonical_database(replay_pg, monkeypatch)

    def replay(entry):
        return asyncio.run(execute_mode(replay_pg, database, entry, MigrationMode.REPLAY))

    with closing(connection):
        for entry in entries:
            replay(entry)
        # Even an unknown overload alone is a footprint, before any sentinel
        # or reviewed successor body has been installed.
        with connection.cursor() as cursor:
            cursor.execute(
                "CREATE FUNCTION public.private_gcp_coordinates(integer) "
                "RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$"
            )
        partial = custody_catalog(connection)
        for entry in entries:
            with pytest.raises(asyncpg.RaiseError, match="Unqualified managed custody"):
                replay(entry)
            assert custody_catalog(connection) == partial
        with connection.cursor() as cursor:
            cursor.execute("DROP FUNCTION public.private_gcp_coordinates(integer)")
        before = install_custody_fixture(connection)
        guards = guard_catalog(connection)
        # The old420 path reproduces the actual deployed failure.
        with monkeypatch.context() as broken:
            broken.setattr(private_agent_adoption, "hosted_custody_adoption", lambda sql: sql)
            with pytest.raises(asyncpg.RaiseError, match="expected_erasure_bootstrap_release"):
                replay(entries[0])
        assert custody_catalog(connection) == before
        # The old421 path really overwrites the newer authority guard.
        with monkeypatch.context() as broken:
            broken.setattr(
                private_agent_adoption, "hosted_custody_recovery_replay", lambda entry, sql: sql
            )
            replay(entries[1])
        assert (
            custody_catalog(connection)["guard_personal_agent_erasure_registry()"]
            != before["guard_personal_agent_erasure_registry()"]
        )
        assert install_custody_fixture(connection) == before
        for _ in range(2):
            for entry in entries:
                assert replay(entry) == (entry.filename,)
                assert custody_catalog(connection) == before
                assert guard_catalog(connection) == guards
        defects = (
            "DROP FUNCTION public.erasure_authorization_history(jsonb,jsonb)",
            "DROP FUNCTION public.private_gcp_coordinates(jsonb)",
            "CREATE OR REPLACE FUNCTION public.managed_prefix_items_complete(r jsonb,kind text) "
            "RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public "
            "AS $$ BEGIN RETURN true; END $$",
            "CREATE FUNCTION public.private_gcp_coordinates(integer) RETURNS jsonb "
            "LANGUAGE sql AS $$ SELECT '{}'::jsonb $$",
        )
        for defect in defects:
            with connection.cursor() as cursor:
                cursor.execute(defect)
            changed = custody_catalog(connection)
            for entry in entries:
                with pytest.raises(asyncpg.RaiseError, match="Unqualified managed custody"):
                    replay(entry)
                assert custody_catalog(connection) == changed
                assert guard_catalog(connection) == guards
            with connection.cursor() as cursor:
                cursor.execute("DROP FUNCTION IF EXISTS public.private_gcp_coordinates(integer)")
            before = install_custody_fixture(connection)


def seed_legacy_authorization(connection):
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
        for filename, digest in RECEIPT_PREDECESSORS:
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
    receipts = receipt_state(connection)
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
            assert receipt_state(connection) == receipts
        cursor.execute(
            "CREATE UNIQUE INDEX synthetic_adoption_drift ON public.personal_agent_registry(space_id)"
        )
        try:
            with pytest.raises(psycopg2.errors.RaiseException, match="indexes"):
                cursor.execute(execution_sql(entry))
            cursor.execute("ROLLBACK")
            assert authorization_state(connection) == before
            assert receipt_state(connection) == receipts
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
def test_legacy_unknown_authorization_preserves_wire_history_and_blocks_replacement(
    replay_pg, monkeypatch, mode
):
    [entry] = build_manifest_entries(MIGRATIONS, [FOUNDATION])
    connection, database = canonical_database(replay_pg, monkeypatch)
    with closing(connection):
        before = seed_legacy_authorization(connection)
        receipts = receipt_state(connection)
        assert len(receipts) == 1
        assert "ledger" not in receipts[0][0]
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
        following = build_manifest_entries(
            MIGRATIONS,
            [
                "421_cloud_removal_recovery.sql",
                "422_financial_packet_discovery_capacity.sql",
                "423_account_shared_provider_authority.sql",
            ],
        )
        assert asyncio.run(
            execute_mode(replay_pg, database, following[0], mode, following=following[1:])
        ) == tuple(e.filename for e in following)
        expected = (
            () if mode is MigrationMode.LEDGER else (FOUNDATION, *(e.filename for e in following))
        )
        assert (
            asyncio.run(execute_mode(replay_pg, database, entry, mode, following=following))
            == expected
        )
        assert authorization_state(connection) == normalized
        assert receipt_state(connection) == [
            ({**row, "ledger": "consent"}, ctid) for row, ctid in receipts
        ]
    assert hashlib.sha256((MIGRATIONS / FOUNDATION).read_bytes()).hexdigest() == IMMUTABLE_SHA256
