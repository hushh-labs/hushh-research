"""Bounded phases for the shared-Dev hosted custody readiness test."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from tests import hosted_pilot_readiness_cases as _readiness
from tests.helpers.private_agent_adoption import canonical_database, install_legacy_guards
from tests.hosted_custody_profile_support import dev_custody_environment
from tests.pkm_conformance import postgres_harness
from tests.pkm_conformance.postgres_harness import TempPostgres
from tests.test_byoc_setup_job_azure_admission_postgres import ROOT


class _ReadinessRepo:
    def __init__(self, connection):
        self.connection = connection

    async def files_upgrade_admission_ready(self, **_kwargs):
        return True

    def _db(self):
        return self

    def execute_raw(self, sql, _params):
        with self.connection.cursor() as cursor:
            cursor.execute(sql)


def _ready(ctx) -> bool:
    return asyncio.run(ctx.hosted_schema_ready(ctx.repo))


def _owner_execute(ctx, statement, params=None):
    with ctx.owner_connection.cursor() as cursor:
        cursor.execute(statement, params)
        return cursor.fetchall() if cursor.description is not None else []


def _prepare_source(ctx) -> None:
    import psycopg2

    import db.hosted_custody_qualification as custody_qualification
    from db.hosted_custody_adoption import _successor_qualification
    from hushh_mcp.services.pod_files.capability_contract import hosted_schema_ready

    ctx.custody_qualification = custody_qualification
    ctx.successor_qualification = _successor_qualification
    ctx.hosted_schema_ready = hosted_schema_ready
    _readiness._create_runtime_roles(ctx.pg)
    _readiness._apply_hosted_predecessor_migrations(ctx.pg, lambda: False)
    for migration in (
        "979_hosted_files_executor.sql",
        "980_personal_agent_upgrade_host_binding.sql",
        "981_hosted_native_location_contract.sql",
    ):
        ctx.pg.apply_file(ROOT / "db/migrations/parked" / migration)
    ctx.pg.execute(_successor_qualification())
    ctx.pg.execute("DROP OWNED BY service_role")
    ctx.pg.execute("DROP ROLE service_role")
    ctx.pg.execute("CREATE ROLE hushh_uat_app LOGIN SUPERUSER")
    from db.hosted_custody_adoption import qualified_hosted_custody_family

    for signature in qualified_hosted_custody_family():
        name, _, arguments = signature.partition("(")
        ctx.pg.execute(f'ALTER FUNCTION public."{name}"({arguments} OWNER TO hushh_uat_app')
    ctx.pg.execute("ALTER TABLE public.personal_agent_registry OWNER TO hushh_uat_app")
    ctx.pg.execute(
        "ALTER TABLE public.hosted_files_executor_976_rollback_source OWNER TO hushh_uat_app"
    )
    ctx.local_system_identifier_hash = ctx.pg.execute(
        "SELECT encode(sha256(convert_to(system_identifier::text,'UTF8')),'hex') "
        "FROM pg_control_system()"
    )[0][0]
    ctx.monkeypatch.setattr(
        custody_qualification,
        "DEV_CUSTODY_SYSTEM_IDENTIFIER_SHA256",
        ctx.local_system_identifier_hash,
    )
    for key, value in dev_custody_environment().items():
        ctx.monkeypatch.setenv(key, value)
    assert ctx.pg.execute("SELECT current_user,session_user")[0] == ("hushh", "hushh")
    with pytest.raises(psycopg2.errors.RaiseException, match="Dev database identity"):
        ctx.pg.execute(_successor_qualification())


def _open_source_owner(ctx) -> None:
    import psycopg2

    ctx.owner_connection = psycopg2.connect(
        host=ctx.pg.dir, port=ctx.pg.port, user="hushh_uat_app", dbname="postgres"
    )
    ctx.request.addfinalizer(ctx.owner_connection.close)
    ctx.owner_connection.autocommit = True
    ctx.repo = _ReadinessRepo(ctx.owner_connection)
    assert _ready(ctx)


def _prepare_target_server(ctx) -> None:
    import psycopg2

    empty_prelude = ctx.tmp_path / "empty-postgres-prelude.sql"
    empty_prelude.write_text("SELECT 1;\n", encoding="utf-8")
    ctx.monkeypatch.setattr(postgres_harness, "PRELUDE", empty_prelude)
    ctx.monkeypatch.setattr(postgres_harness, "MIGRATIONS", [])
    ctx.target_server = TempPostgres()
    ctx.target_server.start()
    ctx.request.addfinalizer(ctx.target_server.stop)
    canonical_connection, ctx.database = canonical_database(
        ctx.target_server, ctx.monkeypatch, database="postgres"
    )
    ctx.request.addfinalizer(canonical_connection.close)
    install_legacy_guards(canonical_connection)
    ctx.target_server.execute("CREATE ROLE hushh_uat_app LOGIN SUPERUSER")
    canonical_connection.close()
    ctx.target_connection = psycopg2.connect(
        host=ctx.target_server.dir,
        port=ctx.target_server.port,
        user="hushh_uat_app",
        dbname=ctx.database,
    )
    ctx.request.addfinalizer(ctx.target_connection.close)
    ctx.target_connection.autocommit = True


def _target_execute(ctx, statement, params=None):
    with ctx.target_connection.cursor() as cursor:
        cursor.execute(statement, params)
        return cursor.fetchall() if cursor.description is not None else []


def _copy_target_family(ctx) -> None:
    ctx.target_execute = lambda statement, params=None: _target_execute(ctx, statement, params)
    ctx.target_execute("SET check_function_bodies=off")
    ctx.target_execute("ALTER TABLE public.personal_agent_registry OWNER TO hushh_uat_app")
    _readiness._copy_custody_family(ctx.pg, ctx.target_connection, ctx.custody_family)
    _readiness._copy_rollback_marker_and_trigger(ctx.pg, ctx.target_connection, ctx.target_execute)
    ctx.target_execute("SET check_function_bodies=on")
    ctx.target_server.execute("DROP OWNED BY service_role; DROP ROLE service_role")
    identity = ctx.target_execute(
        "SELECT current_database(),current_user,session_user,"
        "(SELECT relowner::regrole::text FROM pg_class WHERE oid="
        "'public.personal_agent_registry'::regclass)"
    )[0]
    assert identity == ("postgres", "hushh_uat_app", "hushh_uat_app", "hushh_uat_app")
    assert not ctx.target_server.execute("SELECT 1 FROM pg_roles WHERE rolname='service_role'")


def _qualify_target_profile(ctx) -> None:
    from db.migration_authority import build_manifest_entries
    from db.private_agent_adoption import execution_sql

    ctx.entries = build_manifest_entries(
        ROOT / "db/migrations",
        ["420_private_agent_lifecycle_foundation.sql", "421_cloud_removal_recovery.sql"],
    )
    ctx.custody_family = _readiness._custody_family()
    ctx.target_system_identifier_hash = ctx.target_execute(
        "SELECT encode(sha256(convert_to(system_identifier::text,'UTF8')),'hex') "
        "FROM pg_control_system()"
    )[0][0]
    ctx.monkeypatch.setattr(
        ctx.custody_qualification,
        "DEV_CUSTODY_SYSTEM_IDENTIFIER_SHA256",
        ctx.target_system_identifier_hash,
    )
    for key, value in dev_custody_environment().items():
        ctx.monkeypatch.setenv(key, value)
    for entry in ctx.entries:
        sql = execution_sql(entry)
        assert "Dev database identity" in sql
        assert "owner-only function ACL" in sql
    ctx.initial_custody_catalog = _readiness._custody_family_catalog(
        ctx.target_connection, ctx.custody_family
    )
    assert {row[1] for row in ctx.initial_custody_catalog.values()} == {"hushh_uat_app"}
    ctx.target_execute(ctx.successor_qualification())


async def _replay_as(ctx, database_user, entries):
    import asyncpg

    connection = await asyncpg.connect(
        host=ctx.target_server.dir,
        port=ctx.target_server.port,
        user=database_user,
        database=ctx.database,
    )
    try:
        from db.migration_authority import MigrationMode, apply_manifest_entries

        return await apply_manifest_entries(
            connection,
            tuple(entries),
            mode=MigrationMode.REPLAY,
            deploy_sha="synthetic-dev-owner-profile-replay",
        )
    finally:
        await connection.close()


def _assert_replay_identity_and_acl_refusals(ctx) -> None:
    import asyncpg

    with pytest.raises(asyncpg.RaiseError, match="Dev database identity"):
        asyncio.run(_replay_as(ctx, "hushh", ctx.entries[:1]))
    ctx.target_server.execute("CREATE ROLE service_role NOLOGIN")
    with pytest.raises(asyncpg.RaiseError, match="Dev database identity"):
        asyncio.run(_replay_as(ctx, "hushh_uat_app", ctx.entries[:1]))
    ctx.target_server.execute("DROP ROLE service_role")


def _assert_replay_preserves_catalogs(ctx) -> None:
    custody_before = _readiness._custody_family_catalog(ctx.target_connection, ctx.custody_family)
    trigger_before = ctx.target_execute(
        "SELECT tgname,pg_get_triggerdef(oid,true) FROM pg_trigger "
        "WHERE tgrelid='public.personal_agent_registry'::regclass "
        "AND tgname IN ('zx_project_grant_registry','zz_personal_agent_erasure_registry',"
        "'zz_personal_agent_upgrade_lease_host_binding') ORDER BY tgname"
    )
    marker_before = ctx.target_execute(
        "SELECT signature,definition FROM public.hosted_files_executor_976_rollback_source "
        "ORDER BY signature"
    )
    assert asyncio.run(_replay_as(ctx, "hushh_uat_app", ctx.entries)) == tuple(
        entry.filename for entry in ctx.entries
    )
    assert _readiness._custody_family_catalog(ctx.target_connection, ctx.custody_family) == (
        custody_before
    )
    assert (
        ctx.target_execute(
            "SELECT tgname,pg_get_triggerdef(oid,true) FROM pg_trigger "
            "WHERE tgrelid='public.personal_agent_registry'::regclass "
            "AND tgname IN ('zx_project_grant_registry','zz_personal_agent_erasure_registry',"
            "'zz_personal_agent_upgrade_lease_host_binding') ORDER BY tgname"
        )
        == trigger_before
    )
    assert (
        ctx.target_execute(
            "SELECT signature,definition FROM public.hosted_files_executor_976_rollback_source "
            "ORDER BY signature"
        )
        == marker_before
    )
    ctx.target_execute(ctx.successor_qualification())


def _assert_system_and_role_readiness_fences(ctx) -> None:
    ctx.monkeypatch.setattr(
        ctx.custody_qualification, "DEV_CUSTODY_SYSTEM_IDENTIFIER_SHA256", "0" * 64
    )
    assert not _ready(ctx), "runtime readiness accepted a different PostgreSQL system identifier"
    ctx.monkeypatch.setattr(
        ctx.custody_qualification,
        "DEV_CUSTODY_SYSTEM_IDENTIFIER_SHA256",
        ctx.local_system_identifier_hash,
    )
    ctx.pg.execute("CREATE ROLE service_role NOLOGIN")
    assert not _ready(ctx), "runtime readiness accepted a present service_role"
    ctx.pg.execute("DROP ROLE service_role")
    assert _ready(ctx)


def _assert_base_acl_readiness_fences(ctx) -> None:
    signature = "public.begin_hosted_files_executor(text,jsonb,jsonb,timestamptz,timestamptz,jsonb,text,text,text,jsonb,text,text)"
    _owner_execute(ctx, "CREATE ROLE hosted_custody_unexpected NOLOGIN")
    _owner_execute(ctx, f"GRANT EXECUTE ON FUNCTION {signature} TO hosted_custody_unexpected")
    assert not _ready(ctx), "runtime readiness accepted an unexpected ACL grantee"
    _owner_execute(ctx, f"REVOKE EXECUTE ON FUNCTION {signature} FROM hosted_custody_unexpected")
    assert _ready(ctx)
    _owner_execute(
        ctx, f"GRANT EXECUTE ON FUNCTION {signature} TO hosted_custody_unexpected WITH GRANT OPTION"
    )
    assert not _ready(ctx), "runtime readiness accepted an ACL grant option"
    _owner_execute(
        ctx, f"REVOKE EXECUTE ON FUNCTION {signature} FROM hosted_custody_unexpected CASCADE"
    )
    assert _ready(ctx)


def _assert_nonowner_grantor_readiness_fence(ctx) -> None:
    signature = "public.personal_agent_upgrade_lease_host_binding(jsonb)"
    _owner_execute(ctx, "CREATE ROLE hosted_custody_grantor NOLOGIN")
    _owner_execute(
        ctx, f"GRANT EXECUTE ON FUNCTION {signature} TO hosted_custody_grantor WITH GRANT OPTION"
    )
    _owner_execute(ctx, "SET ROLE hosted_custody_grantor")
    _owner_execute(ctx, f"GRANT EXECUTE ON FUNCTION {signature} TO PUBLIC")
    _owner_execute(ctx, "RESET ROLE")
    assert _owner_execute(
        ctx,
        "SELECT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL "
        "aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a "
        "WHERE p.oid=to_regprocedure(%s) AND a.grantee=0 "
        "AND a.grantor=(SELECT oid FROM pg_roles WHERE rolname='hosted_custody_grantor'))",
        (signature,),
    )[0][0]
    assert not _ready(ctx), "runtime readiness accepted a non-owner ACL grantor"
    _owner_execute(
        ctx, f"REVOKE EXECUTE ON FUNCTION {signature} FROM hosted_custody_grantor CASCADE"
    )
    _owner_execute(ctx, "DROP ROLE hosted_custody_grantor")
    _owner_execute(ctx, "DROP ROLE hosted_custody_unexpected")
    assert _ready(ctx)


def _install_982_and_assert_dev_readiness(ctx) -> None:
    from db.hosted_custody_qualification import CUSTODY_PROFILE_ENV

    ctx.pg.execute("SET ROLE hushh_uat_app")
    try:
        ctx.pg.apply_file(ROOT / "db/migrations/parked/982_hosted_provider_account_transition.sql")
    finally:
        ctx.pg.execute("RESET ROLE")
    assert _ready(ctx), "Dev runtime readiness rejected a complete 982 family"
    ctx.monkeypatch.setenv(CUSTODY_PROFILE_ENV, "strict")
    assert not _ready(ctx), "strict runtime readiness accepted the Dev-only 982 family"
    for key, value in dev_custody_environment().items():
        ctx.monkeypatch.setenv(key, value)
    assert _ready(ctx), "Dev runtime readiness rejected the restored 982 family"


def _assert_982_transition_controls(ctx) -> None:
    signature = "public.valid_hosted_provider_account_transition_settlement(jsonb,jsonb)"
    definition = _owner_execute(ctx, "SELECT pg_get_functiondef(%s::regprocedure)", (signature,))[
        0
    ][0]
    _owner_execute(
        ctx,
        "CREATE OR REPLACE FUNCTION public.valid_hosted_provider_account_transition_settlement("
        "p_intent jsonb,p_settlement jsonb) RETURNS boolean LANGUAGE plpgsql STABLE "
        "SET search_path=public AS $$ BEGIN RETURN true; END; $$",
    )
    assert not _ready(ctx), "Dev runtime readiness accepted a drifted 982 routine"
    _owner_execute(ctx, definition)
    assert _ready(ctx), "Dev runtime readiness rejected the restored 982 routine"
    _owner_execute(
        ctx,
        "ALTER FUNCTION public.valid_hosted_provider_account_transition_settlement(jsonb,jsonb) "
        "RENAME TO valid_hosted_provider_account_transition_settlement_missing",
    )
    assert not _ready(ctx), "Dev runtime readiness accepted a missing 982 routine"
    _owner_execute(
        ctx,
        "ALTER FUNCTION public.valid_hosted_provider_account_transition_settlement_missing(jsonb,jsonb) "
        "RENAME TO valid_hosted_provider_account_transition_settlement",
    )
    assert _ready(ctx), "Dev runtime readiness rejected the restored 982 routine"


def _assert_transition_trigger_state(ctx, trigger: str, label: str) -> None:
    _owner_execute(ctx, f"ALTER TABLE public.personal_agent_registry DISABLE TRIGGER {trigger}")
    assert not _ready(ctx), f"Dev runtime readiness accepted a disabled {label} trigger"
    _owner_execute(ctx, f"ALTER TABLE public.personal_agent_registry ENABLE TRIGGER {trigger}")
    assert _ready(ctx), f"Dev runtime readiness rejected the restored {label} trigger"


def _assert_clean_pre983_resolvers(ctx) -> None:
    _owner_execute(
        ctx,
        "CREATE FUNCTION public.hosted_provider_effective_billing_account(p_row text) "
        "RETURNS text LANGUAGE sql STABLE SET search_path=public AS $$ SELECT NULL::text $$",
    )
    assert not _ready(ctx), "Dev runtime readiness accepted an unqualified resolver overload"
    _owner_execute(ctx, "DROP FUNCTION public.hosted_provider_effective_billing_account(text)")
    assert _ready(ctx), (
        "Dev runtime readiness rejected the clean pre983 family after overload removal"
    )
    _owner_execute(ctx, "CREATE SCHEMA provider_resolution_probe")
    _owner_execute(
        ctx,
        "CREATE FUNCTION provider_resolution_probe.hosted_provider_effective_billing_account(p_row text) "
        "RETURNS text LANGUAGE sql STABLE SET search_path=public AS $$ SELECT NULL::text $$",
    )
    assert not _ready(ctx), "Dev runtime readiness accepted a resolver outside the public schema"
    _owner_execute(
        ctx,
        "DROP FUNCTION provider_resolution_probe.hosted_provider_effective_billing_account(text)",
    )
    _owner_execute(ctx, "DROP SCHEMA provider_resolution_probe")
    assert _ready(ctx), (
        "Dev runtime readiness rejected the clean pre983 family after schema cleanup"
    )


def _install_983_and_assert_readiness(ctx) -> None:
    _owner_execute(
        ctx,
        (ROOT / "db/migrations/parked/983_hosted_provider_account_resolution.sql").read_text(
            encoding="utf-8"
        ),
    )
    assert _ready(ctx), "Dev runtime readiness rejected the complete 983 family"


def _install_984_and_assert_readiness(ctx) -> None:
    _owner_execute(
        ctx,
        (ROOT / "db/migrations/parked/984_hosted_provider_account_dotted_actor.sql").read_text(
            encoding="utf-8"
        ),
    )
    assert _ready(ctx), "Dev runtime readiness rejected the complete 984 family"


def _assert_984_validator_closed_family(ctx) -> None:
    from db.hosted_custody_qualification import CUSTODY_PROFILE_ENV

    signature = "public.valid_hosted_provider_account_transition_intent(jsonb,jsonb)"
    definition = _owner_execute(ctx, "SELECT pg_get_functiondef(%s::regprocedure)", (signature,))[
        0
    ][0]
    _owner_execute(
        ctx,
        "CREATE OR REPLACE FUNCTION public.valid_hosted_provider_account_transition_intent("
        "p_row jsonb,p_intent jsonb) RETURNS boolean LANGUAGE plpgsql STABLE "
        "SET search_path=public AS $$ BEGIN RETURN true; END; $$",
    )
    assert not _ready(ctx), "runtime readiness accepted a drifted 984 intent validator"
    _owner_execute(ctx, definition)
    assert _ready(ctx), "runtime readiness rejected the restored 984 intent validator"
    _owner_execute(
        ctx,
        "ALTER FUNCTION public.valid_hosted_provider_account_transition_intent(jsonb,jsonb) "
        "RENAME TO valid_hosted_provider_account_transition_intent_missing",
    )
    assert not _ready(ctx), "runtime readiness accepted a missing 984 intent validator"
    _owner_execute(
        ctx,
        "ALTER FUNCTION public.valid_hosted_provider_account_transition_intent_missing(jsonb,jsonb) "
        "RENAME TO valid_hosted_provider_account_transition_intent",
    )
    assert _ready(ctx), "runtime readiness rejected the restored 984 intent validator"
    _owner_execute(
        ctx,
        f"GRANT EXECUTE ON FUNCTION {signature} TO anon",
    )
    assert not _ready(ctx), "runtime readiness accepted an ACL-open 984 intent validator"
    _owner_execute(ctx, f"REVOKE ALL ON FUNCTION {signature} FROM anon")
    assert _ready(ctx), "runtime readiness rejected the restored 984 intent ACL"
    ctx.monkeypatch.setenv(CUSTODY_PROFILE_ENV, "strict")
    assert not _ready(ctx), "strict runtime readiness accepted the Dev-only 984 successor"
    for key, value in dev_custody_environment().items():
        ctx.monkeypatch.setenv(key, value)
    assert _ready(ctx), "Dev runtime readiness rejected the restored 984 family"


def _rollback_984_without_evidence(ctx) -> None:
    _owner_execute(
        ctx,
        (
            ROOT / "db/migrations/rollback/984_hosted_provider_account_dotted_actor.rollback.sql"
        ).read_text(encoding="utf-8"),
    )
    assert _ready(ctx), "Dev runtime readiness rejected the restored 983 family"


def _assert_resolver_closed_family(ctx) -> None:
    signature = "public.hosted_provider_effective_billing_account(jsonb)"
    definition = _owner_execute(ctx, "SELECT pg_get_functiondef(%s::regprocedure)", (signature,))[
        0
    ][0]
    _owner_execute(
        ctx,
        "CREATE OR REPLACE FUNCTION public.hosted_provider_effective_billing_account(p_row jsonb) "
        "RETURNS text LANGUAGE sql STABLE SET search_path=public AS $$ SELECT NULL::text $$",
    )
    assert not _ready(ctx), "runtime readiness accepted a drifted provider-account resolver"
    _owner_execute(ctx, definition)
    assert _ready(ctx), "runtime readiness rejected the restored provider-account resolver"
    _owner_execute(
        ctx,
        "ALTER FUNCTION public.hosted_provider_effective_billing_account(jsonb) "
        "RENAME TO hosted_provider_effective_billing_account_missing",
    )
    assert not _ready(ctx), "runtime readiness accepted a missing provider-account resolver"
    _owner_execute(
        ctx,
        "ALTER FUNCTION public.hosted_provider_effective_billing_account_missing(jsonb) "
        "RENAME TO hosted_provider_effective_billing_account",
    )
    assert _ready(ctx), "runtime readiness rejected the restored provider-account resolver"


def _assert_resolver_acl_and_rollback(ctx) -> None:
    _owner_execute(
        ctx,
        "GRANT EXECUTE ON FUNCTION public.hosted_provider_effective_billing_account(jsonb) TO anon",
    )
    assert not _ready(ctx), "runtime readiness accepted an ACL-open provider-account resolver"
    _owner_execute(
        ctx,
        "REVOKE ALL ON FUNCTION public.hosted_provider_effective_billing_account(jsonb) FROM anon",
    )
    assert _ready(ctx), "runtime readiness rejected the restored owner-only resolver ACL"
    _owner_execute(
        ctx,
        (
            ROOT / "db/migrations/rollback/983_hosted_provider_account_resolution.rollback.sql"
        ).read_text(encoding="utf-8"),
    )
    assert _ready(ctx), "Dev runtime readiness rejected the restored 982 pre983 family"


def _rollback_982_without_evidence(ctx) -> None:
    ctx.pg.execute("SET ROLE hushh_uat_app")
    try:
        ctx.pg.apply_file(
            ROOT / "db/migrations/rollback/982_hosted_provider_account_transition.rollback.sql"
        )
    finally:
        ctx.pg.execute("RESET ROLE")
    assert _ready(ctx), "Dev runtime readiness rejected the restored pre982 family"


def run_dev_owner_only_readiness_scenario(pg, monkeypatch, request, tmp_path) -> None:
    ctx = SimpleNamespace(pg=pg, monkeypatch=monkeypatch, request=request, tmp_path=tmp_path)
    _prepare_source(ctx)
    _open_source_owner(ctx)
    _prepare_target_server(ctx)
    ctx.custody_family = _readiness._custody_family()
    _copy_target_family(ctx)
    _qualify_target_profile(ctx)
    _assert_replay_identity_and_acl_refusals(ctx)
    _assert_replay_preserves_catalogs(ctx)
    _assert_system_and_role_readiness_fences(ctx)
    _assert_base_acl_readiness_fences(ctx)
    _assert_nonowner_grantor_readiness_fence(ctx)
    _install_982_and_assert_dev_readiness(ctx)
    _assert_982_transition_controls(ctx)
    _assert_transition_trigger_state(ctx, "zx_hosted_provider_account_transition_registry", "982")
    _assert_clean_pre983_resolvers(ctx)
    _install_983_and_assert_readiness(ctx)
    _install_984_and_assert_readiness(ctx)
    _assert_984_validator_closed_family(ctx)
    _rollback_984_without_evidence(ctx)
    _assert_resolver_closed_family(ctx)
    _assert_transition_trigger_state(
        ctx, "zx_hosted_provider_account_transition_registry", "provider-transition"
    )
    _assert_resolver_acl_and_rollback(ctx)
    _rollback_982_without_evidence(ctx)
