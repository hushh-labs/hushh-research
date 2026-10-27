"""Two-owner pilot reservations share the real provision journal and SQL locks."""

from __future__ import annotations

import hashlib
import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from tests.pkm_conformance.postgres_harness import find_pg_bin
from tests.test_byoc_setup_job_azure_admission_postgres import ROOT, _server

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


def _policy(pg, *, expired=False, numbers_known=True):
    assignments = [_assignment("owner-a", 1), _assignment("owner-b", 2)]
    if not numbers_known:
        for assignment in assignments:
            assignment["projectNumber"] = None
    pg.execute(
        "INSERT INTO public.hosted_pod_pilot_policy(policy_id,environment,source_revision,"
        "image_digest,assignments,work_budget_cents,cleanup_reserve_cents,created_at,expires_at)"
        " VALUES (%s,'dev',%s,%s,%s::jsonb,40000,10000,now()-interval '2 days',"
        "now() + (%s)::interval)",
        (
            POLICY,
            "a" * 40,
            "sha256:" + "b" * 64,
            json.dumps(assignments),
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
