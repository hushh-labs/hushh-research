"""PostgreSQL checks for the installed hosted Files custody family."""

from __future__ import annotations

import asyncio
from contextlib import closing

import pytest

from db.hosted_custody_acl import QUALIFIED_FAMILY_SETTING
from db.hosted_custody_adoption import (
    HOSTED_FILES_QUALIFIED,
    HOSTED_NATIVE_LOCATION_CONTRACT_QUALIFIED,
    PERSONAL_AGENT_UPGRADE_HOST_BINDING_QUALIFIED,
    QUALIFIED,
    _successor_qualification,
)
from db.migration_authority import MigrationMode, build_manifest_entries
from db.private_agent_adoption import execution_sql
from db.private_agent_adoption_successors import _WORKER_EVENT_SUCCESSOR_SHA256
from tests.helpers.private_agent_adoption import (
    canonical_database,
    execute_mode,
    install_legacy_guards,
)
from tests.test_byoc_setup_job_azure_admission_postgres import ROOT, _Client, _server


def _pg_sql():
    pytest.importorskip("psycopg2")
    from psycopg2 import sql

    return sql


@pytest.fixture
def pg(monkeypatch):
    """Use the provision journal's exact 954 predecessor for custody replay."""
    server = _server(monkeypatch, last=954)
    try:
        server.apply_file(ROOT / "db/migrations/parked/973_hosted_pod_pilot_admission.sql")
        yield server
    finally:
        server.stop()


def _create_runtime_roles(pg):
    for role_name in ("anon", "authenticated", "service_role"):
        if not pg.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", (role_name,)):
            pg.execute(f"CREATE ROLE {role_name} NOLOGIN")


def _custody_family():
    return {
        **QUALIFIED,
        **HOSTED_FILES_QUALIFIED,
        **PERSONAL_AGENT_UPGRADE_HOST_BINDING_QUALIFIED,
        **HOSTED_NATIVE_LOCATION_CONTRACT_QUALIFIED,
    }


def _custody_family_catalog(connection, family):
    observed = {}
    for signature in family:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex'),"
                "p.proowner::regrole::text,p.proacl::text,p.prosecdef,p.proconfig "
                "FROM pg_proc p WHERE p.oid=to_regprocedure(%s)",
                ("public." + signature,),
            )
            rows = cursor.fetchall()
        assert len(rows) == 1, signature
        observed[signature] = rows[0]
    return observed


def _install_function(target, signature, definition, owner):
    pg_sql = _pg_sql()
    name, _, arguments = signature.partition("(")
    function = pg_sql.SQL("public.{}({})").format(
        pg_sql.Identifier(name), pg_sql.SQL(arguments[:-1])
    )
    with target.cursor() as cursor:
        cursor.execute(definition)
        cursor.execute(
            pg_sql.SQL("ALTER FUNCTION {} OWNER TO {}").format(function, pg_sql.Identifier(owner))
        )
    return function


def _source_function_acl(source, signature):
    return source.execute(
        "SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' "
        "ELSE a.grantee::regrole::text END,a.privilege_type,a.is_grantable "
        "FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,"
        "acldefault('f',p.proowner))) a WHERE p.oid=to_regprocedure(%s) "
        "ORDER BY 1,2,3",
        ("public." + signature,),
    )


def _target_function_grantees(target, signature):
    with target.cursor() as cursor:
        cursor.execute(
            "SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' "
            "ELSE a.grantee::regrole::text END "
            "FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,"
            "acldefault('f',p.proowner))) a WHERE p.oid=to_regprocedure(%s)",
            ("public." + signature,),
        )
        return cursor.fetchall()


def _copy_function_acl(target, function, source_acl, signature):
    pg_sql = _pg_sql()
    for (grantee,) in _target_function_grantees(target, signature):
        role = pg_sql.SQL("PUBLIC") if grantee == "PUBLIC" else pg_sql.Identifier(grantee)
        with target.cursor() as cursor:
            cursor.execute(pg_sql.SQL("REVOKE ALL ON FUNCTION {} FROM {}").format(function, role))
    for grantee, privilege, grantable in source_acl:
        role = pg_sql.SQL("PUBLIC") if grantee == "PUBLIC" else pg_sql.Identifier(grantee)
        grant_option = pg_sql.SQL(" WITH GRANT OPTION") if grantable else pg_sql.SQL("")
        with target.cursor() as cursor:
            cursor.execute(
                pg_sql.SQL("GRANT {} ON FUNCTION {} TO {}{}").format(
                    pg_sql.SQL(privilege), function, role, grant_option
                )
            )


def _copy_custody_family(source, target, family):
    for signature in family:
        rows = source.execute(
            "SELECT pg_get_functiondef(p.oid),p.proowner::regrole::text "
            "FROM pg_proc p WHERE p.oid=to_regprocedure(%s)",
            ("public." + signature,),
        )
        assert len(rows) == 1, signature
        definition, owner = rows[0]
        function = _install_function(target, signature, definition, owner)
        _copy_function_acl(target, function, _source_function_acl(source, signature), signature)


def _copy_rollback_marker_and_trigger(source, target, target_execute):
    marker_rows = source.execute(
        "SELECT signature,definition FROM public.hosted_files_executor_976_rollback_source "
        "ORDER BY signature"
    )
    trigger_rows = source.execute(
        "SELECT pg_get_triggerdef(t.oid,true) FROM pg_trigger t "
        "WHERE t.tgrelid='public.personal_agent_registry'::regclass "
        "AND t.tgname='zz_personal_agent_upgrade_lease_host_binding'"
    )
    registry_trigger_rows = source.execute(
        "SELECT pg_get_triggerdef(t.oid,true) FROM pg_trigger t "
        "WHERE t.tgrelid='public.personal_agent_registry'::regclass "
        "AND t.tgname IN ('zx_project_grant_registry','zz_personal_agent_erasure_registry') "
        "ORDER BY t.tgname"
    )
    assert len(marker_rows) == 5
    assert len(trigger_rows) == 1
    assert len(registry_trigger_rows) == 2
    target_execute(
        "CREATE TABLE public.hosted_files_executor_976_rollback_source ("
        "signature text PRIMARY KEY, definition text NOT NULL)"
    )
    target_execute(
        "REVOKE ALL ON public.hosted_files_executor_976_rollback_source "
        "FROM PUBLIC,anon,authenticated,service_role"
    )
    with target.cursor() as cursor:
        cursor.executemany(
            "INSERT INTO public.hosted_files_executor_976_rollback_source "
            "(signature,definition) VALUES (%s,%s)",
            marker_rows,
        )
        for (definition,) in registry_trigger_rows:
            cursor.execute(definition)
        cursor.execute(trigger_rows[0][0])


def _target_execute(target, statement, params=None):
    with target.cursor() as cursor:
        cursor.execute(statement, params)
        return cursor.fetchall() if cursor.description is not None else []


class _ExistingRoleServer:
    def __init__(self, pg):
        self.dir = pg.dir
        self.port = pg.port
        self._pg = pg

    def execute(self, statement, params=None):
        if statement.startswith("CREATE ROLE service_role"):
            return []
        return self._pg.execute(statement, params)


def _assert_adoption_preserves_family(pg, family, monkeypatch):
    target, database = canonical_database(_ExistingRoleServer(pg), monkeypatch)
    with closing(target):
        install_legacy_guards(target)
        _target_execute(target, "SET check_function_bodies=off")
        _copy_custody_family(pg, target, family)
        _target_execute(target, "SET check_function_bodies=on")
        _copy_rollback_marker_and_trigger(pg, target, _target_execute_wrapper(target))
        _target_execute(target, _successor_qualification())
        _replay_420_421(pg, target, database, family)


def _target_execute_wrapper(target):
    return lambda statement, params=None: _target_execute(target, statement, params)


def _replay_420_421(pg, target, database, family):
    psycopg2 = pytest.importorskip("psycopg2")
    before = _custody_family_catalog(target, family)
    entries = build_manifest_entries(
        ROOT / "db/migrations",
        ["420_private_agent_lifecycle_foundation.sql", "421_cloud_removal_recovery.sql"],
    )
    adapted_420 = execution_sql(entries[0])
    worker_event_check = "p.proname='valid_byoc_azure_worker_event'"
    worker_event_position = adapted_420.index(worker_event_check)
    guard_start = adapted_420.rfind("DO $object_guard$", 0, worker_event_position)
    guard_end = adapted_420.index("$object_guard$;", worker_event_position) + len("$object_guard$;")
    worker_event_guard = adapted_420[guard_start:guard_end]
    worker_signature = "valid_byoc_azure_worker_event(text,text,jsonb,jsonb,text,text)"
    dev_hash = PERSONAL_AGENT_UPGRADE_HOST_BINDING_QUALIFIED[worker_signature]
    successor_hash = _WORKER_EVENT_SUCCESSOR_SHA256
    assert dev_hash == "95233dcf09e1b7a056cf3d846beb562e157ebf5be907ba33592e96cd45654cb4"
    installed_hash = before[worker_signature][0]
    assert installed_hash in {dev_hash, successor_hash}
    assert f"'{successor_hash}'" in worker_event_guard
    assert f"current_setting('{QUALIFIED_FAMILY_SETTING}',true)='true'" in worker_event_guard

    # The accepted Dev lineage has the historical 95233 body and passes the
    # immutable 420 guard directly. The 961 lineage has the measured 460ee
    # body and requires the complete-family qualification established above.
    _target_execute(target, "SELECT set_config(%s,'false',false)", (QUALIFIED_FAMILY_SETTING,))
    if installed_hash == dev_hash:
        _target_execute(target, worker_event_guard)
    else:
        with pytest.raises(
            psycopg2.errors.RaiseException,
            match="Unqualified schema drift: valid_byoc_azure_worker_event",
        ):
            _target_execute(target, worker_event_guard)
        _target_execute(target, "SELECT set_config(%s,'true',false)", (QUALIFIED_FAMILY_SETTING,))
        _target_execute(target, worker_event_guard)

    # Exercise the gated successor branch with a deterministic test body. The
    # production 460ee pin remains exact in the immutable adapter; substituting
    # this measured body here tests that only the complete-family GUC admits it.
    test_body = """CREATE OR REPLACE FUNCTION public.valid_byoc_azure_worker_event(
      owner_id text, expected_job text, event jsonb, history jsonb, target text, hushh_id text
    ) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
    BEGIN RETURN true; END; $$"""
    _target_execute(target, test_body)
    test_hash = _target_execute(
        target,
        "SELECT encode(sha256(convert_to(pg_get_functiondef('public.valid_byoc_azure_worker_event(text,text,jsonb,jsonb,text,text)'::regprocedure),'UTF8')),'hex')",
    )[0][0]
    gated_test_guard = worker_event_guard.replace(f"'{successor_hash}'", f"'{test_hash}'")
    assert gated_test_guard != worker_event_guard
    _target_execute(target, "SELECT set_config(%s,'false',false)", (QUALIFIED_FAMILY_SETTING,))
    with pytest.raises(
        psycopg2.errors.RaiseException,
        match="Unqualified schema drift: valid_byoc_azure_worker_event",
    ):
        _target_execute(target, gated_test_guard)
    _target_execute(target, "SELECT set_config(%s,'true',false)", (QUALIFIED_FAMILY_SETTING,))
    _target_execute(target, gated_test_guard)

    original_definition = pg.execute(
        "SELECT pg_get_functiondef(%s::regprocedure)", ("public." + worker_signature,)
    )[0][0]
    _target_execute(target, original_definition)
    assert asyncio.run(execute_mode(pg, database, entries[0], MigrationMode.REPLAY)) == (
        entries[0].filename,
    )
    assert asyncio.run(execute_mode(pg, database, entries[1], MigrationMode.REPLAY)) == (
        entries[1].filename,
    )
    _target_execute(target, _successor_qualification())
    assert _custody_family_catalog(target, family) == before


def _apply_hosted_predecessor_migrations(pg, ready):
    for number in (956, 957, 960, 961, 962, 963, 964, 972):
        pg.apply_file(next((ROOT / "db/migrations/parked").glob(f"{number}_*.sql")))
    pg.apply_file(ROOT / "db/migrations/parked/974_hosted_pod_custody.sql")
    pg.apply_file(ROOT / "db/migrations/parked/975_hosted_bucket_reconciliation.sql")
    pg.apply_file(ROOT / "db/migrations/parked/976_gcp_notification_account_id_limit.sql")
    assert not ready()


def _apply_hosted_successor_migrations(pg, ready):
    for migration in (
        "979_hosted_files_executor.sql",
        "980_personal_agent_upgrade_host_binding.sql",
        "981_hosted_native_location_contract.sql",
    ):
        pg.apply_file(ROOT / "db/migrations/parked" / migration)
        if migration != "981_hosted_native_location_contract.sql":
            assert not ready()
    pg.execute(_successor_qualification())
    assert ready()


def _assert_executor_privileges(pg):
    for signature in (
        "public.begin_hosted_files_executor(text,jsonb,jsonb,timestamptz,timestamptz,jsonb,text,text,text,jsonb,text,text)",
        "public.resume_hosted_files_executor(text,jsonb,jsonb,timestamptz,timestamptz,jsonb,text,jsonb,jsonb,text,text,text)",
    ):
        assert pg.execute(
            "SELECT has_function_privilege('service_role',%s,'EXECUTE'), "
            "NOT has_function_privilege('anon',%s,'EXECUTE'), "
            "NOT has_function_privilege('authenticated',%s,'EXECUTE')",
            (signature, signature, signature),
        )[0] == (True, True, True)


def _trigger_definition(pg, name):
    rows = pg.execute(
        "SELECT pg_get_triggerdef(t.oid,true) FROM pg_trigger t "
        "WHERE t.tgrelid='public.personal_agent_registry'::regclass AND t.tgname=%s",
        (name,),
    )
    assert len(rows) == 1, name
    return rows[0][0]


def _replace_registry_trigger_and_check(pg, ready, name, replacement):
    original = _trigger_definition(pg, name)
    pg.execute(f"DROP TRIGGER {name} ON public.personal_agent_registry")
    pg.execute(replacement)
    assert not ready(), f"runtime readiness accepted drifted trigger {name}"
    pg.execute(f"DROP TRIGGER {name} ON public.personal_agent_registry")
    pg.execute(original)
    assert ready(), f"runtime readiness rejected restored trigger {name}"


def _assert_runtime_family_drift_is_rejected(pg, ready):
    marker = "public.hosted_files_executor_976_rollback_source"
    marker_owner = pg.execute(
        "SELECT relowner::regrole::text FROM pg_class "
        "WHERE oid='public.personal_agent_registry'::regclass"
    )[0][0]
    assert ready()

    pg.execute(f"ALTER TABLE {marker} OWNER TO service_role")
    assert not ready(), "runtime readiness accepted a marker owned by service_role"
    owner_identifier = '"' + marker_owner.replace('"', '""') + '"'
    pg.execute(f"ALTER TABLE {marker} OWNER TO {owner_identifier}")
    assert ready()

    for trigger_name in (
        "zz_personal_agent_upgrade_lease_host_binding",
        "zx_project_grant_registry",
        "zz_personal_agent_erasure_registry",
    ):
        pg.execute(
            f"ALTER TABLE public.personal_agent_registry ENABLE ALWAYS TRIGGER {trigger_name}"
        )
        assert ready(), f"runtime readiness rejected always-enabled trigger {trigger_name}"
        pg.execute(f"ALTER TABLE public.personal_agent_registry ENABLE TRIGGER {trigger_name}")
        assert ready()

    pg.execute(
        "ALTER TABLE public.personal_agent_registry DISABLE TRIGGER zx_project_grant_registry"
    )
    assert not ready(), "runtime readiness accepted a disabled project-grant trigger"
    pg.execute(
        "ALTER TABLE public.personal_agent_registry ENABLE TRIGGER zx_project_grant_registry"
    )
    assert ready()

    _replace_registry_trigger_and_check(
        pg,
        ready,
        "zx_project_grant_registry",
        "CREATE TRIGGER zx_project_grant_registry AFTER INSERT ON public.personal_agent_registry "
        "FOR EACH ROW EXECUTE FUNCTION public.guard_project_grant_registry_admission()",
    )
    _replace_registry_trigger_and_check(
        pg,
        ready,
        "zz_personal_agent_erasure_registry",
        "CREATE TRIGGER zz_personal_agent_erasure_registry BEFORE UPDATE OR DELETE "
        "ON public.personal_agent_registry FOR EACH ROW "
        "EXECUTE FUNCTION public.guard_project_grant_registry_admission()",
    )

    pg.execute(f"ALTER TABLE {marker} RENAME TO hosted_files_executor_976_rollback_source_absent")
    assert not ready(), "runtime readiness accepted an absent rollback marker"
    pg.execute(
        "ALTER TABLE public.hosted_files_executor_976_rollback_source_absent "
        "RENAME TO hosted_files_executor_976_rollback_source"
    )
    assert ready()


def run_readiness_case(pg, monkeypatch):
    """Exercise readiness, rollback/reapply, and historical adoption in real PostgreSQL."""
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
    from hushh_mcp.services.pod_files.capability_contract import hosted_schema_ready

    _create_runtime_roles(pg)
    repo = PersonalAgentRegistryRepo(_Client(pg))

    def ready():
        return asyncio.run(hosted_schema_ready(repo))

    _apply_hosted_predecessor_migrations(pg, ready)
    from tests.private_agent_release_postgres_support import verify_managed_custody_roundtrip

    # Keep the immutable 974 rollback/reapply rehearsal on the historical family.
    verify_managed_custody_roundtrip(pg._conn, ROOT)
    _apply_hosted_successor_migrations(pg, ready)
    family = _custody_family()
    _assert_executor_privileges(pg)
    _assert_runtime_family_drift_is_rejected(pg, ready)
    for migration in (
        "981_hosted_native_location_contract.rollback.sql",
        "980_personal_agent_upgrade_host_binding.rollback.sql",
        "979_hosted_files_executor.rollback.sql",
    ):
        pg.apply_file(ROOT / "db/migrations/rollback" / migration)
        assert not ready()
    _apply_hosted_successor_migrations(pg, ready)
    _assert_adoption_preserves_family(pg, family, monkeypatch)
