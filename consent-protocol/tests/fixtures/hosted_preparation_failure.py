"""Failed preparation cleanup retains failure and demands independent native absence."""

import json
from copy import deepcopy

import pytest
from psycopg2.errors import InsufficientPrivilege

from hushh_mcp.services.hosted_pod_journal import HostedPodJournal
from tests.fixtures.hosted_prefix_abort import project_wide_memory_absence
from tests.hosted_pod_support import prepared_project_journal
from tests.test_hosted_pilot_admission_postgres import ROOT, _claim, _Client, _policy
from tests.test_hosted_pod_bootstrap_postgres import _approved_bootstrap


async def verify_failed_preparation_cleanup(
    pg, step, status, *, failed_phase=False, native_case=None
):
    for number in (956, 957, 960, 961, 962, 963, 964, 972):
        pg.apply_file(next((ROOT / "db/migrations/parked").glob(f"{number}_*.sql")))
    pg.apply_file(ROOT / "db/migrations/parked/974_hosted_pod_custody.sql")
    _policy(pg, bootstrap=_approved_bootstrap, preparation=True)
    client = _Client(pg)
    try:
        journal = HostedPodJournal(client)
        attempt = await prepared_project_journal(
            pg, _claim(pg), client, steps=1 if step == "link_billing" else 2
        )
        prior = attempt["evidence"]["reserved"]["hostedPreparation"]
        checkpoint = {
            **prior,
            "phase": "intent",
            "step": step,
            "expectedGeneration": prior["generation"],
            "generation": prior["generation"] + 1,
        }
        assert await journal.publish(
            kind="preparation",
            owner_id="owner-a",
            attempt_id=attempt["attemptId"],
            checkpoint=checkpoint,
        )
        with pytest.raises(InsufficientPrivilege, match="reconciliation"):
            pg.execute("SELECT reserve_personal_agent_erasure('owner-a','cleanup')")
        completed = prior["completed"] + [{"step": step, "status": status, "ok": False}]
        observed = {
            **checkpoint,
            "phase": "observed",
            "completed": completed,
            "expectedGeneration": checkpoint["generation"],
            "generation": checkpoint["generation"] + 1,
        }
        assert await journal.publish(
            kind="preparation",
            owner_id="owner-a",
            attempt_id=attempt["attemptId"],
            checkpoint=observed,
        )
        if failed_phase:
            assert pg.execute(
                "SELECT publish_personal_agent_provision(%s,%s,'reserved','failed','{}'::jsonb)",
                ("owner-a", attempt["attemptId"]),
            )[0][0]
        if status >= 500:
            with pytest.raises(InsufficientPrivilege, match="reconciliation"):
                pg.execute("SELECT reserve_personal_agent_erasure('owner-a','cleanup')")
            return
        reservation = pg.execute("SELECT reserve_personal_agent_erasure('owner-a','cleanup')")[0][0]
        assert (
            reservation["registrySnapshot"]["backend_metadata"]["provisionAttempt"]["evidence"][
                "reserved"
            ]["hostedPreparation"]
            == observed
        )
        coordinates = pg.execute(
            "SELECT managed_preparation_cleanup_coordinates(%s::jsonb)",
            (json.dumps(reservation),),
        )[0][0]
        assert coordinates["failedPreparation"] == {"step": step, "status": status}
        assert (
            pg.execute("SELECT erasure_private_coordinates(%s::jsonb)", (json.dumps(reservation),))[
                0
            ][0]
            is None
        )
        if native_case is None:
            await verify_receipts(pg, journal, reservation, coordinates)
        else:
            from tests.fixtures.hosted_preparation_operator import verify_preparation_operator

            await verify_preparation_operator(pg, client, reservation, coordinates, native_case)
    finally:
        client._engine.dispose()


async def verify_receipts(pg, journal, reservation, coordinates):
    project, number = coordinates["project"], coordinates["projectNumber"]
    bootstrap = coordinates["bootstrap"]
    base = {
        "ownerId": "owner-a",
        "attemptId": "cleanup",
        "project": project,
        "projectNumber": number,
        "operatorPrincipal": coordinates["operatorPrincipal"],
    }
    proof = preparation_absence_proof(coordinates)
    admission = {**base, "status": "admitted", "failureReconciliation": proof}

    async def retain(value, expected=reservation, stage="admission", owner="owner-a"):
        return await journal.retain_managed_cleanup(
            owner_id=owner, reservation=expected, kind="preparation", stage=stage, receipt=value
        )

    assert not await retain({**base, "status": "admitted"})
    assert not await retain(admission, owner="owner-b")
    # A retained native failure alone cannot prove its mutations absent.
    variants = [
        ("bootstrapIdentity", "httpStatus", 200),
        ("bootstrapIdentity", "httpStatus", 403),
        ("projectIam", "bindings", [{"role": "roles/owner"}]),
        ("projectIam", "httpStatus", 403),
        ("projectIam", "complete", False),
        ("billingObservation", "projectId", "foreign-project"),
        ("resourceInventory", "cloud_run_jobs", [{"name": "unexpected-job"}]),
        ("resourceInventory", "soft_deleted_buckets", [{"name": "retained-bucket"}]),
        ("noMemory", "coverage", []),
    ]
    for section, field, value in variants:
        broken = deepcopy(admission)
        broken["failureReconciliation"][section][field] = value
        assert not await retain(broken)
    assert await retain(admission)
    assert await retain(admission)  # Exact idempotent retry only.
    current = pg.execute(
        "SELECT backend_metadata->'erasure' FROM personal_agent_registry WHERE user_id='owner-a'"
    )[0][0]
    assert not await retain({**base, "status": "acknowledged"}, stage="acknowledgement")
    assert await retain({**base, "status": "acknowledged"}, current, stage="acknowledgement")
    current = pg.execute(
        "SELECT backend_metadata->'erasure' FROM personal_agent_registry WHERE user_id='owner-a'"
    )[0][0]
    identity = {**coordinates["projectIdentity"], "lifecycleState": "DELETE_REQUESTED"}
    deletion = {
        **base,
        "status": "retirement_pending_provider_purge",
        "projectIdentity": identity,
        "billingObservation": proof["billingObservation"],
        "bootstrapIdentity": {"email": bootstrap, "status": "observed_absent"},
        "resourceInventory": {
            key: []
            for key in (
                "cloud_run_services",
                "buckets",
                "kms_keys",
                "secrets",
                "memory_banks",
                "connector_credentials",
            )
        },
    }
    assert await retain(deletion, current, stage="deletion")
    assert not pg.execute("SELECT personal_agent_erasure_complete('owner-a')")[0][0]
    # Project retirement is not account erasure; the unrelated gate remains required.


def preparation_absence_proof(coordinates):
    project, number = coordinates["project"], coordinates["projectNumber"]
    bootstrap = coordinates["bootstrap"]
    return {
        "failedPreparation": coordinates["failedPreparation"],
        "billingObservation": {
            "projectId": project,
            "billingAccountName": "",
            "billingEnabled": False,
        },
        "bootstrapIdentity": {
            "name": f"projects/{project}/serviceAccounts/{bootstrap}",
            "projectNumber": number,
            "httpStatus": 404,
            "status": "observed_absent",
        },
        "projectIam": {
            "project": project,
            "projectNumber": number,
            "httpStatus": 200,
            "member": f"serviceAccount:{bootstrap}",
            "bindings": [],
            "complete": True,
        },
        "resourceInventory": {
            key: []
            for key in (
                "cloud_run_services",
                "cloud_run_jobs",
                "buckets",
                "soft_deleted_buckets",
                "kms_keys",
                "secrets",
            )
        },
        "noMemory": project_wide_memory_absence(number, coordinates["region"]),
    }
