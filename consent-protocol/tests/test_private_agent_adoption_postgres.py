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

from db import migrate
from db.migration_authority import (
    MigrationAuthorityError,
    MigrationMode,
    apply_manifest_entries,
    build_manifest_entries,
    manifest_checksum,
)
from db.private_agent_adoption import _qualification_sql, execution_sql
from tests.pkm_conformance.postgres_harness import find_pg_bin
from tests.test_migrations_are_replay_safe import replay_pg

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "db/migrations"
FOUNDATION = "420_private_agent_lifecycle_foundation.sql"
IMMUTABLE_SHA256 = "78981e14e2dc4ef0d40a6275f785a5015367ea08d00ab7b4ef352538cb612f2d"
pytestmark = [pytest.mark.feature_drive_packets, pytest.mark.trace_loop]

# Reviewed schema-only definitions from the legacy Dev catalog. No owner rows.
LEGACY_FUNCTIONS = r"""CREATE OR REPLACE FUNCTION public.guard_consumer_memory_consent()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  binding public.consumer_mcp_connections%ROWTYPE;
  prior public.consent_audit%ROWTYPE;
  ref TEXT;
  requested_generation BIGINT;
BEGIN
  IF NEW.scope IS DISTINCT FROM 'cap.consumer.memory' THEN RETURN NEW; END IF;
  IF NEW.agent_id IS NULL OR NEW.action IS NULL
     OR NEW.agent_id !~ '^consumer_mcp:cmc_[a-f0-9]{32}:[1-9][0-9]*$'
     OR NEW.action NOT IN (
       'CONSENT_GRANTED', 'CONSUMER_TOKEN_ISSUED', 'REVOKED', 'CONSENT_DENIED'
     ) THEN
    RAISE EXCEPTION 'invalid consumer consent identity' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.user_id, 171));
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.user_id, 198));
  ref := split_part(NEW.agent_id, ':', 2);
  requested_generation := split_part(NEW.agent_id, ':', 3)::bigint;
  SELECT * INTO binding FROM public.consumer_mcp_connections
    WHERE connection_id = ref AND user_id = NEW.user_id FOR UPDATE;
  IF NOT FOUND OR binding.generation <> requested_generation THEN
    RAISE EXCEPTION 'consumer connection changed' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO prior FROM public.consent_audit
    WHERE user_id = NEW.user_id AND agent_id = NEW.agent_id AND scope = NEW.scope
      AND action IN (
        'CONSENT_GRANTED', 'CONSUMER_TOKEN_ISSUED', 'REVOKED', 'CONSENT_DENIED'
      )
    ORDER BY issued_at DESC, id DESC LIMIT 1;

  IF NEW.action = 'CONSENT_GRANTED' THEN
    IF prior.id IS NOT NULL OR NEW.expires_at IS NOT NULL THEN
      RAISE EXCEPTION 'consumer consent requires a new reviewed generation'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.action = 'CONSUMER_TOKEN_ISSUED' THEN
    IF prior.id IS NULL OR prior.action NOT IN ('CONSENT_GRANTED', 'CONSUMER_TOKEN_ISSUED')
       OR NEW.expires_at IS NULL OR NEW.expires_at <= NEW.issued_at
       OR NEW.token_id IS NULL OR NEW.token_id NOT LIKE 'HCT:%' THEN
      RAISE EXCEPTION 'consumer runtime credential requires standing consent'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    -- Standing grants do not expire. A token expiry worker cannot disconnect
    -- the assistant merely because one runtime credential expired.
    IF NEW.metadata::jsonb->>'reason' = 'expired' THEN
      RAISE EXCEPTION 'consumer standing consent does not expire' USING ERRCODE = '42501';
    END IF;
    UPDATE public.consumer_mcp_connections SET generation = generation + 1,
      authorization_floor_id = (SELECT last_value FROM public.developer_oauth_authorizations_id_seq)
      WHERE connection_id = ref;
    UPDATE public.developer_oauth_authorizations SET status = 'denied'
      WHERE consumer_connection_id = ref AND consumer_generation = requested_generation;
    UPDATE public.developer_oauth_tokens SET revoked_at =
      floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
      WHERE authorization_id IN (SELECT id FROM public.developer_oauth_authorizations
        WHERE consumer_connection_id = ref AND consumer_generation = requested_generation)
      AND revoked_at IS NULL;
  END IF;
  NEW.issued_at := greatest(NEW.issued_at, coalesce(prior.issued_at + 1, 0));
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.preserve_consumer_memory_consent()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.scope = 'cap.consumer.memory' OR
     (TG_OP = 'UPDATE' AND NEW.scope = 'cap.consumer.memory') THEN
    -- Full account erasure records this existing irreversible tombstone first.
    IF TG_OP = 'DELETE' AND EXISTS (
      SELECT 1 FROM public.account_deletion_tombstones
      WHERE user_id_hash = 'sha256:' || encode(sha256(convert_to(OLD.user_id, 'UTF8')), 'hex')
    ) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'consumer consent decisions are append only' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;
"""
LEGACY_TRIGGERS = r"""CREATE TRIGGER zz_consumer_memory_consent BEFORE INSERT ON consent_audit FOR EACH ROW EXECUTE FUNCTION guard_consumer_memory_consent();
CREATE TRIGGER zz_preserve_consumer_memory_consent BEFORE DELETE OR UPDATE ON consent_audit FOR EACH ROW EXECUTE FUNCTION preserve_consumer_memory_consent();"""


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
    trigger = LEGACY_TRIGGERS.split(";\n", 1)[0]
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


def reject_guard_drift(connection, entry):
    mutations = (
        (
            "CREATE TRIGGER zz_unreviewed_consumer_memory BEFORE INSERT ON public.consent_audit FOR EACH ROW EXECUTE FUNCTION public.guard_consumer_memory_consent()",
            "DROP TRIGGER zz_unreviewed_consumer_memory ON public.consent_audit",
        ),
        (
            "ALTER TABLE public.consent_audit DISABLE TRIGGER zz_consumer_memory_consent",
            "ALTER TABLE public.consent_audit ENABLE TRIGGER zz_consumer_memory_consent",
        ),
        (
            "DROP TRIGGER zz_preserve_consumer_memory_consent ON public.consent_audit",
            LEGACY_TRIGGERS.split(";\n", 1)[1],
        ),
        (
            "CREATE OR REPLACE FUNCTION public.guard_consumer_memory_consent() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$ BEGIN RETURN NEW; END; $$",
            LEGACY_FUNCTIONS,
        ),
        (
            "ALTER FUNCTION public.guard_consumer_memory_consent() SECURITY DEFINER",
            "ALTER FUNCTION public.guard_consumer_memory_consent() SECURITY INVOKER",
        ),
        (
            "CREATE FUNCTION public.guard_consumer_memory_consent(integer) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$",
            "DROP FUNCTION public.guard_consumer_memory_consent(integer)",
        ),
    )
    with connection.cursor() as cursor:
        for mutation, cleanup in mutations:
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
    assert asyncio.run(execute_mode(server, database, entry, MigrationMode.LEDGER)) == ()
    with connection.cursor() as cursor:
        cursor.execute("SELECT * FROM schema_migrations WHERE migration_id='420'")
        assert cursor.fetchone() == receipt
    assert guard_catalog(connection) == before


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
        install_legacy_guards(connection, triggers=False)
        assert_absent_guard_qualification_blocks_concurrent_install(connection, replay_pg, database)
        with connection.cursor() as cursor:
            cursor.execute(LEGACY_TRIGGERS)
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
