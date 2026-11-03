"""Cleanup, archive, and closed-family phases for the transition journal test."""

import json
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy

import pytest


def _define_cleanup_reservation(ctx):
    def cleanup_reservation(source_row, *, prefix=False, unresolved=False):
        snapshot = deepcopy(source_row)
        snapshot["status"] = "suspended"
        metadata = snapshot["backend_metadata"]
        metadata.pop("erasure", None)
        metadata.pop("serviceUid", None)
        metadata.pop("runtime_service_account", None)
        attempt = metadata["provisionAttempt"]
        attempt["phase"] = "reserved"
        attempt["evidence"].pop("host_requested", None)
        attempt["evidence"].pop("host_acknowledged", None)
        attempt["evidence"].pop("connecting", None)
        attempt["evidence"].pop("provisioned", None)
        reserved = attempt["evidence"]["reserved"]
        attempt.pop("providerAccountTransition", None)
        if prefix:
            reserved.pop("hostedCheckpoint", None)
            reserved["hostedPreparation"]["completed"] = reserved["hostedPreparation"]["completed"][
                :3
            ]
        else:
            reserved.pop("hostedCheckpoint", None)
            reserved.pop("projectAuthorization", None)
            preparation = reserved["hostedPreparation"]
            preparation["completed"] = preparation["completed"][:1]
        if unresolved:
            attempt["providerAccountTransition"] = {"version": 1, "phase": "unknown"}
        return {
            "ownerId": "owner-a",
            "attemptId": ctx.item_a["attemptId"],
            "hushhId": source_row["hushh_id"],
            "registrySnapshot": snapshot,
        }

    ctx.cleanup_reservation = cleanup_reservation


def _prepare_cleanup_candidates(ctx):
    ctx.prefix_clean = ctx.cleanup_reservation(ctx.settled_row, prefix=True)
    ctx.prep_clean = ctx.cleanup_reservation(ctx.settled_row)
    ctx.unresolved_prefix = ctx.cleanup_reservation(ctx.settled_row, prefix=True, unresolved=True)
    ctx.unresolved_prep = ctx.cleanup_reservation(ctx.settled_row, unresolved=True)
    ctx.retirement_unresolved = deepcopy(ctx.prefix_clean)
    ctx.retirement_unresolved["registrySnapshot"]["backend_metadata"]["provisionAttempt"][
        "providerAccountTransition"
    ] = {"version": 1, "phase": "unknown"}
    ctx.original_row = ctx.pg.execute(
        "SELECT status,backend_metadata FROM personal_agent_registry WHERE user_id='owner-a'"
    )[0]


def _assert_admitted_cleanup_records(ctx):
    for candidate in (ctx.prefix_clean, ctx.prep_clean):
        ctx.pg.execute(
            "UPDATE personal_agent_registry SET status='suspended',backend_metadata=jsonb_set(backend_metadata,'{erasure}',%s::jsonb,true) WHERE user_id='owner-a'",
            (json.dumps(candidate),),
        )
        if candidate is ctx.prefix_clean:
            assert ctx.pg.execute(
                "SELECT hosted_pod_cleanup_admitted('owner-a',%s,%s::jsonb)",
                (ctx.item_a["attemptId"], json.dumps(candidate)),
            )[0][0]
            assert ctx.pg.execute(
                "SELECT hosted_prefix_abort_admitted('owner-a',%s,%s::jsonb)",
                (ctx.item_a["attemptId"], json.dumps(candidate)),
            )[0][0]
        else:
            assert ctx.pg.execute(
                "SELECT hosted_preparation_cleanup_admitted('owner-a',%s,%s::jsonb)",
                (ctx.item_a["attemptId"], json.dumps(candidate)),
            )[0][0]
            ctx.coordinates = ctx.pg.execute(
                "SELECT managed_preparation_cleanup_coordinates(%s::jsonb)",
                (json.dumps(candidate),),
            )[0][0]
            ctx.wanted = {
                "ownerId": candidate["ownerId"],
                "attemptId": candidate["attemptId"],
                "project": ctx.coordinates["project"],
                "projectNumber": ctx.coordinates["projectNumber"],
                "operatorPrincipal": ctx.coordinates["operatorPrincipal"],
                "status": "admitted",
            }
            assert ctx.pg.execute(
                "SELECT valid_managed_preparation_cleanup(%s::jsonb,'admission',%s::jsonb)",
                (json.dumps(candidate), json.dumps(ctx.wanted)),
            )[0][0]


def _assert_unresolved_cleanup_refusals(ctx):
    for candidate, admission in (
        (ctx.unresolved_prefix, "hosted_pod_cleanup_admitted"),
        (ctx.unresolved_prefix, "hosted_prefix_abort_admitted"),
        (ctx.unresolved_prep, "hosted_preparation_cleanup_admitted"),
    ):
        ctx.pg.execute(
            "UPDATE personal_agent_registry SET status='suspended',backend_metadata=jsonb_set(backend_metadata,'{erasure}',%s::jsonb,true) WHERE user_id='owner-a'",
            (json.dumps(candidate),),
        )
        assert not ctx.pg.execute(
            f"SELECT public.{admission}('owner-a',%s,%s::jsonb)",
            (ctx.item_a["attemptId"], json.dumps(candidate)),
        )[0][0]
    ctx.unresolved_coordinates = ctx.pg.execute(
        "SELECT managed_preparation_cleanup_coordinates(%s::jsonb)",
        (json.dumps(ctx.unresolved_prep),),
    )[0][0]
    ctx.unresolved_prep_receipt = {
        "ownerId": ctx.unresolved_prep["ownerId"],
        "attemptId": ctx.unresolved_prep["attemptId"],
        "project": ctx.unresolved_coordinates["project"],
        "projectNumber": ctx.unresolved_coordinates["projectNumber"],
        "operatorPrincipal": ctx.unresolved_coordinates["operatorPrincipal"],
        "status": "admitted",
    }
    assert not ctx.pg.execute(
        "SELECT valid_managed_preparation_cleanup(%s::jsonb,'admission',%s::jsonb)",
        (json.dumps(ctx.unresolved_prep), json.dumps(ctx.unresolved_prep_receipt)),
    )[0][0]
    assert ctx.pg.execute(
        "SELECT erasure_private_coordinates(%s::jsonb) IS NOT NULL",
        (json.dumps(ctx.retirement_unresolved),),
    )[0][0]
    assert not ctx.pg.execute(
        "SELECT valid_erasure_managed_project_retirement(%s::jsonb,'admission','{}'::jsonb)",
        (json.dumps(ctx.retirement_unresolved),),
    )[0][0]


def _exercise_cleanup_fences(ctx):
    ctx.pg.execute("ALTER TABLE personal_agent_registry DISABLE TRIGGER USER")
    try:
        _assert_admitted_cleanup_records(ctx)
        _assert_unresolved_cleanup_refusals(ctx)
    finally:
        ctx.pg.execute(
            "UPDATE personal_agent_registry SET status=%s,backend_metadata=%s::jsonb WHERE user_id='owner-a'",
            (ctx.original_row[0], json.dumps(ctx.original_row[1])),
        )
        ctx.pg.execute("ALTER TABLE personal_agent_registry ENABLE TRIGGER USER")


def _assert_removal_lock_and_archive_provenance(ctx):
    assert ctx.legacy_after_resume["phase"] == "unknown"
    assert ctx.legacy_after_resume["generation"] == 2
    ctx.lock_owner = ctx.psycopg2.connect(
        host=ctx.pg.dir, port=ctx.pg.port, user="hushh", dbname="postgres"
    )
    ctx.lock_owner.autocommit = False
    ctx.lock_cursor = ctx.lock_owner.cursor()
    ctx.lock_cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended('owner-b',171))")
    ctx.lock_cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended('owner-b',198))")
    try:
        with ThreadPoolExecutor(max_workers=1) as ctx.workers:
            ctx.future = ctx.workers.submit(
                ctx.pg.execute, "SELECT reserve_personal_agent_erasure('owner-b','blocked-removal')"
            )
            import time

            ctx.time = time
            time.sleep(0.1)
            assert not ctx.future.done()
            ctx.lock_owner.commit()
            with pytest.raises(
                ctx.psycopg2.errors.InsufficientPrivilege, match="provider account transition"
            ):
                ctx.future.result(timeout=10)
    finally:
        ctx.lock_owner.rollback()
        ctx.lock_cursor.close()
        ctx.lock_owner.close()
    with pytest.raises(
        ctx.psycopg2.errors.InsufficientPrivilege, match="provider account transition"
    ):
        ctx.pg.execute(
            "UPDATE personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{provisionAttempt,attemptId}',to_jsonb('f'::text||repeat('0',31))) WHERE user_id='owner-b'"
        )
    ctx.current = ctx.pg.execute(
        "SELECT backend_metadata->'provisionAttempt'->'providerAccountTransition',(backend_metadata->'provisionAttempt'->'evidence'->'reserved'->'hostedPreparation'->'completed'->1)::text FROM personal_agent_registry WHERE user_id='owner-a'"
    )[0]
    ctx.erasure = ctx.pg.execute(
        "SELECT reserve_personal_agent_erasure('owner-a','settled-erasure')"
    )[0][0]
    ctx.archive = ctx.pg.execute(
        "SELECT personal_agent_erasure_archive(%s::jsonb,NULL)", (json.dumps(ctx.erasure),)
    )[0][0]
    assert ctx.archive["receipts"]["providerAccountTransition"] == ctx.current[0]
    assert ctx.current[1] == ctx.history_before[1]
    ctx.archive_transition_sha = ctx.pg.execute(
        "SELECT encode(sha256(convert_to(pg_get_functiondef('public.personal_agent_erasure_archive(jsonb,jsonb)'::regprocedure),'UTF8')),'hex')"
    )[0][0]
    assert (
        ctx.archive_transition_sha
        == "aef9e2ea2a5757e2601c3853c062625c56a2df889b29e6aac3d7d192367a466a"
    )
    with pytest.raises(ctx.psycopg2.errors.RaiseException, match="explicit Dev profile required"):
        ctx.pg.execute(ctx._successor_qualification())


def _prepare_dev_transition_family_profile(ctx):
    ctx.pg.execute("DROP OWNED BY service_role; DROP ROLE service_role")
    ctx.pg.execute("CREATE ROLE hushh_uat_app LOGIN SUPERUSER")
    import db.hosted_custody_qualification as custody_qualification

    ctx.custody_qualification = custody_qualification
    from db.hosted_custody_adoption import (
        HOSTED_FILES_QUALIFIED,
        HOSTED_PROVIDER_ACCOUNT_RESOLUTION_QUALIFIED,
        HOSTED_PROVIDER_ACCOUNT_TRANSITION_QUALIFIED,
        _successor_qualification,
        qualified_hosted_custody_family,
    )

    ctx.HOSTED_FILES_QUALIFIED = HOSTED_FILES_QUALIFIED
    ctx.HOSTED_PROVIDER_ACCOUNT_RESOLUTION_QUALIFIED = HOSTED_PROVIDER_ACCOUNT_RESOLUTION_QUALIFIED
    ctx.HOSTED_PROVIDER_ACCOUNT_TRANSITION_QUALIFIED = HOSTED_PROVIDER_ACCOUNT_TRANSITION_QUALIFIED
    ctx._successor_qualification = _successor_qualification
    ctx.qualified_hosted_custody_family = qualified_hosted_custody_family
    from db.hosted_custody_qualification import (
        DEV_CONTROL_PLANE_OWNER_PROFILE,
        DEV_CUSTODY_SYSTEM_IDENTIFIER_SHA256,
        HostedCustodyProfile,
        hosted_custody_profile_from_environment,
    )

    ctx.DEV_CONTROL_PLANE_OWNER_PROFILE = DEV_CONTROL_PLANE_OWNER_PROFILE
    ctx.DEV_CUSTODY_SYSTEM_IDENTIFIER_SHA256 = DEV_CUSTODY_SYSTEM_IDENTIFIER_SHA256
    ctx.HostedCustodyProfile = HostedCustodyProfile
    ctx.hosted_custody_profile_from_environment = hosted_custody_profile_from_environment
    from tests.helpers.private_agent_adoption import canonical_database, install_legacy_guards

    ctx.canonical_database = canonical_database
    ctx.install_legacy_guards = install_legacy_guards
    from tests.pkm_conformance import postgres_harness

    ctx.postgres_harness = postgres_harness
    from tests.pkm_conformance.postgres_harness import TempPostgres

    ctx.TempPostgres = TempPostgres
    from tests.hosted_custody_profile_support import (
        dev_custody_environment as _dev_custody_environment,
    )

    ctx._dev_custody_environment = _dev_custody_environment
    ctx.source_profile = HostedCustodyProfile(
        DEV_CONTROL_PLANE_OWNER_PROFILE, DEV_CUSTODY_SYSTEM_IDENTIFIER_SHA256
    )
    ctx.transition_family = qualified_hosted_custody_family(ctx.source_profile)
    assert not set(HOSTED_PROVIDER_ACCOUNT_TRANSITION_QUALIFIED).issubset(
        qualified_hosted_custody_family()
    )
    assert set(HOSTED_PROVIDER_ACCOUNT_TRANSITION_QUALIFIED).issubset(ctx.transition_family)
    assert (
        qualified_hosted_custody_family()["personal_agent_erasure_archive(jsonb,jsonb)"]
        == HOSTED_FILES_QUALIFIED["personal_agent_erasure_archive(jsonb,jsonb)"]
    )
    assert (
        ctx.transition_family["personal_agent_erasure_archive(jsonb,jsonb)"]
        == "aef9e2ea2a5757e2601c3853c062625c56a2df889b29e6aac3d7d192367a466a"
    )
    for signature in ctx.transition_family:
        ctx.name, ctx._, ctx.arguments = signature.partition("(")
        ctx.pg.execute(f'ALTER FUNCTION public."{ctx.name}"({ctx.arguments} OWNER TO hushh_uat_app')
    ctx.pg.execute("ALTER TABLE public.personal_agent_registry OWNER TO hushh_uat_app")
    ctx.pg.execute(
        "ALTER TABLE public.hosted_files_executor_976_rollback_source OWNER TO hushh_uat_app"
    )


def _prepare_dev_transition_replay(ctx):
    from db.hosted_custody_adoption import HOSTED_PROVIDER_ACCOUNT_RESOLUTION_QUALIFIED
    from db.migration_authority import build_manifest_entries

    ctx.build_manifest_entries = build_manifest_entries
    from db.private_agent_adoption import execution_sql

    ctx.execution_sql = execution_sql
    from tests.hosted_custody_profile_support import (
        later_owned_trigger_definitions as _later_owned_trigger_definitions,
    )
    from tests.hosted_custody_profile_support import (
        registry_trigger_catalog as _registry_trigger_catalog,
    )
    from tests.hosted_custody_profile_support import replay_420_421 as _replay_420_421
    from tests.hosted_pilot_readiness_cases import (
        _copy_custody_family,
        _copy_rollback_marker_and_trigger,
        _custody_family_catalog,
    )

    ctx._copy_custody_family = _copy_custody_family
    ctx._copy_rollback_marker_and_trigger = _copy_rollback_marker_and_trigger
    ctx._custody_family_catalog = _custody_family_catalog
    ctx._later_owned_trigger_definitions = _later_owned_trigger_definitions
    ctx._registry_trigger_catalog = _registry_trigger_catalog
    ctx._replay_420_421 = _replay_420_421
    ctx.replay_entries = build_manifest_entries(
        ctx.ROOT / "db/migrations",
        ["420_private_agent_lifecycle_foundation.sql", "421_cloud_removal_recovery.sql"],
    )
    ctx.adapted_420 = execution_sql(ctx.replay_entries[0])
    assert all(
        (
            digest in ctx.adapted_420
            for digest in HOSTED_PROVIDER_ACCOUNT_RESOLUTION_QUALIFIED.values()
        )
    )
    ctx.empty_prelude = ctx.tmp_path / "empty-postgres-prelude.sql"
    ctx.empty_prelude.write_text("SELECT 1;\n", encoding="utf-8")
    ctx.monkeypatch.setattr(ctx.postgres_harness, "PRELUDE", ctx.empty_prelude)
    ctx.monkeypatch.setattr(ctx.postgres_harness, "MIGRATIONS", [])


def _qualify_dev_transition_family(ctx):
    _prepare_dev_transition_family_profile(ctx)
    _prepare_dev_transition_replay(ctx)


def _start_replay_target(ctx):
    ctx.target_server = ctx.TempPostgres()
    ctx.target_server.start()
    ctx.owner_connection = None


def _prepare_replay_target_owner(ctx):
    ctx.canonical_connection, ctx.database = ctx.canonical_database(
        ctx.target_server, ctx.monkeypatch, database="postgres"
    )
    ctx.install_legacy_guards(ctx.canonical_connection)
    ctx.target_server.execute("CREATE ROLE hushh_uat_app LOGIN SUPERUSER")
    ctx.canonical_connection.close()
    ctx.owner_connection = ctx.psycopg2.connect(
        host=ctx.target_server.dir,
        port=ctx.target_server.port,
        user="hushh_uat_app",
        dbname=ctx.database,
    )
    ctx.owner_connection.autocommit = True

    def owner_execute(statement, params=None):
        with ctx.owner_connection.cursor() as cursor:
            cursor.execute(statement, params)
            return cursor.fetchall() if cursor.description is not None else []

    ctx.owner_execute = owner_execute
    ctx.owner_execute("SET check_function_bodies=off")
    ctx.owner_execute("ALTER TABLE public.personal_agent_registry OWNER TO hushh_uat_app")
    ctx._copy_custody_family(ctx.pg, ctx.owner_connection, ctx.transition_family)
    ctx._copy_rollback_marker_and_trigger(ctx.pg, ctx.owner_connection, ctx.owner_execute)
    ctx.owner_execute("SET check_function_bodies=on")
    ctx.target_server.execute("DROP OWNED BY service_role; DROP ROLE service_role")
    ctx.target_system_identifier_hash = ctx.owner_execute(
        "SELECT encode(sha256(convert_to(system_identifier::text,'UTF8')),'hex') FROM pg_control_system()"
    )[0][0]
    ctx.monkeypatch.setattr(
        ctx.custody_qualification,
        "DEV_CUSTODY_SYSTEM_IDENTIFIER_SHA256",
        ctx.target_system_identifier_hash,
    )
    for key, value in ctx._dev_custody_environment().items():
        ctx.monkeypatch.setenv(key, value)
    ctx.profile = ctx.hosted_custody_profile_from_environment()
    ctx.owner_execute(
        "ALTER TABLE public.hosted_files_executor_976_rollback_source OWNER TO hushh_uat_app"
    )
    ctx.owner_execute(ctx._successor_qualification(ctx.profile))


def _assert_replay_rejects_transition_drift(ctx):
    ctx.drift_signature = "valid_hosted_provider_account_transition_settlement(jsonb,jsonb)"
    ctx.source_definition = ctx.owner_execute(
        "SELECT pg_get_functiondef(%s::regprocedure)", ("public." + ctx.drift_signature,)
    )[0][0]
    ctx.owner_execute(
        "CREATE OR REPLACE FUNCTION public.valid_hosted_provider_account_transition_settlement(p_intent jsonb,p_settlement jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$ BEGIN RETURN true; END; $$"
    )
    with pytest.raises(ctx.psycopg2.errors.RaiseException, match="function definition or ACL"):
        ctx.owner_execute(ctx._successor_qualification(ctx.profile))
    ctx.owner_execute(ctx.source_definition)
    ctx.owner_execute(
        "ALTER FUNCTION public.valid_hosted_provider_account_transition_settlement(jsonb,jsonb) RENAME TO valid_hosted_provider_account_transition_settlement_missing"
    )
    with pytest.raises(ctx.psycopg2.errors.RaiseException, match="overload or missing function"):
        ctx.owner_execute(ctx._successor_qualification(ctx.profile))
    ctx.owner_execute(
        "ALTER FUNCTION public.valid_hosted_provider_account_transition_settlement_missing(jsonb,jsonb) RENAME TO valid_hosted_provider_account_transition_settlement"
    )
    ctx.owner_execute(
        "CREATE FUNCTION public.record_hosted_provider_account_transition_intent(integer) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public AS $$ SELECT true $$"
    )
    with pytest.raises(ctx.psycopg2.errors.RaiseException, match="overload or missing function"):
        ctx.owner_execute(ctx._successor_qualification(ctx.profile))
    ctx.owner_execute(
        "DROP FUNCTION public.record_hosted_provider_account_transition_intent(integer)"
    )
    ctx.acl_signature = "public.valid_hosted_provider_account_transition_intent(jsonb,jsonb)"
    ctx.owner_execute(f"GRANT EXECUTE ON FUNCTION {ctx.acl_signature} TO anon")
    with pytest.raises(ctx.psycopg2.errors.RaiseException, match="function definition or ACL"):
        ctx.owner_execute(ctx._successor_qualification(ctx.profile))
    ctx.owner_execute(f"REVOKE ALL ON FUNCTION {ctx.acl_signature} FROM anon")
    ctx.owner_execute(ctx._successor_qualification(ctx.profile))


def _replay_and_assert_catalog_preservation(ctx):
    ctx.transition_catalog_before = ctx._custody_family_catalog(
        ctx.owner_connection, ctx.transition_family
    )
    ctx.trigger_catalog_before = ctx._registry_trigger_catalog(ctx.owner_connection)
    ctx.later_trigger_definitions_before = ctx._later_owned_trigger_definitions(
        ctx.owner_connection
    )
    assert len(ctx.later_trigger_definitions_before) == 4
    ctx._replay_420_421(
        ctx.pg,
        ctx.owner_connection,
        ctx.database,
        ctx.transition_family,
        database_user="hushh_uat_app",
        replay_server=ctx.target_server,
    )
    assert (
        ctx._custody_family_catalog(ctx.owner_connection, ctx.transition_family)
        == ctx.transition_catalog_before
    )
    ctx.trigger_catalog_after = set(ctx._registry_trigger_catalog(ctx.owner_connection))
    assert set(ctx.trigger_catalog_before).issubset(ctx.trigger_catalog_after)
    ctx.later_trigger_definitions_after = ctx._later_owned_trigger_definitions(ctx.owner_connection)
    assert ctx.later_trigger_definitions_after == ctx.later_trigger_definitions_before
    assert len(ctx.later_trigger_definitions_after) == 4


def _stop_replay_target(ctx):
    if ctx.owner_connection is not None:
        ctx.owner_connection.close()
    ctx.target_server.stop()


def _assert_resolution_rollback_refuses_retained_evidence(ctx):
    with pytest.raises(ctx.psycopg2.errors.ObjectNotInPrerequisiteState, match="forward recovery"):
        ctx.pg.apply_file(ctx.resolution_rollback)
    ctx.client._engine.dispose()
