"""Reconcile failed/pending native bootstrap effects before managed erasure."""

from copy import deepcopy

import pytest
from psycopg2.errors import InsufficientPrivilege

from hushh_mcp.services.hosted_pod_journal import HostedPodJournal
from hushh_mcp.services.user_gcp_bootstrap import UserGcpBootstrap
from tests.fixtures.hosted_prefix_abort import binding_results, retire_prefix
from tests.test_hosted_pilot_admission_postgres import _Client


def bootstrap_calls(fixture):
    bootstrap = fixture.plan["federation"]["impersonation"]["bootstrap_service_account"]
    return UserGcpBootstrap(
        project=fixture.project, region=fixture.region, bootstrap_sa=bootstrap
    ).plan_calls(fixture.plan)


async def publish_next(fixture, journal, *, result=None):
    attempt = fixture.row()["backend_metadata"]["provisionAttempt"]
    prior = attempt["evidence"]["reserved"].get("hostedCheckpoint", {})
    completed = deepcopy(prior.get("completed", []))
    generation = prior.get("generation", 0)
    call = bootstrap_calls(fixture)[len(completed)]
    cp = {
        "version": 1,
        "ownerId": fixture.owner,
        "attemptId": attempt["attemptId"],
        "planDigest": attempt["hostedAdmission"]["bootstrapContractHash"],
        "step": call["step"],
        "phase": "intent",
        "expectedGeneration": generation,
        "generation": generation + 1,
        "completed": completed,
    }
    assert await journal.publish(
        kind="bootstrap", owner_id=fixture.owner, attempt_id=attempt["attemptId"], checkpoint=cp
    )
    if result is None:
        return cp
    observed = {
        **cp,
        "phase": "observed",
        "expectedGeneration": generation + 1,
        "generation": generation + 2,
        "completed": completed + [result],
    }
    assert await journal.publish(
        kind="bootstrap",
        owner_id=fixture.owner,
        attempt_id=attempt["attemptId"],
        checkpoint=observed,
    )
    return observed


def assert_reservation_refused(fixture):
    with pytest.raises(InsufficientPrivilege, match="reconciliation"):
        fixture.pg.execute(
            "SELECT reserve_personal_agent_erasure(%s,%s)", (fixture.owner, fixture.erase)
        )
    assert "erasure" not in fixture.row()["backend_metadata"]


async def reconcile_pending_resource(fixture):
    client = _Client(fixture.pg)
    try:
        journal = HostedPodJournal(client)
        cp = await publish_next(fixture, journal)
        assert cp["step"] == "artifact_repo"
        assert_reservation_refused(fixture)
        result = {
            "step": cp["step"],
            "status": 200,
            "ok": True,
            "resourceObservation": fixture.observations["artifact_repository"],
        }
        observed = {
            **cp,
            "phase": "observed",
            "expectedGeneration": cp["generation"],
            "generation": cp["generation"] + 1,
            "completed": cp["completed"] + [result],
        }
        assert await journal.publish(
            kind="bootstrap",
            owner_id=fixture.owner,
            attempt_id=fixture.provision["attemptId"],
            checkpoint=observed,
        )
        fixture.pg.execute(
            "SELECT reserve_personal_agent_erasure(%s,%s)", (fixture.owner, fixture.erase)
        )
        assert fixture.native_inventory()["resources"]
    finally:
        client._engine.dispose()


async def failed_prefix(fixture, *, status=403):
    client = _Client(fixture.pg)
    try:
        call = bootstrap_calls(fixture)[
            len(
                fixture.row()["backend_metadata"]["provisionAttempt"]["evidence"]["reserved"][
                    "hostedCheckpoint"
                ]["completed"]
            )
        ]
        observed = await publish_next(
            fixture,
            HostedPodJournal(client),
            result={"step": call["step"], "status": status, "ok": False},
        )
        return observed, call
    finally:
        client._engine.dispose()


def finish_failed_prefix(fixture, observed, call):
    pg = fixture.pg
    assert pg.execute(
        "SELECT publish_personal_agent_provision(%s,%s,'reserved','failed','{}'::jsonb)",
        (fixture.owner, fixture.provision["attemptId"]),
    )[0][0]
    pg.execute("SELECT reserve_personal_agent_erasure(%s,%s)", (fixture.owner, fixture.erase))
    frozen = fixture.reservation()["registrySnapshot"]["backend_metadata"]["provisionAttempt"]
    assert frozen["evidence"]["reserved"]["hostedCheckpoint"] == observed
    number = frozen["hostedAdmission"]["assignment"]["projectNumber"]
    fixture.failed_binding_checks = [
        {
            "failedStep": call["step"],
            "failedStatus": 403,
            **{key: binding[key] for key in ("policyResource", "role", "member")},
            "projectNumber": number,
            "httpStatus": 200,
            "present": False,
            "status": "confirmed_absent",
        }
        for binding in binding_results(call, number)
    ]
    inventory = fixture.native_inventory()
    assert inventory["failedBindingChecks"] or any(
        item["disposition"] == "confirmed_absent" for item in inventory["resources"]
    )
    assert not fixture.retain_abort("inventory", "", "admission", inventory, owner="owner-b")
    for code in (200, 403, 500):
        broken = deepcopy(inventory)
        resource = next(
            (item for item in broken["resources"] if item["disposition"] == "confirmed_absent"),
            None,
        )
        if resource:
            resource["absence"]["httpStatus"] = code
        else:
            broken["failedBindingChecks"][0]["present"] = True
        assert not fixture.retain_abort("inventory", "", "admission", broken)
    for resource in inventory["resources"]:
        if resource["disposition"] != "confirmed_absent":
            continue
        broken = deepcopy(inventory)
        target = next(item for item in broken["resources"] if item["id"] == resource["id"])
        target.pop("failedStep")
        target.pop("failedStatus")
        target["disposition"] = "not_created"
        assert not fixture.retain_abort("inventory", "", "admission", broken)
        target.update(
            disposition="created", identity=fixture.observations[target["type"]]["identity"]
        )
        target.pop("absence")
        assert not fixture.retain_abort("inventory", "", "admission", broken)
    fixture.freeze_inventory()
    fixture.erase_prefix_items(inventory)
    assert not pg.execute("SELECT personal_agent_erasure_complete(%s)", (fixture.owner,))[0][0]
    retire_prefix(fixture)
    assert pg.execute("SELECT personal_agent_erasure_complete(%s)", (fixture.owner,))[0][0]
    retained = fixture.reservation()["registrySnapshot"]["backend_metadata"]["provisionAttempt"]
    assert retained["evidence"]["reserved"]["hostedCheckpoint"] == observed


def _creation_receipt(reservation):
    assignment = reservation["hostedAdmission"]["assignment"]
    return {
        "step": "create_project",
        "status": 200,
        "ok": True,
        "resourceObservation": {
            "type": "gcp_project",
            "id": assignment["project"],
            "disposition": "created",
            "identity": {
                "projectId": assignment["project"],
                "projectNumber": assignment["projectNumber"],
                "lifecycleState": "ACTIVE",
                "parent": {"type": "folder", "id": "123456789"},
                "labels": {
                    "created-by": "hussh-one",
                    "tenancy": "hussh-hosted",
                    "hussh-environment": "dev",
                    "hussh-provision-attempt": reservation["attemptId"],
                },
            },
        },
    }
