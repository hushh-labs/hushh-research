"""Parked migration 949: the owner-access erasure receipt, retained once and validated.

Static shape always; behaviour against a disposable PostgreSQL when one is installed.
The receipt under test is the one ``azure_agent_erasure.receipt_for`` really builds,
so the Python shape and the SQL validator cannot drift apart unnoticed.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tests.pkm_conformance import postgres_harness
from tests.pkm_conformance.postgres_harness import TempPostgres, find_pg_bin

psycopg2 = pytest.importorskip("psycopg2")

ROOT = Path(__file__).resolve().parents[1]
PARKED = ROOT / "db/migrations/parked"
MIGRATION = PARKED / "949_personal_agent_owner_access_erasure.sql"
ROLLBACK = ROOT / "db/migrations/rollback/949_personal_agent_owner_access_erasure.rollback.sql"
OWNER = "synthetic-owner"
HUSHH_ID = "ha1_abcdefghijklmnopqrstuvwxyz234567"
TENANT = "11111111-1111-1111-1111-111111111111"
SUB = "22222222-2222-2222-2222-222222222222"
_needs_pg = pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")


def test_949_is_manifested_after_948_with_a_rollback():
    ordered = json.loads((ROOT / "db/dev_migration_manifest.json").read_text())[
        "ordered_migrations"
    ]
    assert ordered.index(MIGRATION.name) == ordered.index("948_personal_agent_user_azure.sql") + 1
    assert ROLLBACK.is_file()


def test_the_guard_is_943s_verbatim_plus_one_transition():
    """Rewriting the guard by hand once dropped earlier transitions (see 940)."""

    def guard(path: Path) -> str:
        text = path.read_text()
        start = text.index(
            "CREATE OR REPLACE FUNCTION public.guard_personal_agent_erasure_registry()"
        )
        return text[start : text.index("$$;", start)]

    previous = guard(PARKED / "943_personal_agent_files_upgrade_evidence.sql")
    composed = guard(MIGRATION)
    assert guard(ROLLBACK) == previous
    assert composed.count("ownerAccessErasure") == 3
    removed = [line for line in previous.splitlines() if line not in composed.splitlines()]
    assert removed == []


def _resource_group() -> str:
    from hushh_mcp.services.azure_setup_plan import resource_group_name

    return resource_group_name(HUSHH_ID)


def _receipt(**pod: object) -> dict:
    from hushh_mcp.services.azure_agent_erasure import receipt_for
    from hushh_mcp.services.azure_setup_plan import PlanInputs

    inputs = PlanInputs(
        hushh_id=HUSHH_ID, tenant_id=TENANT, subscription_id=SUB, location="eastus2",
        resource_group=_resource_group(), nonce="0123456789abcdef",
    )  # fmt: skip
    group = f"/subscriptions/{SUB}/resourceGroups/{_resource_group()}"
    pod_receipt = {
        "status": "erased", "erased": True, "hushhId": HUSHH_ID, "attemptId": "attempt-1",
        "service": "ca-hussh-one-pod", "serviceUid": "incarnation-1",
        "revision": "ca-hussh-one-pod--r1", "deleted": 6, "alreadyAbsent": 3, "records": 3,
        **pod,
    }  # fmt: skip
    revoked = f"{group}/providers/Microsoft.Authorization/roleAssignments/abc"
    return receipt_for(
        inputs, pod_receipt=pod_receipt, pod_revoked=[revoked], hussh_revoked=[revoked]
    )


@pytest.fixture
def pg(monkeypatch):
    monkeypatch.setattr(postgres_harness, "MIGRATIONS", [])
    server = TempPostgres()
    try:
        server.start()
        schema = (ROOT / "db/legacy/init_legacy_schema.sql").read_text()
        table = schema.split("CREATE TABLE IF NOT EXISTS consent_audit (", 1)[1].split(";", 1)[0]
        server.execute("CREATE TABLE IF NOT EXISTS consent_audit (" + table)
        server.execute("CREATE TABLE IF NOT EXISTS actor_profiles (user_id TEXT PRIMARY KEY)")
        server.apply_file(ROOT / "db/migrations/201_account_deletion_tombstones.sql")
        server.apply_file(PARKED / "915_personal_agent_renewal_authority.sql")
        for name in (
            "900_personal_agent_registry.sql", "905_personal_agent_liveness.sql",
            "906_personal_agent_user_cloud.sql", "907_pod_lifecycle_events.sql",
            "908_personal_agent_tombstone_metadata.sql", "911_pod_migration_jobs.sql",
            "912_personal_agent_status_migrating.sql", "914_personal_agent_billing_space_id.sql",
            "916_personal_agent_erasure_admission.sql", "917_personal_agent_provision_admission.sql",
            "909_byoc_setup_jobs.sql",
        ):  # fmt: skip
            server.apply_file(PARKED / name)
        for path in sorted(PARKED.glob("*.sql")):
            if 918 <= int(path.name.split("_", 1)[0]) <= 943:
                server.apply_file(path)
        server.apply_file(PARKED / "948_personal_agent_user_azure.sql")
        server.apply_file(MIGRATION)
        yield server
    finally:
        server.stop()


def _reserve(pg, *, target: str = "user_azure") -> dict:
    metadata = {"serviceUid": "incarnation-1", "url": "https://agent.example.test"}
    pg.execute(
        "INSERT INTO personal_agent_registry(user_id,hushh_id,status,backend,deployment_target,"
        "user_cloud_tenant_id,user_cloud_subscription_id,user_cloud_resource_group,"
        "user_cloud_region,user_cloud_project,backend_metadata) "
        "VALUES (%s,%s,'provisioned',%s,%s,%s,%s,%s,'eastus2',%s,%s::jsonb)",
        (
            OWNER, HUSHH_ID, target, target, TENANT, SUB, _resource_group(),
            "synthetic-project" if target == "user_gcp" else None, json.dumps(metadata),
        ),
    )  # fmt: skip
    return pg.execute("SELECT reserve_personal_agent_erasure(%s,'attempt-1')", (OWNER,))[0][0]


def _retain(pg, reservation: dict, receipt: dict) -> bool:
    return pg.execute(
        "SELECT retain_erasure_owner_access(%s,%s,%s::jsonb,%s::jsonb)",
        (OWNER, reservation["attemptId"], json.dumps(reservation), json.dumps(receipt)),
    )[0][0]


@_needs_pg
def test_the_receipt_is_retained_once_and_bound_to_the_attempt(pg):
    reservation, receipt = _reserve(pg), _receipt()
    assert _retain(pg, {**reservation, "attemptId": "attempt-2"}, receipt) is False
    assert _retain(pg, reservation, receipt) is True
    assert _retain(pg, reservation, receipt) is True  # an identical retry is acknowledged
    assert (
        _retain(pg, reservation, {**receipt, "nextStep": f"Delete {_resource_group()} now"})
        is False
    )
    status, erasure = pg.execute(
        "SELECT status, backend_metadata->'erasure' FROM personal_agent_registry WHERE user_id=%s",
        (OWNER,),
    )[0]
    assert status == "suspended" and erasure == {**reservation, "ownerAccessErasure": receipt}


@pytest.mark.parametrize(
    "mutation",
    [
        lambda r: {**r, "subscriptionId": "33333333-3333-3333-3333-333333333333"},
        lambda r: {
            **r,
            "remainingResources": [*r["remainingResources"], "/subscriptions/x/resourceGroups/y"],
        },
        lambda r: {**r, "agentErased": {**r["agentErased"], "erased": False}},
        lambda r: {**r, "agentErased": {**r["agentErased"], "attemptId": "attempt-2"}},
        lambda r: {**r, "agentErased": {**r["agentErased"], "serviceUid": "replaced"}},
        lambda r: {**r, "keyVault": {**r["keyVault"], "purgeProtection": False}},
        lambda r: {**r, "extra": "field"},
        lambda r: {k: v for k, v in r.items() if k != "nextStep"},
    ],
)
@_needs_pg
def test_a_receipt_that_does_not_describe_this_agent_is_refused(pg, mutation):
    reservation = _reserve(pg)
    assert _retain(pg, reservation, mutation(_receipt())) is False


@_needs_pg
def test_only_an_owner_azure_reservation_takes_the_receipt(pg):
    reservation = _reserve(pg, target="user_gcp")
    assert _retain(pg, reservation, _receipt()) is False


@_needs_pg
def test_the_guard_refuses_a_direct_write_of_an_invalid_receipt(pg):
    _reserve(pg)
    with pytest.raises(psycopg2.errors.InsufficientPrivilege):
        pg.execute(
            "UPDATE personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,"
            "'{erasure,ownerAccessErasure}','{\"version\":1}'::jsonb,true) WHERE user_id=%s",
            (OWNER,),
        )


@_needs_pg
def test_the_rollback_round_trips_and_refuses_to_drop_a_retained_receipt(pg):
    pg.apply_file(ROLLBACK)
    assert (
        pg.execute("SELECT to_regprocedure('public.valid_erasure_owner_access(jsonb,jsonb)')")[0][0]
        is None
    )
    pg.apply_file(MIGRATION)
    reservation = _reserve(pg)
    assert _retain(pg, reservation, _receipt()) is True
    with pytest.raises(psycopg2.errors.RaiseException, match="reconciled before rollback"):
        pg.apply_file(ROLLBACK)
