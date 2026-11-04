"""Shared helpers for the explicit Dev custody qualification tests."""

from __future__ import annotations

import asyncio

import pytest

from db.hosted_custody_acl import QUALIFIED_FAMILY_SETTING
from db.hosted_custody_adoption import (
    PERSONAL_AGENT_UPGRADE_HOST_BINDING_QUALIFIED,
    _successor_qualification,
)
from db.migration_authority import MigrationMode, build_manifest_entries
from db.private_agent_adoption import execution_sql
from db.private_agent_adoption_successors import _WORKER_EVENT_SUCCESSOR_SHA256
from tests import hosted_pilot_readiness_cases as _readiness
from tests.helpers.private_agent_adoption import execute_mode
from tests.test_byoc_setup_job_azure_admission_postgres import ROOT


def dev_custody_environment():
    from db.hosted_custody_qualification import (
        CUSTODY_PROFILE_ENV,
        DEV_CONTROL_PLANE_OWNER_PROFILE,
        DEV_CUSTODY_DATABASE,
        DEV_CUSTODY_INSTANCE,
        DEV_CUSTODY_PRINCIPAL,
        DEV_CUSTODY_PROJECT_ID,
    )

    return {
        CUSTODY_PROFILE_ENV: DEV_CONTROL_PLANE_OWNER_PROFILE,
        "ENVIRONMENT": "dev",
        "DEV_TARGET": "shared-dev",
        "GCP_PROJECT_ID": DEV_CUSTODY_PROJECT_ID,
        "GOOGLE_CLOUD_PROJECT": DEV_CUSTODY_PROJECT_ID,
        "CLOUDSQL_INSTANCE_CONNECTION_NAME": DEV_CUSTODY_INSTANCE,
        "DB_NAME": DEV_CUSTODY_DATABASE,
        "DB_USER": DEV_CUSTODY_PRINCIPAL,
    }


def complete_custody_sql(profile, *, require_family=True):
    from db.hosted_custody_adoption import (
        HOSTED_FILES_NEW_SIGNATURES,
        HOSTED_FILES_QUALIFIED,
        HOSTED_FILES_SERVICE_ROLE_SIGNATURES,
        HOSTED_NATIVE_LOCATION_CONTRACT_QUALIFIED,
        HOSTED_PROVIDER_ACCOUNT_DOTTED_ACTOR_INTENT_SHA256,
        HOSTED_PROVIDER_ACCOUNT_RESOLUTION_QUALIFIED,
        HOSTED_PROVIDER_ACCOUNT_RESOLUTION_SERVICE_ROLE_SIGNATURES,
        HOSTED_PROVIDER_ACCOUNT_TRANSITION_ARCHIVE_SHA256,
        HOSTED_PROVIDER_ACCOUNT_TRANSITION_QUALIFIED,
        HOSTED_PROVIDER_ACCOUNT_TRANSITION_TRIGGER,
        PERSONAL_AGENT_UPGRADE_HOST_BINDING_QUALIFIED,
        QUALIFIED,
    )
    from db.hosted_custody_qualification import complete_family_qualification_sql

    return complete_family_qualification_sql(
        base_family=QUALIFIED,
        files_family=HOSTED_FILES_QUALIFIED,
        upgrade_family=PERSONAL_AGENT_UPGRADE_HOST_BINDING_QUALIFIED,
        native_contract_family=HOSTED_NATIVE_LOCATION_CONTRACT_QUALIFIED,
        service_role_signatures=HOSTED_FILES_SERVICE_ROLE_SIGNATURES,
        hosted_files_new_signatures=HOSTED_FILES_NEW_SIGNATURES,
        native_contract_new_signatures=frozenset(),
        require_family=require_family,
        profile=profile,
        provider_transition_family=HOSTED_PROVIDER_ACCOUNT_TRANSITION_QUALIFIED,
        provider_transition_trigger=HOSTED_PROVIDER_ACCOUNT_TRANSITION_TRIGGER,
        provider_transition_archive_sha256=HOSTED_PROVIDER_ACCOUNT_TRANSITION_ARCHIVE_SHA256,
        provider_transition_intent_successor_sha256=HOSTED_PROVIDER_ACCOUNT_RESOLUTION_QUALIFIED[
            "valid_hosted_provider_account_transition_intent(jsonb,jsonb)"
        ],
        provider_transition_intent_additional_successor_sha256=(
            HOSTED_PROVIDER_ACCOUNT_DOTTED_ACTOR_INTENT_SHA256
        ),
        provider_account_resolution_family=HOSTED_PROVIDER_ACCOUNT_RESOLUTION_QUALIFIED,
        provider_account_resolution_service_role_signatures=(
            HOSTED_PROVIDER_ACCOUNT_RESOLUTION_SERVICE_ROLE_SIGNATURES
        ),
        provider_account_resolution_intent_successor_sha256=(
            HOSTED_PROVIDER_ACCOUNT_DOTTED_ACTOR_INTENT_SHA256
        ),
    )


def registry_trigger_catalog(connection):
    """Capture the complete non-internal trigger set checked by migration 420."""
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT c.relname,t.tgname FROM pg_trigger t "
            "JOIN pg_class c ON c.oid=t.tgrelid "
            "JOIN pg_namespace n ON n.oid=c.relnamespace "
            "WHERE n.nspname='public' AND NOT t.tgisinternal AND c.relname IN "
            "('account_deletion_tombstones','agent_prompt_versions','byoc_setup_jobs',"
            "'consent_audit','consent_audit_receipts','one_action_directive_ledger',"
            "'personal_agent_cloud_removals','personal_agent_deletion_tombstones',"
            "'personal_agent_registry','personal_agent_standby_placements','pod_lifecycle_events',"
            "'pod_migration_jobs','pod_request_nonces','shared_files_storage',"
            "'webauthn_challenges','webauthn_credentials') "
            "ORDER BY c.relname,t.tgname"
        )
        return cursor.fetchall()


def later_owned_trigger_definitions(connection):
    """Capture exact definitions for guards owned after migration 420."""
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT c.relname,t.tgname,t.tgenabled,t.tgtype,t.tgnargs,"
            "t.tgattr::text,t.tgqual::text,pg_get_triggerdef(t.oid,true),"
            "p.proowner::regrole::text,pg_get_functiondef(p.oid),p.prosecdef,"
            "p.proconfig,p.proacl::text FROM pg_trigger t "
            "JOIN pg_class c ON c.oid=t.tgrelid "
            "JOIN pg_namespace n ON n.oid=c.relnamespace "
            "JOIN pg_proc p ON p.oid=t.tgfoid "
            "WHERE n.nspname='public' AND NOT t.tgisinternal AND ("
            "(c.relname='consent_audit' AND t.tgname IN "
            "('zz_consumer_memory_consent','zz_preserve_consumer_memory_consent')) OR "
            "(c.relname='personal_agent_registry' AND t.tgname IN "
            "('zz_personal_agent_upgrade_lease_host_binding',"
            "'zx_hosted_provider_account_transition_registry'))) "
            "ORDER BY c.relname,t.tgname"
        )
        return cursor.fetchall()


def _worker_event_guard(adapted_sql):
    worker_event_check = "p.proname='valid_byoc_azure_worker_event'"
    worker_event_position = adapted_sql.index(worker_event_check)
    guard_start = adapted_sql.rfind("DO $object_guard$", 0, worker_event_position)
    guard_end = adapted_sql.index("$object_guard$;", worker_event_position) + len("$object_guard$;")
    return adapted_sql[guard_start:guard_end]


def _assert_worker_event_guard(target, guard, installed_hash, dev_hash, successor_hash, psycopg2):
    assert f"'{successor_hash}'" in guard
    assert f"current_setting('{QUALIFIED_FAMILY_SETTING}',true)='true'" in guard
    _readiness._target_execute(
        target, "SELECT set_config(%s,'false',false)", (QUALIFIED_FAMILY_SETTING,)
    )
    if installed_hash == dev_hash:
        _readiness._target_execute(target, guard)
        return
    with pytest.raises(
        psycopg2.errors.RaiseException,
        match="Unqualified schema drift: valid_byoc_azure_worker_event",
    ):
        _readiness._target_execute(target, guard)
    _readiness._target_execute(
        target, "SELECT set_config(%s,'true',false)", (QUALIFIED_FAMILY_SETTING,)
    )
    _readiness._target_execute(target, guard)


def _exercise_successor_gate(pg, target, guard, successor_hash, worker_signature):
    original = pg.execute(
        "SELECT pg_get_functiondef(%s::regprocedure)", ("public." + worker_signature,)
    )[0][0]
    test_body = """CREATE OR REPLACE FUNCTION public.valid_byoc_azure_worker_event(
      owner_id text, expected_job text, event jsonb, history jsonb, target text, hushh_id text
    ) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
    BEGIN RETURN true; END; $$"""
    _readiness._target_execute(target, test_body)
    test_hash = _readiness._target_execute(
        target,
        "SELECT encode(sha256(convert_to(pg_get_functiondef('public.valid_byoc_azure_worker_event(text,text,jsonb,jsonb,text,text)'::regprocedure),'UTF8')),'hex')",
    )[0][0]
    gated = guard.replace(f"'{successor_hash}'", f"'{test_hash}'")
    assert gated != guard
    _readiness._target_execute(
        target, "SELECT set_config(%s,'false',false)", (QUALIFIED_FAMILY_SETTING,)
    )
    with pytest.raises(
        _pg_errors().RaiseException,
        match="Unqualified schema drift: valid_byoc_azure_worker_event",
    ):
        _readiness._target_execute(target, gated)
    _readiness._target_execute(
        target, "SELECT set_config(%s,'true',false)", (QUALIFIED_FAMILY_SETTING,)
    )
    _readiness._target_execute(target, gated)
    _readiness._target_execute(target, original)


def _pg_errors():
    return pytest.importorskip("psycopg2").errors


def replay_420_421(
    pg,
    target,
    database,
    family,
    *,
    database_user="hushh",
    replay_server=None,
):
    psycopg2 = pytest.importorskip("psycopg2")
    before = _readiness._custody_family_catalog(target, family)
    entries = build_manifest_entries(
        ROOT / "db/migrations",
        ["420_private_agent_lifecycle_foundation.sql", "421_cloud_removal_recovery.sql"],
    )
    worker_signature = "valid_byoc_azure_worker_event(text,text,jsonb,jsonb,text,text)"
    guard = _worker_event_guard(execution_sql(entries[0]))
    dev_hash = PERSONAL_AGENT_UPGRADE_HOST_BINDING_QUALIFIED[worker_signature]
    successor_hash = _WORKER_EVENT_SUCCESSOR_SHA256
    assert dev_hash == "95233dcf09e1b7a056cf3d846beb562e157ebf5be907ba33592e96cd45654cb4"
    installed_hash = before[worker_signature][0]
    assert installed_hash in {dev_hash, successor_hash}
    _assert_worker_event_guard(target, guard, installed_hash, dev_hash, successor_hash, psycopg2)
    _exercise_successor_gate(pg, target, guard, successor_hash, worker_signature)
    replay_server = replay_server or pg
    for entry in entries:
        assert asyncio.run(
            execute_mode(
                replay_server,
                database,
                entry,
                MigrationMode.REPLAY,
                database_user=database_user,
            )
        ) == (entry.filename,)
    _readiness._target_execute(target, _successor_qualification())
    assert _readiness._custody_family_catalog(target, family) == before
