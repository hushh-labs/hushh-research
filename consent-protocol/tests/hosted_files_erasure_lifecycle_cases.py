"""Lease settlement and rollback PostgreSQL cases."""

from __future__ import annotations

import hashlib
import json

import pytest

from tests.fixtures.hosted_erasure import admitted_erasure as admitted_erasure
from tests.hosted_files_erasure_support import (
    _claim_dedicated_files,
    _hosted_files_rollback_sources,
)
from tests.test_hosted_pilot_admission_postgres import ROOT as ROOT


@pytest.mark.asyncio
async def test_hosted_files_joined_no_dispatch_can_clear_exact_lease(hosted_pg, monkeypatch):
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    async for fixture, client in admitted_erasure(hosted_pg, reserve=False):
        hosted_pg.apply_file(ROOT / "db/migrations/parked/979_hosted_files_executor.sql")
        hosted_pg.apply_file(
            ROOT / "db/migrations/parked/980_personal_agent_upgrade_host_binding.sql"
        )
        state = await _claim_dedicated_files(fixture, client)
        try:
            witness = state.row["backend_metadata"]["hostedFilesExecutor"]
            assert witness["dispatchState"] == "not_submitted"
            await state.executor.finish()
            exited = await state.repo.get(fixture.owner)
            previous = dict(exited["backend_metadata"])
            cleared = dict(previous)
            cleared.pop("upgradeLease")
            cleared.pop("upgradeLeaseHost")
            assert await state.repo.record_image_upgrade(
                user_id=fixture.owner,
                observed=exited,
                expected_lease=state.lease,
                previous_metadata=previous,
                retain_lease=False,
                backend_metadata=cleared,
            )
            installed = await state.repo.get(fixture.owner)
            assert installed["backend_metadata"].get("upgradeLease") is None
            assert installed["backend_metadata"]["hostedFilesExecutor"]["dispatchState"] == (
                "not_submitted"
            )
        finally:
            if not state.executor.closed:
                await state.executor.close()


@pytest.mark.asyncio
async def test_hosted_files_dispatch_intent_prevents_no_dispatch_clear(hosted_pg, monkeypatch):
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
            await state.executor.finish()
            exited = await state.repo.get(fixture.owner)
            previous = dict(exited["backend_metadata"])
            cleared = dict(previous)
            cleared.pop("upgradeLease")
            cleared.pop("upgradeLeaseHost")
            with pytest.raises(Exception, match="hosted Files executor evidence invalid"):
                await state.repo.record_image_upgrade(
                    user_id=fixture.owner,
                    observed=exited,
                    expected_lease=state.lease,
                    previous_metadata=previous,
                    retain_lease=False,
                    backend_metadata=cleared,
                )
            still_reserved = await state.repo.get(fixture.owner)
            assert still_reserved["backend_metadata"]["upgradeLease"] == state.lease
        finally:
            if not state.executor.closed:
                await state.executor.close()


@pytest.mark.asyncio
async def test_hosted_files_no_dispatch_rejects_same_attempt_ack(hosted_pg, monkeypatch):
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    async for fixture, client in admitted_erasure(hosted_pg, reserve=False):
        hosted_pg.apply_file(ROOT / "db/migrations/parked/979_hosted_files_executor.sql")
        state = await _claim_dedicated_files(fixture, client)
        try:
            await state.executor.finish()
            exited = await state.repo.get(fixture.owner)
            metadata = dict(exited["backend_metadata"])
            metadata["upgradeAcknowledgement"] = {
                "attemptId": hashlib.sha256(state.lease.encode()).hexdigest(),
                "outcome": "ready",
            }
            tampered = {**exited, "backend_metadata": metadata}
            assert not hosted_pg.execute(
                "SELECT public.valid_hosted_files_no_dispatch(%s::jsonb,%s::jsonb)",
                (
                    json.dumps(tampered, default=str),
                    json.dumps(metadata["hostedFilesExecutor"]),
                ),
            )[0][0]
        finally:
            if not state.executor.closed:
                await state.executor.close()


@pytest.mark.asyncio
async def test_hosted_files_delete_preserves_unsettled_executor_evidence(hosted_pg, monkeypatch):
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    async for fixture, client in admitted_erasure(hosted_pg, reserve=False):
        hosted_pg.apply_file(ROOT / "db/migrations/parked/979_hosted_files_executor.sql")
        state = await _claim_dedicated_files(fixture, client)
        try:
            await state.executor.record_replacement_intent(
                operation_id=state.approval["operationId"], predecessor=state.predecessor
            )
            await state.executor.finish()
            for reserved in (False, True):
                if reserved:
                    assert hosted_pg.execute(
                        "SELECT reserve_personal_agent_erasure(%s,%s)",
                        (fixture.owner, fixture.erase),
                    )[0][0]
                with pytest.raises(Exception, match="hosted Files executor evidence invalid"):
                    hosted_pg.execute(
                        "DELETE FROM public.personal_agent_registry WHERE user_id=%s",
                        (fixture.owner,),
                    )
                if reserved:
                    hosted_pg.execute("ROLLBACK")
        finally:
            if not state.executor.closed:
                await state.executor.close()


@pytest.mark.asyncio
async def test_lost_hosted_files_executor_session_remains_unresolved(hosted_pg, monkeypatch):
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    async for fixture, client in admitted_erasure(hosted_pg, reserve=False):
        hosted_pg.apply_file(ROOT / "db/migrations/parked/979_hosted_files_executor.sql")
        state = await _claim_dedicated_files(fixture, client)
        witness = state.row["backend_metadata"]["hostedFilesExecutor"]
        await state.executor.close()
        assert not hosted_pg.execute(
            "SELECT public.hosted_files_executor_session_active(%s)", (fixture.owner,)
        )[0][0]
        assert hosted_pg.execute(
            "SELECT reserve_personal_agent_erasure(%s,%s)",
            (fixture.owner, fixture.erase),
        )[0][0]
        assert not hosted_pg.execute(
            "SELECT public.finish_hosted_files_executor(%s,%s,%s)",
            (fixture.owner, witness["executionId"], state.lease),
        )[0][0]
        reservation = fixture.reservation()
        assert not hosted_pg.execute(
            "SELECT hosted_files_queue_erasure_settled(%s::jsonb)",
            (json.dumps(reservation),),
        )[0][0]


@pytest.mark.asyncio
async def test_hosted_files_executor_rollback_restores_exact_predecessor_functions(
    hosted_pg, monkeypatch
):
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    async for _fixture, _client in admitted_erasure(hosted_pg, reserve=False):
        before = _hosted_files_rollback_sources(hosted_pg)
        hosted_pg.apply_file(ROOT / "db/migrations/parked/979_hosted_files_executor.sql")
        assert hosted_pg.execute(
            "SELECT to_regclass('public.hosted_files_executor_976_rollback_source') IS NOT NULL"
        )[0][0]
        hosted_pg.apply_file(ROOT / "db/migrations/rollback/979_hosted_files_executor.rollback.sql")
        assert _hosted_files_rollback_sources(hosted_pg) == before
        assert hosted_pg.execute(
            "SELECT to_regclass('public.hosted_files_executor_976_rollback_source') IS NULL "
            "AND to_regprocedure('public.begin_hosted_files_executor(text,jsonb,jsonb,timestamptz,"
            "timestamptz,jsonb,text,text,text,jsonb,text,text)') IS NULL"
        )[0][0]


@pytest.mark.asyncio
async def test_hosted_files_executor_rollback_refuses_retained_executor_evidence(
    hosted_pg, monkeypatch
):
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    async for fixture, client in admitted_erasure(hosted_pg, reserve=False):
        hosted_pg.apply_file(ROOT / "db/migrations/parked/979_hosted_files_executor.sql")
        state = await _claim_dedicated_files(fixture, client)
        try:
            with pytest.raises(Exception, match="evidence requires forward recovery"):
                hosted_pg.apply_file(
                    ROOT / "db/migrations/rollback/979_hosted_files_executor.rollback.sql"
                )
            hosted_pg.execute("ROLLBACK")
            assert hosted_pg.execute(
                "SELECT public.hosted_files_executor_session_active(%s)", (fixture.owner,)
            )[0][0]
            assert (await state.repo.get(fixture.owner))["backend_metadata"]["hostedFilesExecutor"][
                "phase"
            ] == "running"
            await state.executor.finish()
        finally:
            if not state.executor.closed:
                await state.executor.close()


__all__ = [
    "test_hosted_files_joined_no_dispatch_can_clear_exact_lease",
    "test_hosted_files_dispatch_intent_prevents_no_dispatch_clear",
    "test_hosted_files_no_dispatch_rejects_same_attempt_ack",
    "test_hosted_files_delete_preserves_unsettled_executor_evidence",
    "test_lost_hosted_files_executor_session_remains_unresolved",
    "test_hosted_files_executor_rollback_restores_exact_predecessor_functions",
    "test_hosted_files_executor_rollback_refuses_retained_executor_evidence",
]
