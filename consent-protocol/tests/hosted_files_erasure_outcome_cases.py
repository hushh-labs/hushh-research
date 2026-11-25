"""Provider settlement and erasure ordering PostgreSQL cases."""

from __future__ import annotations

import hashlib
import json

import pytest

from tests.fixtures.hosted_erasure import admitted_erasure as admitted_erasure
from tests.hosted_files_erasure_flow_steps import (
    _assert_failure_settlement_negatives,
    _claim_next_executor_after_success,
    _finish_and_settle_success,
    _record_successful_provider_ack,
    _release_failed_after_exit,
    _retain_failure_ack_before_exit,
)
from tests.hosted_files_erasure_support import (
    _claim_dedicated_files,
    _provider_failure_settlement,
    _provider_settlement,
)
from tests.test_hosted_pilot_admission_postgres import ROOT as ROOT


@pytest.mark.asyncio
async def test_hosted_files_erasure_waits_for_original_exit_and_provider_ack(
    hosted_pg, monkeypatch
):
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    async for fixture, client in admitted_erasure(hosted_pg, reserve=False):
        hosted_pg.apply_file(ROOT / "db/migrations/parked/979_hosted_files_executor.sql")
        state = await _claim_dedicated_files(fixture, client)
        try:
            await state.executor.record_replacement_intent(
                operation_id=state.approval["operationId"], predecessor=state.predecessor
            )
            assert hosted_pg.execute(
                "SELECT reserve_personal_agent_erasure(%s,%s)",
                (fixture.owner, fixture.erase),
            )[0][0]
            reservation = fixture.reservation()
            assert not hosted_pg.execute(
                "SELECT hosted_files_queue_erasure_settled(%s::jsonb)",
                (json.dumps(reservation),),
            )[0][0]
            acknowledgement = {
                "version": 1,
                "generation": 2,
                "attemptId": hashlib.sha256(state.lease.encode()).hexdigest(),
                "serviceUid": state.plan.serviceUid,
                "service": state.plan.service,
                "image": state.deployed_image,
                "targetImage": state.target,
                "operationId": state.approval["operationId"],
                "releaseId": state.approval["releaseId"],
                "podIncarnation": state.plan.serviceUid,
                "targetDigest": state.target.rsplit("@", 1)[-1],
                "sourceImage": state.target,
                "sourceDigest": state.target.rsplit("@", 1)[-1],
                "deployedImage": state.deployed_image,
                "predecessor": state.predecessor,
            }
            assert await state.repo.retain_erasure_upgrade_ack(
                user_id=fixture.owner, lease=state.lease, receipt=acknowledgement
            )
            reservation = fixture.reservation()
            assert not hosted_pg.execute(
                "SELECT hosted_files_queue_erasure_settled(%s::jsonb)",
                (json.dumps(reservation),),
            )[0][0]
            await state.executor.record_provider_settlement(_provider_settlement(state))
            reservation = fixture.reservation()
            assert not hosted_pg.execute(
                "SELECT hosted_files_queue_erasure_settled(%s::jsonb)",
                (json.dumps(reservation),),
            )[0][0]
            await state.executor.finish()
            reservation = fixture.reservation()
            assert reservation["lateFilesExecutorExit"]["phase"] == "exited"
            assert hosted_pg.execute(
                "SELECT hosted_files_queue_erasure_settled(%s::jsonb)",
                (json.dumps(reservation),),
            )[0][0]
            archive = hosted_pg.execute(
                "SELECT public.personal_agent_erasure_archive(%s::jsonb,%s::jsonb)",
                (json.dumps(reservation), "{}"),
            )[0][0]
            executor_receipt = archive["receipts"]["hostedFilesExecutor"]
            assert executor_receipt["providerSettlement"] == _provider_settlement(state)
            assert (
                executor_receipt["providerAcknowledgement"]["attemptId"]
                == acknowledgement["attemptId"]
            )
            assert not hosted_pg.execute(
                "SELECT personal_agent_erasure_complete(%s)", (fixture.owner,)
            )[0][0]
        finally:
            if not state.executor.closed:
                await state.executor.close()


@pytest.mark.asyncio
async def test_hosted_files_success_settles_erasure_and_allows_next_executor(
    hosted_pg, monkeypatch
):
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    async for fixture, client in admitted_erasure(hosted_pg, reserve=False):
        hosted_pg.apply_file(ROOT / "db/migrations/parked/979_hosted_files_executor.sql")
        hosted_pg.apply_file(
            ROOT / "db/migrations/parked/980_personal_agent_upgrade_host_binding.sql"
        )
        state = await _claim_dedicated_files(fixture, client)
        next_executor = None
        try:
            settlement = await _record_successful_provider_ack(hosted_pg, fixture, state)
            installed = await _finish_and_settle_success(hosted_pg, fixture, state, settlement)
            next_executor = await _claim_next_executor_after_success(fixture, state, installed)
        finally:
            if next_executor is not None and not next_executor.closed:
                await next_executor.close()
            if not state.executor.closed:
                await state.executor.close()


@pytest.mark.asyncio
async def test_hosted_files_proven_provider_failure_settles_only_after_joined_exit(
    hosted_pg, monkeypatch
):
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    async for fixture, client in admitted_erasure(hosted_pg, reserve=False):
        hosted_pg.apply_file(ROOT / "db/migrations/parked/979_hosted_files_executor.sql")
        hosted_pg.apply_file(
            ROOT / "db/migrations/parked/980_personal_agent_upgrade_host_binding.sql"
        )
        state = await _claim_dedicated_files(fixture, client)
        try:
            await state.executor.record_replacement_intent(
                operation_id=state.approval["operationId"], predecessor=state.predecessor
            )
            settlement = _provider_failure_settlement(state)
            await state.executor.record_provider_settlement(settlement)
            live_row = await state.repo.get(fixture.owner)
            witness = live_row["backend_metadata"]["hostedFilesExecutor"]
            await _assert_failure_settlement_negatives(
                hosted_pg, fixture, state, settlement, witness, witness["replacementIntent"]
            )
            await _retain_failure_ack_before_exit(state, settlement, live_row)
            await _release_failed_after_exit(state, settlement)
        finally:
            if not state.executor.closed:
                await state.executor.close()


__all__ = [
    "test_hosted_files_erasure_waits_for_original_exit_and_provider_ack",
    "test_hosted_files_success_settles_erasure_and_allows_next_executor",
    "test_hosted_files_proven_provider_failure_settles_only_after_joined_exit",
]
