"""Two-owner pilot reservations share the real provision journal and SQL locks."""

from __future__ import annotations

import asyncio
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from tests import hosted_pilot_readiness_cases as _readiness_cases
from tests.pkm_conformance.postgres_harness import find_pg_bin
from tests.test_byoc_setup_job_azure_admission_postgres import ROOT, _Client

psycopg2 = pytest.importorskip("psycopg2")
pytestmark = pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")
POLICY = "11111111-1111-4111-8111-111111111111"


@pytest.fixture
def pg(monkeypatch):
    yield from _readiness_cases.pg.__wrapped__(monkeypatch)


def _assignment(owner: str, number: int) -> dict:
    return {
        "ownerHash": "sha256:" + hashlib.sha256(owner.encode()).hexdigest(),
        "hushhId": f"ha1_synthetic_hosted_owner_{number}",
        "project": f"hussh-pilot-owner-{number}",
        "projectNumber": str(100000000000 + number),
        "region": "us-central1",
    }


def _policy(
    pg, *, expired=False, numbers_known=True, bootstrap=False, preparation=False, ttl="1 day"
):
    from hushh_mcp.managed_ai_config import load_profile, profile_hash

    profile = load_profile("dev")
    assignments = [_assignment("owner-a", 1), _assignment("owner-b", 2)]
    if not numbers_known:
        for assignment in assignments:
            assignment["projectNumber"] = None
    if bootstrap:
        for assignment in assignments:
            assignment["bootstrapContract"] = (
                bootstrap(assignment)
                if callable(bootstrap)
                else {
                    "plan": {
                        "tenancy": "hussh-hosted",
                        "target": {
                            "project": assignment["project"],
                            "region": assignment["region"],
                        },
                    },
                    "steps": ["enable_services", "kms_key"],
                }
            )
    if preparation:
        from tests.hosted_pod_support import hosted_preparation_contract

        for assignment in assignments:
            assignment["preparationContract"] = hosted_preparation_contract()
    pg.execute(
        "INSERT INTO public.hosted_pod_pilot_policy(policy_id,environment,source_revision,"
        "image_digest,assignments,model_binding,work_budget_cents,cleanup_reserve_cents,created_at,expires_at)"
        " VALUES (%s,'dev',%s,%s,%s::jsonb,%s::jsonb,40000,10000,now()-interval '2 days',"
        "now() + (%s)::interval)",
        (
            POLICY,
            "a" * 40,
            "sha256:" + "b" * 64,
            json.dumps(assignments),
            json.dumps(
                {
                    "provider": "gemini",
                    "model": profile["text_model"],
                    "project": profile["project"],
                    "profileHash": profile_hash(profile),
                }
            ),
            "-1 day" if expired else ttl,
        ),
    )


def _claim(pg, owner="owner-a", number=1, *, target="gcp", attempt="a" * 32):
    desired = {
        "user_id": owner,
        "hushh_id": _assignment(owner, number)["hushhId"],
        "phone_e164_hash": "sha256:synthetic-phone-" + str(number),
        "deployment_target": target,
        "model_credential_mode": "fleet_adc",
    }
    return pg.execute(
        "SELECT public.claim_hosted_pod_pilot_provision(%s,%s,NULL,%s::jsonb)",
        (owner, attempt, json.dumps(desired)),
    )[0][0]


def test_no_policy_or_expired_policy_never_reserves_a_managed_owner(pg):
    with pytest.raises(psycopg2.errors.InsufficientPrivilege, match="admission unavailable"):
        _claim(pg)
    assert pg.execute("SELECT count(*) FROM personal_agent_registry")[0][0] == 0
    _policy(pg, expired=True)
    with pytest.raises(psycopg2.errors.InsufficientPrivilege, match="admission unavailable"):
        _claim(pg)
    assert pg.execute("SELECT count(*) FROM personal_agent_registry")[0][0] == 0


def test_two_concurrent_owners_get_distinct_fixed_projects_and_cannot_replenish(pg):
    _policy(pg)
    with ThreadPoolExecutor(max_workers=2) as workers:
        futures = [
            workers.submit(_claim, pg, owner, number, attempt=character * 32)
            for owner, number, character in [("owner-a", 1, "a"), ("owner-b", 2, "b")]
        ]
        reservations = [future.result(timeout=20) for future in futures]
    assert {r["hostedAdmission"]["assignment"]["project"] for r in reservations} == {
        "hussh-pilot-owner-1",
        "hussh-pilot-owner-2",
    }
    assert sum(r["hostedAdmission"]["workBudgetCents"] for r in reservations) == 40000
    assert sum(r["hostedAdmission"]["cleanupReserveCents"] for r in reservations) == 10000
    with pytest.raises(psycopg2.errors.InsufficientPrivilege):
        _claim(pg, attempt="c" * 32)
    with pytest.raises(psycopg2.errors.InsufficientPrivilege, match="not admitted"):
        _claim(pg, "owner-c", 3)
    for statement in [
        "UPDATE hosted_pod_pilot_policy SET work_budget_cents=40000",
        "DELETE FROM hosted_pod_pilot_policy",
        "TRUNCATE hosted_pod_pilot_policy",
    ]:
        with pytest.raises(psycopg2.errors.InsufficientPrivilege, match="allocation is retained"):
            pg.execute(statement)
    assert pg.execute("SELECT count(*) FROM personal_agent_registry")[0][0] == 2


def test_identity_change_and_foreign_cloud_coordinates_cannot_claim_assignment(pg):
    _policy(pg)
    with pytest.raises(psycopg2.errors.InsufficientPrivilege, match="not admitted"):
        _claim(pg, "owner-a", 2)
    desired = {
        "user_id": "owner-a",
        "hushh_id": _assignment("owner-a", 1)["hushhId"],
        "phone_e164_hash": "sha256:synthetic",
        "deployment_target": "gcp",
        "user_cloud_project": "foreign-owner-project",
    }
    with pytest.raises(psycopg2.errors.InsufficientPrivilege, match="admission unavailable"):
        pg.execute(
            "SELECT public.claim_hosted_pod_pilot_provision(%s,%s,NULL,%s::jsonb)",
            ("owner-a", "a" * 32, json.dumps(desired)),
        )


def test_new_project_ids_are_reserved_before_provider_creation_assigns_numbers(pg):
    _policy(pg, numbers_known=False)
    reservation = _claim(pg)
    assert reservation["hostedAdmission"]["assignment"]["project"] == "hussh-pilot-owner-1"
    assert reservation["hostedAdmission"]["assignment"]["projectNumber"] is None
    duplicated = [_assignment("owner-a", 1), _assignment("owner-b", 2)]
    duplicated[1]["projectNumber"] = duplicated[0]["projectNumber"]
    assert (
        pg.execute(
            "SELECT valid_hosted_pod_pilot_assignments(%s::jsonb)", (json.dumps(duplicated),)
        )[0][0]
        is False
    )


def test_allocation_survives_publication_terminal_deletion_and_schema_replay(pg):
    _policy(pg)
    reservation = _claim(pg)
    assert pg.execute(
        "SELECT publish_personal_agent_provision('owner-a',%s,'reserved','substrate','{}')",
        ("a" * 32,),
    )[0][0]
    stored = pg.execute("SELECT backend_metadata->'provisionAttempt' FROM personal_agent_registry")[
        0
    ][0]
    assert stored["hostedAdmission"] == reservation["hostedAdmission"]
    # Fixture represents a completed host. Losing its journal is uncertainty,
    # never permission to reset its independently retained budget reservation.
    pg.execute("ALTER TABLE personal_agent_registry DISABLE TRIGGER USER")
    pg.execute(
        "UPDATE personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,"
        "'{provisionAttempt,phase}','\"provisioned\"')"
    )
    pg.execute("ALTER TABLE personal_agent_registry ENABLE TRIGGER USER")
    pg.execute("DELETE FROM personal_agent_registry")
    pg.apply_file(ROOT / "db/migrations/parked/973_hosted_pod_pilot_admission.sql")
    with pytest.raises(psycopg2.errors.InsufficientPrivilege, match="requires reconciliation"):
        _claim(pg, attempt="c" * 32)
    assert pg.execute("SELECT attempt_a FROM hosted_pod_pilot_policy")[0][0] == "a" * 32


def test_dry_rollback_restores_existing_claim_and_retained_policy_refuses_rollback(pg):
    rollback = ROOT / "db/migrations/rollback/973_hosted_pod_pilot_admission.rollback.sql"
    pg.apply_file(rollback)
    assert pg.execute("SELECT to_regclass('public.hosted_pod_pilot_policy')")[0][0] is None
    pg.apply_file(ROOT / "db/migrations/parked/973_hosted_pod_pilot_admission.sql")
    _policy(pg)
    with pytest.raises(psycopg2.errors.RaiseException, match="retain admitted pilot"):
        pg.apply_file(rollback)


def _current(pg, reservation, *, owner="owner-a"):
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    client = _Client(pg)
    try:
        return asyncio.run(
            PersonalAgentRegistryRepo(client).hosted_admission_current(
                owner_id=owner,
                attempt_id=reservation["attemptId"],
                admission=reservation["hostedAdmission"],
            )
        )
    finally:
        client._engine.dispose()


def test_fresh_admission_rejects_other_owner_model_drift_and_failed_operation(pg):
    _policy(pg)
    reservation = _claim(pg)
    assert _current(pg, reservation)
    assert not _current(pg, reservation, owner="owner-b")
    changed = json.loads(json.dumps(reservation))
    changed["hostedAdmission"]["modelBinding"]["project"] = "another-model-project"
    assert not _current(pg, changed)
    assert pg.execute(
        "SELECT publish_personal_agent_provision('owner-a',%s,'reserved','failed','{}')",
        (reservation["attemptId"],),
    )[0][0]
    assert not _current(pg, reservation)


def test_controller_binding_keeps_fresh_sql_authority_on_worker_and_rejects_wrong_image(pg):
    from hushh_mcp.services.compute_backend import PodSpec
    from hushh_mcp.services.hosted_gcp_admission import (
        bind_provision_spec,
        deployment_from_reservation,
    )
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    _policy(pg)
    reservation = _claim(pg)
    spec = PodSpec(
        hushh_id=_assignment("owner-a", 1)["hushhId"],
        pod_pubkey="",
        phone_e164_hash="sha256:synthetic",
        deployment_target="gcp",
        provision_attempt_id=reservation["attemptId"],
    )
    release = {
        "sourceRevision": "a" * 40,
        "image": "gcr.io/hushh-pda-dev/consent-protocol-pod@sha256:" + "b" * 64,
    }
    principal = "consent-plane@hushh-pda-dev.iam.gserviceaccount.com"
    with pytest.raises(ValueError, match="reservation does not match"):
        deployment_from_reservation(
            spec,
            reservation,
            release={**release, "sourceRevision": "c" * 40},
            hub_principal=principal,
        )
    client = _Client(pg)

    async def scenario():
        bound = await bind_provision_spec(
            spec,
            reservation,
            registry=PersonalAgentRegistryRepo(client),
            release=release,
            hub_principal=principal,
        )
        assert bound.private_gcp_deployment.project == "hussh-pilot-owner-1"
        guard = bound.hosted_admission_guard
        assert guard is not None
        await asyncio.to_thread(guard)
        with pytest.raises(RuntimeError, match="worker thread"):
            guard()
        # A failed operation cannot retain permission through a cached callback.
        await asyncio.to_thread(
            pg.execute,
            "SELECT publish_personal_agent_provision('owner-a',%s,'reserved','failed','{}')",
            (reservation["attemptId"],),
        )
        with pytest.raises(RuntimeError, match="admission changed"):
            await asyncio.to_thread(guard)

    try:
        asyncio.run(scenario())
    finally:
        client._engine.dispose()


def test_project_number_settlement_retains_original_budget_and_assignment(pg):
    _policy(pg, numbers_known=False)
    reservation = _claim(pg)
    observation = {
        "projectId": "hussh-pilot-owner-1",
        "projectNumber": "100000000001",
        "lifecycleState": "ACTIVE",
    }

    def settle(value, owner="owner-a", attempt="a" * 32):
        return pg.execute(
            "SELECT public.retain_hosted_pod_project_observation(%s,%s,%s::jsonb)",
            (owner, attempt, json.dumps(value)),
        )[0][0]

    assert not settle({**observation, "projectId": "foreign-project"})
    assert not settle(observation, owner="owner-b")
    assert not settle(observation, attempt="b" * 32)
    assert settle(observation)
    assert settle(observation)
    assert not settle({**observation, "projectNumber": "100000000002"})
    attempt = pg.execute(
        "SELECT backend_metadata->'provisionAttempt' FROM personal_agent_registry WHERE user_id='owner-a'"
    )[0][0]
    assert attempt["hostedAdmission"] == reservation["hostedAdmission"]
    assert attempt["evidence"]["reserved"]["projectObservation"] == observation
    policy = pg.execute(
        "SELECT attempt_a,assignments->0->'projectNumber',work_budget_cents FROM hosted_pod_pilot_policy"
    )[0]
    assert policy == ("a" * 32, None, 40000)
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    client = _Client(pg)

    async def verify_binding():
        repo = PersonalAgentRegistryRepo(client)
        arguments = {
            "owner_id": "owner-a",
            "attempt_id": "a" * 32,
            "admission": attempt["hostedAdmission"],
        }
        assert not await repo.hosted_admission_current(**arguments)
        assert await repo.hosted_admission_current(**arguments, project_observation=observation)
        assert await asyncio.to_thread(
            pg.execute,
            "SELECT publish_personal_agent_provision('owner-a',%s,'reserved','substrate','{}')",
            ("a" * 32,),
        ) == [(True,)]
        assert await repo.hosted_admission_current(**arguments, project_observation=observation)
        assert not await repo.hosted_admission_current(
            **arguments, project_observation={**observation, "projectNumber": "100000000002"}
        )

    try:
        asyncio.run(verify_binding())
    finally:
        client._engine.dispose()


def test_restart_reuses_exact_reserved_attempt_without_new_allocation(pg):
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
    from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired

    _policy(pg)
    original = _claim(pg)
    observed = pg.execute(
        "SELECT to_jsonb(r) FROM personal_agent_registry r WHERE user_id='owner-a'"
    )[0][0]
    client = _Client(pg)

    async def scenario():
        repo = PersonalAgentRegistryRepo(client)
        resumed = await repo.claim_provision(observed=observed, intent=original["intent"])
        assert resumed == original
        assert resumed["attemptId"] == "a" * 32
        with pytest.raises(ProvisionReconciliationRequired):
            await repo.claim_provision(
                observed=observed, intent={**original["intent"], "phone_e164_hash": "changed"}
            )
        assert pg.execute("SELECT attempt_a,attempt_b FROM hosted_pod_pilot_policy")[0] == (
            "a" * 32,
            None,
        )
        pg.execute(
            "SELECT publish_personal_agent_provision('owner-a',%s,'reserved','failed','{}')",
            ("a" * 32,),
        )
        with pytest.raises(ProvisionReconciliationRequired):
            await repo.claim_provision(observed=observed, intent=original["intent"])

    try:
        asyncio.run(scenario())
    finally:
        client._engine.dispose()


def test_frozen_managed_cleanup_coordinates_preserve_real_authorization_history(pg, monkeypatch):
    from copy import deepcopy

    from tests.test_hosted_pod_bootstrap_postgres import _approved_bootstrap

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    pg.apply_file(ROOT / "db/migrations/parked/974_hosted_pod_custody.sql")
    _policy(pg, bootstrap=_approved_bootstrap)
    reservation = _claim(pg)
    assignment = reservation["hostedAdmission"]["assignment"]
    project = assignment["project"]
    from tests.hosted_pod_support import hosted_project_authorization

    authorization = hosted_project_authorization(reservation)
    reservation["evidence"] = {
        "reserved": {
            "projectObservation": {
                "projectId": project,
                "projectNumber": assignment["projectNumber"],
                "lifecycleState": "ACTIVE",
            },
            "projectAuthorization": authorization,
        }
    }
    snapshot = {
        "user_id": "owner-a",
        "hushh_id": assignment["hushhId"],
        "deployment_target": "gcp",
        "backend_metadata": {"tenancy": "hussh-hosted", "provisionAttempt": reservation},
    }

    def coordinates(value):
        return pg.execute("SELECT private_gcp_coordinates(%s::jsonb)", (json.dumps(value),))[0][0]

    assert coordinates(snapshot)["project"] == project
    erasure = {"ownerId": "owner-a", "hushhId": assignment["hushhId"], "registrySnapshot": snapshot}
    history = pg.execute(
        "SELECT erasure_authorization_history(%s::jsonb,NULL)", (json.dumps(erasure),)
    )[0][0]
    assert history == {reservation["attemptId"]: authorization}
    for defect in ("owner", "identity", "authority", "project", "foreign"):
        invalid = deepcopy(snapshot)
        if defect == "owner":
            invalid["user_id"] = "owner-b"
        elif defect == "foreign":
            invalid["user_cloud_project"] = "foreign-project"
        else:
            reserved = invalid["backend_metadata"]["provisionAttempt"]["evidence"]["reserved"]
            if defect == "project":
                reserved["projectObservation"]["projectNumber"] = "999999999999"
            elif defect == "identity":
                reserved["projectAuthorization"]["receipt"]["bootstrapIdentity"]["email"] = (
                    "foreign@foreign-project.iam.gserviceaccount.com"
                )
            else:
                reserved["projectAuthorization"]["receipt"]["bindingObservation"]["member"] = (
                    "serviceAccount:foreign@foreign-project.iam.gserviceaccount.com"
                )
        assert coordinates(invalid) is None


@pytest.mark.parametrize(
    "helper", ["placement", "prefix_memory", "item_payload", "dependency_order"]
)
def test_managed_custody_replay_refuses_unknown_helper_drift(pg, helper):
    from db.hosted_custody_adoption import _successor_qualification

    pg.apply_file(ROOT / "db/migrations/parked/974_hosted_pod_custody.sql")
    pg.execute(_successor_qualification())
    changed = {
        "placement": "private_gcp_coordinates(snapshot jsonb) RETURNS jsonb AS $$ BEGIN RETURN '{}'::jsonb; END; $$",
        "prefix_memory": "valid_managed_prefix_memory_absence(c jsonb,observation jsonb) RETURNS boolean AS $$ BEGIN RETURN true; END; $$",
        "item_payload": "valid_managed_prefix_item_result(r jsonb,kind text,key text,receipt jsonb) RETURNS boolean AS $$ BEGIN RETURN true; END; $$",
        "dependency_order": "managed_prefix_items_complete(r jsonb,kind text) RETURNS boolean AS $$ BEGIN RETURN true; END; $$",
    }[helper]
    pg.execute(
        "CREATE OR REPLACE FUNCTION public."
        + changed
        + " LANGUAGE plpgsql IMMUTABLE SET search_path=public"
    )
    with pytest.raises(
        psycopg2.errors.RaiseException, match="Unqualified managed custody successor"
    ):
        pg.execute(_successor_qualification())
    with pytest.raises(
        psycopg2.errors.RaiseException, match="Unqualified managed custody predecessor"
    ):
        pg.apply_file(ROOT / "db/migrations/parked/974_hosted_pod_custody.sql")


def test_verified_phone_retains_fixed_cohort_selection(pg, monkeypatch):
    from tests.helpers.hosted_pilot_selection import prove_phone_pending_selection

    asyncio.run(prove_phone_pending_selection(pg, monkeypatch))


def test_hosted_files_readiness_requires_executor_binding_and_refreshed_contract(pg, monkeypatch):
    _readiness_cases.run_readiness_case(pg, monkeypatch)


def _dev_custody_environment():
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


def _complete_custody_sql(profile, *, require_family=True):
    from db.hosted_custody_adoption import (
        HOSTED_FILES_NEW_SIGNATURES,
        HOSTED_FILES_QUALIFIED,
        HOSTED_FILES_SERVICE_ROLE_SIGNATURES,
        HOSTED_NATIVE_LOCATION_CONTRACT_QUALIFIED,
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
    )


def test_dev_custody_profile_requires_explicit_exact_runtime_configuration():
    from db.hosted_custody_qualification import (
        CUSTODY_PROFILE_ENV,
        DEV_CONTROL_PLANE_OWNER_PROFILE,
        STRICT_CUSTODY_PROFILE,
        hosted_custody_profile_from_environment,
    )

    config = _dev_custody_environment()
    profile = hosted_custody_profile_from_environment(config)
    assert profile.name == DEV_CONTROL_PLANE_OWNER_PROFILE
    assert profile.system_identifier_sha256 == (
        "320fe60c039c7a44aa11e7b670de5e3576d9c4ab7e95de76657719b6c56810b0"
    )

    unselected = dict(config)
    del unselected[CUSTODY_PROFILE_ENV]
    assert hosted_custody_profile_from_environment(unselected).name == STRICT_CUSTODY_PROFILE

    for key, wrong_value in (
        ("ENVIRONMENT", "uat"),
        ("GCP_PROJECT_ID", "hushh-pda-uat"),
        ("GOOGLE_CLOUD_PROJECT", "hushh-pda-uat"),
        ("CLOUDSQL_INSTANCE_CONNECTION_NAME", "hushh-pda-prod:us-central1:hushh-prod-pg"),
        ("DB_NAME", "scope_commerce_sandbox"),
        ("DB_USER", "service_role"),
        ("DEV_TARGET", "scope-commerce-sandbox"),
    ):
        wrong = {**config, key: wrong_value}
        with pytest.raises(ValueError, match=key):
            hosted_custody_profile_from_environment(wrong)

    with pytest.raises(ValueError, match="DEV_TARGET"):
        hosted_custody_profile_from_environment(
            {CUSTODY_PROFILE_ENV: config[CUSTODY_PROFILE_ENV], "ENVIRONMENT": "dev"}
        )


def test_dev_profile_keeps_complete_979_family_checks_and_420_421_binding(monkeypatch):
    from db.hosted_custody_qualification import (
        DEV_CUSTODY_SYSTEM_IDENTIFIER_SHA256,
        ROLLBACK_SOURCE_PREIMAGES,
        hosted_custody_profile_from_environment,
    )
    from db.migration_authority import build_manifest_entries
    from db.private_agent_adoption import execution_sql

    profile = hosted_custody_profile_from_environment(_dev_custody_environment())
    sql = _complete_custody_sql(profile)
    assert "function vector or metadata" in sql
    assert "rollback marker shape or ACL" in sql
    assert "rollback preimages" in sql
    assert "upgrade host trigger" in sql
    assert "project grant trigger" in sql
    assert "erasure registry trigger" in sql
    assert "overload or missing function" in sql
    assert DEV_CUSTODY_SYSTEM_IDENTIFIER_SHA256 in sql
    assert "hushh_uat_app" in sql
    assert "service_role')" in sql

    from db.hosted_custody_adoption import HOSTED_FILES_QUALIFIED, QUALIFIED

    for digest in (*QUALIFIED.values(), *HOSTED_FILES_QUALIFIED.values()):
        assert digest.encode().hex() in sql
    for digest in ROLLBACK_SOURCE_PREIMAGES.values():
        assert digest.encode().hex() in sql

    entries = build_manifest_entries(
        ROOT / "db/migrations",
        ["420_private_agent_lifecycle_foundation.sql", "421_cloud_removal_recovery.sql"],
    )
    for key, value in _dev_custody_environment().items():
        monkeypatch.setenv(key, value)
    for entry in entries:
        replay_sql = execution_sql(entry)
        assert replay_sql.count("Dev database identity") >= 2
        assert DEV_CUSTODY_SYSTEM_IDENTIFIER_SHA256 in replay_sql
        assert "owner-only function ACL" in replay_sql

    invalid_config = _dev_custody_environment()
    invalid_config["CLOUDSQL_INSTANCE_CONNECTION_NAME"] = "local-proxy"
    monkeypatch.setenv(
        "HUSHH_HOSTED_CUSTODY_PROFILE", invalid_config["HUSHH_HOSTED_CUSTODY_PROFILE"]
    )
    monkeypatch.setenv("DEV_TARGET", invalid_config["DEV_TARGET"])
    monkeypatch.setenv("GCP_PROJECT_ID", invalid_config["GCP_PROJECT_ID"])
    monkeypatch.setenv(
        "CLOUDSQL_INSTANCE_CONNECTION_NAME", invalid_config["CLOUDSQL_INSTANCE_CONNECTION_NAME"]
    )
    monkeypatch.setenv("DB_NAME", invalid_config["DB_NAME"])
    monkeypatch.setenv("DB_USER", invalid_config["DB_USER"])
    with pytest.raises(ValueError, match="CLOUDSQL_INSTANCE_CONNECTION_NAME"):
        execution_sql(entries[0])


def test_dev_owner_only_readiness_rejects_wrong_cluster_service_role_and_acl_drift(
    pg, monkeypatch, request
):
    import db.hosted_custody_qualification as custody_qualification
    from db.hosted_custody_adoption import _successor_qualification
    from hushh_mcp.services.pod_files.capability_contract import hosted_schema_ready
    from tests.hosted_pilot_readiness_cases import (
        _apply_hosted_predecessor_migrations,
        _create_runtime_roles,
    )

    _create_runtime_roles(pg)
    _apply_hosted_predecessor_migrations(pg, lambda: False)
    for migration in (
        "979_hosted_files_executor.sql",
        "980_personal_agent_upgrade_host_binding.sql",
        "981_hosted_native_location_contract.sql",
    ):
        pg.apply_file(ROOT / "db/migrations/parked" / migration)
    pg.execute(_successor_qualification())

    pg.execute("DROP OWNED BY service_role")
    pg.execute("DROP ROLE service_role")
    pg.execute("CREATE ROLE hushh_uat_app LOGIN SUPERUSER")
    from db.hosted_custody_adoption import qualified_hosted_custody_family

    for signature in qualified_hosted_custody_family():
        name, _, arguments = signature.partition("(")
        pg.execute(f'ALTER FUNCTION public."{name}"({arguments} OWNER TO hushh_uat_app')
    pg.execute("ALTER TABLE public.personal_agent_registry OWNER TO hushh_uat_app")
    pg.execute(
        "ALTER TABLE public.hosted_files_executor_976_rollback_source OWNER TO hushh_uat_app"
    )
    local_system_identifier_hash = pg.execute(
        "SELECT encode(sha256(convert_to(system_identifier::text,'UTF8')),'hex') "
        "FROM pg_control_system()"
    )[0][0]
    monkeypatch.setattr(
        custody_qualification,
        "DEV_CUSTODY_SYSTEM_IDENTIFIER_SHA256",
        local_system_identifier_hash,
    )
    for key, value in _dev_custody_environment().items():
        monkeypatch.setenv(key, value)

    import psycopg2

    current_principal = pg.execute("SELECT current_user,session_user")[0]
    assert current_principal == ("hushh", "hushh")
    with pytest.raises(psycopg2.errors.RaiseException, match="Dev database identity"):
        pg.execute(_successor_qualification())

    owner_connection = psycopg2.connect(
        host=pg.dir, port=pg.port, user="hushh_uat_app", dbname="postgres"
    )
    request.addfinalizer(owner_connection.close)
    owner_connection.autocommit = True

    def owner_execute(statement, params=None):
        with owner_connection.cursor() as cursor:
            cursor.execute(statement, params)
            return cursor.fetchall() if cursor.description is not None else []

    class ReadinessRepo:
        def __init__(self):
            self.connection = owner_connection

        async def files_upgrade_admission_ready(self, **_kwargs):
            return True

        def _db(self):
            return self

        def execute_raw(self, sql, _params):
            with self.connection.cursor() as cursor:
                cursor.execute(sql)

    repo = ReadinessRepo()

    def ready():
        return asyncio.run(hosted_schema_ready(repo))

    assert ready()

    monkeypatch.setattr(custody_qualification, "DEV_CUSTODY_SYSTEM_IDENTIFIER_SHA256", "0" * 64)
    assert not ready(), "runtime readiness accepted a different PostgreSQL system identifier"
    monkeypatch.setattr(
        custody_qualification,
        "DEV_CUSTODY_SYSTEM_IDENTIFIER_SHA256",
        local_system_identifier_hash,
    )

    pg.execute("CREATE ROLE service_role NOLOGIN")
    assert not ready(), "runtime readiness accepted a present service_role"
    pg.execute("DROP ROLE service_role")
    assert ready()

    signature = "public.begin_hosted_files_executor(text,jsonb,jsonb,timestamptz,timestamptz,jsonb,text,text,text,jsonb,text,text)"
    owner_execute("CREATE ROLE hosted_custody_unexpected NOLOGIN")
    owner_execute(f"GRANT EXECUTE ON FUNCTION {signature} TO hosted_custody_unexpected")
    assert not ready(), "runtime readiness accepted an unexpected ACL grantee"
    owner_execute(f"REVOKE EXECUTE ON FUNCTION {signature} FROM hosted_custody_unexpected")
    assert ready()

    owner_execute(
        f"GRANT EXECUTE ON FUNCTION {signature} TO hosted_custody_unexpected WITH GRANT OPTION"
    )
    assert not ready(), "runtime readiness accepted an ACL grant option"
    owner_execute(f"REVOKE EXECUTE ON FUNCTION {signature} FROM hosted_custody_unexpected CASCADE")
    assert ready()

    public_signature = "public.personal_agent_upgrade_lease_host_binding(jsonb)"
    owner_execute("CREATE ROLE hosted_custody_grantor NOLOGIN")
    owner_execute(
        f"GRANT EXECUTE ON FUNCTION {public_signature} TO hosted_custody_grantor WITH GRANT OPTION"
    )
    owner_execute("SET ROLE hosted_custody_grantor")
    owner_execute(f"GRANT EXECUTE ON FUNCTION {public_signature} TO PUBLIC")
    owner_execute("RESET ROLE")
    assert owner_execute(
        "SELECT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL "
        "aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a "
        "WHERE p.oid=to_regprocedure(%s) AND a.grantee=0 "
        "AND a.grantor=(SELECT oid FROM pg_roles WHERE rolname='hosted_custody_grantor'))",
        (public_signature,),
    )[0][0]
    assert not ready(), "runtime readiness accepted a non-owner ACL grantor"
    owner_execute(
        f"REVOKE EXECUTE ON FUNCTION {public_signature} FROM hosted_custody_grantor CASCADE"
    )
    owner_execute("DROP ROLE hosted_custody_grantor")
    owner_execute("DROP ROLE hosted_custody_unexpected")
    assert ready()
