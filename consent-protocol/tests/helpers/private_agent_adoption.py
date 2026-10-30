"""Reviewed schema-only adoption fixtures; no owner rows or runtime authority."""

import asyncio
import hashlib
from pathlib import Path

import asyncpg
import psycopg2

from db import migrate
from db.hosted_custody_adoption import QUALIFIED
from db.migration_authority import MigrationMode, apply_manifest_entries, manifest_checksum

_ROOT = Path(__file__).resolve().parents[2]

RECEIPT_PREDECESSORS = (
    (
        "904_consent_audit_receipts.sql",
        "3dd91a54968b624471548ec97e90d18f254a86ced3b9d459501fc2fccc79fdaf",
    ),
)

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

# Authored906/907 registry definitions; actual904 supplies the pre-ledger receipt schema.
LEGACY_PREDECESSOR_SCHEMA = """
ALTER TABLE public.personal_agent_registry
 DROP CONSTRAINT IF EXISTS personal_agent_registry_deployment_target_check,
 DROP CONSTRAINT IF EXISTS personal_agent_registry_model_credential_mode_check,
 DROP CONSTRAINT IF EXISTS personal_agent_registry_status_check,
 ADD CONSTRAINT personal_agent_registry_deployment_target_check
  CHECK(deployment_target IS NULL OR deployment_target IN ('gcp','user_gcp','anypoint','null')),
 ADD CONSTRAINT personal_agent_registry_model_credential_mode_check
  CHECK(model_credential_mode IS NULL OR model_credential_mode IN ('user_adc','byok_per_turn','fleet_adc')),
 ADD CONSTRAINT personal_agent_registry_status_check
  CHECK(status IN ('unprovisioned','pending','provisioning','connecting','provisioned','provisioning_failed','reaped'));
"""
LEGACY_PREDECESSOR_DRIFT = (
    (
        "ALTER TABLE public.consent_audit_receipts ADD COLUMN ledger text",
        "column",
    ),
    (
        "ALTER TABLE public.personal_agent_registry DROP CONSTRAINT IF EXISTS personal_agent_registry_status_check; ALTER TABLE public.personal_agent_registry ADD CONSTRAINT personal_agent_registry_status_check CHECK(status IS NOT NULL) NOT VALID",
        "predecessor",
    ),
    (
        "ALTER TABLE public.consent_audit_receipts DROP CONSTRAINT consent_audit_receipts_subject_id_hash_key; ALTER TABLE public.consent_audit_receipts ADD CONSTRAINT consent_audit_receipts_subject_id_hash_key UNIQUE(hash,subject_id)",
        "receipt",
    ),
    (
        "ALTER TABLE public.consent_audit_receipts DROP CONSTRAINT consent_audit_receipts_subject_id_seq_key",
        "receipt",
    ),
    (
        "DROP INDEX public.idx_consent_audit_receipts_subject; CREATE INDEX idx_consent_audit_receipts_subject ON public.consent_audit_receipts(subject_id,seq)",
        "receipt",
    ),
    (
        "DROP INDEX public.idx_consent_audit_receipts_subject",
        "receipt",
    ),
    (
        "INSERT INTO public.personal_agent_registry(user_id,hushh_id,deployment_target) VALUES('synthetic-anypoint','synthetic-anypoint','anypoint')",
        "anypoint",
    ),
)


LEGACY_GUARD_MUTATIONS = (
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
        "DROP TRIGGER zz_consumer_memory_consent ON public.consent_audit; DROP TRIGGER zz_preserve_consumer_memory_consent ON public.consent_audit",
        LEGACY_TRIGGERS,
    ),
    (
        "DROP TRIGGER zz_consumer_memory_consent ON public.consent_audit; CREATE TRIGGER zz_consumer_memory_consent AFTER INSERT ON public.consent_audit FOR EACH ROW EXECUTE FUNCTION public.guard_consumer_memory_consent()",
        "DROP TRIGGER zz_consumer_memory_consent ON public.consent_audit; "
        + LEGACY_TRIGGERS.split(";\n", 1)[0],
    ),
    (
        "DROP TRIGGER zz_consumer_memory_consent ON public.consent_audit; CREATE TRIGGER zz_consumer_memory_consent BEFORE INSERT ON public.consent_audit FOR EACH ROW EXECUTE FUNCTION public.guard_consumer_memory_consent('extra')",
        "DROP TRIGGER zz_consumer_memory_consent ON public.consent_audit; "
        + LEGACY_TRIGGERS.split(";\n", 1)[0],
    ),
    (
        "DROP TRIGGER zz_consumer_memory_consent ON public.consent_audit; CREATE TRIGGER zz_consumer_memory_consent BEFORE INSERT ON public.consent_audit FOR EACH ROW WHEN(NEW.scope IS NOT NULL) EXECUTE FUNCTION public.guard_consumer_memory_consent()",
        "DROP TRIGGER zz_consumer_memory_consent ON public.consent_audit; "
        + LEGACY_TRIGGERS.split(";\n", 1)[0],
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


# Catalog-only observations shared by the real PostgreSQL adoption rehearsals.
def guard_catalog(connection):
    with connection.cursor() as cursor:
        cursor.execute("""SELECT t.oid,t.tgname,t.tgenabled,t.tgfoid,
          pg_get_triggerdef(t.oid,true),pg_get_functiondef(p.oid),p.prosecdef,p.proconfig
          FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
          WHERE t.tgrelid='public.consent_audit'::regclass
          AND t.tgname LIKE 'zz_%consumer_memory%' ORDER BY t.tgname""")
        return cursor.fetchall()


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


def custody_catalog(connection):
    """Return bounded fingerprints and authority metadata, never function bodies."""
    with connection.cursor() as cursor:
        cursor.execute(
            """SELECT p.oid::regprocedure::text,p.oid,pg_get_functiondef(p.oid),
              p.proowner,p.proacl::text,p.prosecdef,p.proconfig FROM pg_proc p
              JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname=ANY(%s)""",
            ([s.partition("(")[0] for s in QUALIFIED],),
        )
        return {
            row[0].removeprefix("public."): (
                row[1],
                hashlib.sha256(row[2].encode()).hexdigest(),
                *row[3:],
            )
            for row in cursor.fetchall()
        }


def install_custody_fixture(connection):
    """Load only the reviewed catalog; omit pilot schema, policy and owner rows."""
    fixture = Path(__file__).resolve().parents[1] / "fixtures/managed_custody_successor.sql"
    with connection.cursor() as cursor:
        cursor.execute("SET check_function_bodies=off")
        try:
            cursor.execute(fixture.read_text())
        finally:
            cursor.execute("SET check_function_bodies=on")
        # pg_get_functiondef omits ACLs. Establish the already-restricted state
        # whose definitions, OIDs and authority must survive historical replay.
        for signature in QUALIFIED:
            cursor.execute(
                "REVOKE ALL ON FUNCTION public." + signature + " FROM PUBLIC,anon,authenticated"
            )
    observed = custody_catalog(connection)
    assert len(observed) == 60
    assert {s: row[1] if row else None for s, row in observed.items()} == QUALIFIED
    return observed


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
        cursor.execute((_ROOT / "db/legacy/init_legacy_schema.sql").read_text())

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


async def execute_mode(server, database, entry, mode, *, following=()):
    connection = await asyncpg.connect(
        host=server.dir, port=server.port, user="hushh", database=database
    )
    try:
        return await apply_manifest_entries(
            connection, (entry, *following), mode=mode, deploy_sha="synthetic-adoption-head"
        )
    finally:
        await connection.close()


def assert_pending_ledger_receipt(server, database, connection, entry):
    with connection.cursor() as cursor:
        cursor.execute((_ROOT / "db/foundations/schema_migrations_v2.sql").read_text())
        # Established operational baseline is a fixture prerequisite; baseline/backup authorization is separate.
        cursor.execute(
            """INSERT INTO schema_migrations(migration_id,filename,checksum_sha256,status,baseline_through)
          VALUES('baseline:419','synthetic-baseline-419',%s,'baseline',419)""",
            (manifest_checksum(()),),
        )
    before = guard_catalog(connection)
    assert asyncio.run(execute_mode(server, database, entry, MigrationMode.LEDGER)) == (
        entry.filename,
    )
    with connection.cursor() as cursor:
        cursor.execute("SELECT * FROM schema_migrations WHERE migration_id='420'")
        receipt = cursor.fetchone()
        assert receipt[1:4] == (entry.filename, entry.checksum_sha256, "applied")
        assert receipt[6] == "synthetic-adoption-head" and receipt[7] is None
    normalized = authorization_state(connection)
    assert asyncio.run(execute_mode(server, database, entry, MigrationMode.LEDGER)) == ()
    with connection.cursor() as cursor:
        cursor.execute("SELECT * FROM schema_migrations WHERE migration_id='420'")
        assert cursor.fetchone() == receipt
    assert guard_catalog(connection) == before
    assert authorization_state(connection) == normalized
