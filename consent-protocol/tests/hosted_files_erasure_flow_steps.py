"""Bounded assertion stages for the Hosted Files erasure regression cases."""

from __future__ import annotations

import json
from datetime import datetime, timedelta

import pytest

from hushh_mcp.services.pod_update_identity import release_identity
from tests.hosted_files_erasure_support import (
    _provider_settlement,
)


async def _assert_executor_session_and_competing_claim(pg, fixture, state) -> dict:
    from hushh_mcp.services.pod_files.hosted_executor import HostedFilesExecutorError

    await state.executor.confirm_claim()
    identity = await state.executor.session_identity()
    witness = state.row["backend_metadata"]["hostedFilesExecutor"]
    assert witness["sourceImage"] == state.target
    assert witness["deployedImage"] == state.deployed_image
    assert witness["sourceImage"] != witness["deployedImage"]
    assert witness["backendPid"] == identity["pid"]
    assert datetime.fromisoformat(witness["backendStart"]) == identity["backend_start"]
    assert await state.executor.session_lock_held(witness)
    stale_start = (identity["backend_start"] - timedelta(seconds=1)).isoformat()
    assert not await state.executor.session_lock_held({**witness, "backendStart": stale_start})
    assert not await state.executor.session_lock_held(
        {**witness, "backendPid": identity["pid"] + 1}
    )
    await state.executor.confirm_claim()
    await state.executor.confirm_claim()
    assert (
        pg.execute(
            "SELECT count(*) FROM pg_locks WHERE pid=%s AND locktype='advisory' "
            "AND mode='ExclusiveLock' AND granted AND objsubid=1 "
            "AND classid=((hashtextextended(%s,206)>>32)&4294967295)::oid "
            "AND objid=(hashtextextended(%s,206)&4294967295)::oid",
            (identity["pid"], fixture.owner, fixture.owner),
        )[0][0]
        == 1
    )
    current = await state.repo.get(fixture.owner)
    with pytest.raises(HostedFilesExecutorError, match="claim was refused"):
        await state.repo.begin_hosted_files_executor(
            user_id=fixture.owner,
            observed=current,
            target_image=state.target,
            operation_id=state.approval["operationId"],
            plan=state.plan.model_dump(),
            incarnation=state.plan.serviceUid,
            deployed_image=state.deployed_image,
        )
    return witness


async def _assert_service_role_cannot_mutate_executor(pg, fixture, state, witness) -> dict:
    pg.execute("SET ROLE service_role")
    try:
        assert pg.execute("SELECT current_user")[0][0] == "service_role"
        assert (
            pg.execute(
                "SELECT public.finish_hosted_files_executor(%s,%s,%s)",
                (fixture.owner, witness["executionId"], state.lease),
            )[0][0]
            is False
        )
        forged = pg.execute(
            "SELECT backend_metadata FROM personal_agent_registry WHERE user_id=%s",
            (fixture.owner,),
        )[0][0]
        refusals = (
            (
                "INSERT INTO public.personal_agent_registry "
                "(user_id,hushh_id,status,backend_metadata,pod_pubkey,"
                "pod_signing_key_id,pod_signing_pubkey) "
                "VALUES (%s,%s,'provisioned',%s::jsonb,'synthetic-public',%s,%s)",
                (
                    fixture.owner + "-forged",
                    "ha1_forged_hosted_files",
                    json.dumps({"hostedFilesExecutor": {"phase": "exited"}}),
                    "pods_" + "e" * 32,
                    "A" * 43 + "=",
                ),
            ),
            (
                "UPDATE personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,"
                "'{hostedFilesExecutor,phase}','\"exited\"'::jsonb) WHERE user_id=%s",
                (fixture.owner,),
            ),
            (
                "UPDATE personal_agent_registry SET backend_metadata=backend_metadata-"
                "'hostedFilesExecutor' WHERE user_id=%s",
                (fixture.owner,),
            ),
            (
                "UPDATE personal_agent_registry SET deployment_target='user_gcp' WHERE user_id=%s",
                (fixture.owner,),
            ),
            ("DELETE FROM personal_agent_registry WHERE user_id=%s", (fixture.owner,)),
            (
                "INSERT INTO public.personal_agent_registry "
                "SELECT (jsonb_populate_record(NULL::public.personal_agent_registry,"
                "jsonb_set(to_jsonb(registry),"
                "'{backend_metadata,hostedFilesExecutor,phase}','\"exited\"'::jsonb))).* "
                "FROM personal_agent_registry registry WHERE user_id=%s "
                "ON CONFLICT(user_id) DO UPDATE SET backend_metadata=EXCLUDED.backend_metadata",
                (fixture.owner,),
            ),
        )
        for sql, params in refusals:
            with pytest.raises(Exception, match="hosted Files executor evidence invalid"):
                pg.execute(sql, params)
        return forged
    finally:
        pg.execute("RESET ROLE")


async def _finish_executor_and_assert_exit(pg, fixture, state, witness, forged) -> None:
    assert forged["hostedFilesExecutor"]["phase"] == "running"
    await state.executor.finish()
    final = await state.repo.get(fixture.owner)
    assert final["backend_metadata"]["hostedFilesExecutor"]["phase"] == "exited"
    assert not pg.execute(
        "SELECT public.hosted_files_executor_session_active(%s)", (fixture.owner,)
    )[0][0]


async def _record_successful_provider_ack(pg, fixture, state):
    from psycopg2.errors import InsufficientPrivilege
    from sqlalchemy.exc import ProgrammingError

    binding = pg.execute(
        "SELECT backend_metadata->'upgradeLeaseHost' = "
        "public.personal_agent_upgrade_lease_host_binding(to_jsonb(registry)) "
        "FROM personal_agent_registry AS registry WHERE user_id=%s",
        (fixture.owner,),
    )[0][0]
    assert binding is True
    for sql in (
        "UPDATE personal_agent_registry SET model_credential_mode='user_adc' WHERE user_id=%s",
        "UPDATE personal_agent_registry SET liveness_mode='economy' WHERE user_id=%s",
    ):
        with pytest.raises(InsufficientPrivilege, match="hosted Files executor evidence invalid"):
            pg.execute(sql, (fixture.owner,))

    await state.executor.record_replacement_intent(
        operation_id=state.approval["operationId"], predecessor=state.predecessor
    )
    settlement = _provider_settlement(state)
    await state.executor.record_provider_settlement(settlement)
    live_row = await state.repo.get(fixture.owner)
    live_metadata = dict(live_row["backend_metadata"])
    acknowledgement = {
        "version": 1,
        "generation": settlement["generation"],
        "attemptId": settlement["attemptId"],
        "serviceUid": settlement["serviceUid"],
        "service": settlement["service"],
        "image": settlement["image"],
        "targetImage": settlement["targetImage"],
        "operationId": state.approval["operationId"],
        "releaseId": state.approval["releaseId"],
        "podIncarnation": state.plan.serviceUid,
        "targetDigest": settlement["targetDigest"],
        "sourceImage": settlement["sourceImage"],
        "sourceDigest": settlement["sourceDigest"],
        "deployedImage": settlement["deployedImage"],
        "predecessor": state.predecessor,
        "outcome": "ready",
    }
    succeeded_approval = {
        **live_metadata["upgradeApproval"],
        "status": "succeeded",
        "operationState": "succeeded",
    }
    with_ack = {
        **live_metadata,
        "upgradeAcknowledgement": acknowledgement,
        "upgradeApproval": succeeded_approval,
    }
    assert await state.repo.record_image_upgrade(
        user_id=fixture.owner,
        observed=live_row,
        expected_lease=state.lease,
        previous_metadata=live_metadata,
        retain_lease=True,
        backend_metadata=with_ack,
    )
    without_binding = {
        key: value
        for key, value in with_ack.items()
        if key not in {"upgradeLease", "upgradeLeaseHost"}
    }
    with pytest.raises(ProgrammingError, match="hosted Files executor evidence invalid"):
        await state.repo.record_image_upgrade(
            user_id=fixture.owner,
            observed=await state.repo.get(fixture.owner),
            expected_lease=state.lease,
            previous_metadata=with_ack,
            retain_lease=False,
            backend_metadata=without_binding,
        )
    running = await state.repo.get(fixture.owner)
    assert running["backend_metadata"]["hostedFilesExecutor"]["phase"] == "running"
    assert running["backend_metadata"]["upgradeLease"] == state.lease
    return settlement


async def _finish_and_settle_success(pg, fixture, state, settlement):
    from sqlalchemy.exc import ProgrammingError

    await state.executor.finish()
    completed_row = await state.repo.get(fixture.owner)
    previous = dict(completed_row["backend_metadata"])
    published = dict(previous)
    published.pop("upgradeLease", None)
    published.pop("upgradeLeaseHost", None)
    no_ack = dict(published)
    no_ack.pop("upgradeAcknowledgement", None)
    with pytest.raises(ProgrammingError, match="hosted Files executor evidence invalid"):
        await state.repo.record_image_upgrade(
            user_id=fixture.owner,
            observed=completed_row,
            expected_lease=state.lease,
            previous_metadata=previous,
            retain_lease=False,
            backend_metadata=no_ack,
        )
    still_reserved = await state.repo.get(fixture.owner)
    assert still_reserved["backend_metadata"]["upgradeLease"] == state.lease
    assert await state.repo.record_image_upgrade(
        user_id=fixture.owner,
        observed=completed_row,
        expected_lease=state.lease,
        previous_metadata=previous,
        retain_lease=False,
        backend_metadata=published,
    )
    installed = await state.repo.get(fixture.owner)
    assert installed["backend_metadata"].get("upgradeLease") is None
    assert installed["backend_metadata"]["hostedFilesExecutor"]["providerSettlement"] == settlement
    reservation = {
        "version": 1,
        "phase": "reserved",
        "ownerId": fixture.owner,
        "hushhId": state.plan.hushhId,
        "attemptId": "post-success-erasure",
        "registrySnapshot": installed,
    }
    assert pg.execute(
        "SELECT public.hosted_files_queue_erasure_settled(%s::jsonb)",
        (json.dumps(reservation, default=str),),
    )[0][0]
    return installed


async def _claim_next_executor_after_success(fixture, state, installed):
    plan = state.plan.model_copy(update={"templateDigest": "c" * 64})
    approval = {
        **state.approval,
        "operationId": "approved-files-operation-next",
        "idempotencyKey": "synthetic-owner-approval-next",
        "releaseId": release_identity(
            plan.hushhId, plan.serviceUid, state.target, capability_digest=plan.digest
        ),
        "capabilityPlan": plan.model_dump(),
        "capabilityPlanDigest": plan.digest,
    }
    assert await state.repo.record_upgrade_approval(user_id=fixture.owner, approval=approval)
    executor = await state.repo.begin_hosted_files_executor(
        user_id=fixture.owner,
        observed=await state.repo.get(fixture.owner),
        target_image=state.target,
        operation_id=approval["operationId"],
        plan=plan.model_dump(),
        incarnation=plan.serviceUid,
        deployed_image=state.deployed_image,
    )
    assert executor.lease and executor.lease != state.lease
    current = await state.repo.get(fixture.owner)
    assert current["backend_metadata"]["hostedFilesExecutor"]["releaseId"] == approval["releaseId"]
    await executor.finish()
    return executor


async def _assert_failure_settlement_negatives(pg, fixture, state, settlement, witness, intent):
    invalid_settlements = (
        {**settlement, "service": "wrong-service"},
        {**settlement, "latestReadyRevision": settlement["revision"]},
        {**settlement, "sourceImage": "gcr.io/other-project/app@sha256:" + "b" * 64},
        {**settlement, "sourceDigest": "sha256:" + "c" * 64},
        {
            **settlement,
            "deployedImage": "us-central1-docker.pkg.dev/other-project/app@sha256:" + "b" * 64,
        },
        {
            **settlement,
            "terminalCondition": {
                "type": "Ready",
                "state": "CONDITION_FAILED",
                "reason": "WAITING_FOR_OPERATION",
            },
        },
        {**settlement, "predecessor": {**state.predecessor, "generation": 8}},
    )
    for changed in invalid_settlements:
        assert not pg.execute(
            "SELECT public.valid_hosted_files_provider_settlement(%s,%s,%s::jsonb,%s::jsonb,%s::jsonb)",
            (
                fixture.owner,
                state.plan.hushhId,
                json.dumps(witness),
                json.dumps(changed),
                json.dumps(intent),
            ),
        )[0][0]


async def _retain_failure_ack_before_exit(state, settlement, live_row):
    acknowledgement = {
        "version": 1,
        "outcome": "failed",
        "generation": settlement["generation"],
        "observedGeneration": settlement["observedGeneration"],
        "attemptId": settlement["attemptId"],
        "serviceUid": settlement["serviceUid"],
        "service": settlement["service"],
        "image": settlement["image"],
        "targetImage": settlement["targetImage"],
        "targetDigest": settlement["targetDigest"],
        "sourceImage": settlement["sourceImage"],
        "sourceDigest": settlement["sourceDigest"],
        "deployedImage": settlement["deployedImage"],
        "operationId": state.approval["operationId"],
        "releaseId": state.approval["releaseId"],
        "podIncarnation": state.plan.serviceUid,
        "predecessor": state.predecessor,
        "revision": settlement["revision"],
        "ready": False,
        "terminalFailure": settlement,
    }
    metadata = dict(live_row["backend_metadata"])
    approval = {**metadata["upgradeApproval"], "status": "failed", "operationState": "failed"}
    with_ack = {**metadata, "upgradeAcknowledgement": acknowledgement, "upgradeApproval": approval}
    assert await state.repo.record_image_upgrade(
        user_id=state.plan.ownerId,
        observed=live_row,
        expected_lease=state.lease,
        previous_metadata=metadata,
        retain_lease=True,
        backend_metadata=with_ack,
    )
    retained = await state.repo.get(state.plan.ownerId)
    assert retained["backend_metadata"]["upgradeLease"] == state.lease


async def _release_failed_after_exit(state, settlement):
    await state.executor.finish()
    exited = await state.repo.get(state.plan.ownerId)
    previous = dict(exited["backend_metadata"])
    cleared = dict(previous)
    cleared.pop("upgradeLease")
    cleared.pop("upgradeLeaseHost")
    assert await state.repo.record_image_upgrade(
        user_id=state.plan.ownerId,
        observed=exited,
        expected_lease=state.lease,
        previous_metadata=previous,
        retain_lease=False,
        backend_metadata=cleared,
    )
    final = await state.repo.get(state.plan.ownerId)
    assert final["backend_metadata"].get("upgradeLease") is None
    assert final["backend_metadata"]["hostedFilesExecutor"]["providerSettlement"] == settlement
    assert final["backend_metadata"]["upgradeAcknowledgement"]["terminalFailure"] == settlement


__all__ = [
    "_assert_executor_session_and_competing_claim",
    "_assert_service_role_cannot_mutate_executor",
    "_finish_executor_and_assert_exit",
    "_record_successful_provider_ack",
    "_finish_and_settle_success",
    "_claim_next_executor_after_success",
    "_assert_failure_settlement_negatives",
    "_retain_failure_ack_before_exit",
    "_release_failed_after_exit",
]
