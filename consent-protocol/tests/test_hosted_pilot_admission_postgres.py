"""Two-owner pilot reservations share the real provision journal and SQL locks."""

from __future__ import annotations

import asyncio
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from tests.pkm_conformance.postgres_harness import find_pg_bin
from tests.test_byoc_setup_job_azure_admission_postgres import ROOT, _Client, _server

psycopg2 = pytest.importorskip("psycopg2")
pytestmark = pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")
POLICY = "11111111-1111-4111-8111-111111111111"


def _assignment(owner: str, number: int) -> dict:
    return {
        "ownerHash": "sha256:" + hashlib.sha256(owner.encode()).hexdigest(),
        "hushhId": f"ha1_synthetic_hosted_owner_{number}",
        "project": f"hussh-pilot-owner-{number}",
        "projectNumber": str(100000000000 + number),
        "region": "us-central1",
    }


@pytest.fixture
def pg(monkeypatch):
    # Reuse the provision-journal fixture through its exact 954 predecessor.
    # Its minimal vault schema lacks 955's setup projection; complete release/dev
    # replay remains a separate required migration gate before activation.
    server = _server(monkeypatch, last=954)
    try:
        server.apply_file(ROOT / "db/migrations/parked/973_hosted_pod_pilot_admission.sql")
        yield server
    finally:
        server.stop()


def _policy(pg, *, expired=False, numbers_known=True, bootstrap=False):
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
            "-1 day" if expired else "1 day",
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
