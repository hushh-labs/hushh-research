"""Executor claim and callback-join PostgreSQL cases."""

from __future__ import annotations

import asyncio
from threading import Event

import pytest

from tests.fixtures.hosted_erasure import admitted_erasure as admitted_erasure
from tests.hosted_files_erasure_flow_steps import (
    _assert_executor_session_and_competing_claim,
    _assert_service_role_cannot_mutate_executor,
    _finish_executor_and_assert_exit,
)
from tests.hosted_files_erasure_support import (
    _advance_to_queue,
    _assert_late_evidence,
    _assert_unqualified_work_refused,
    _claim_dedicated_files,
    _claim_files,
)
from tests.test_hosted_pilot_admission_postgres import ROOT as ROOT


@pytest.mark.asyncio
async def test_interrupted_hosted_files_retains_obligations_without_claiming_drain(
    hosted_pg, monkeypatch
):
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    async for fixture, client in admitted_erasure(hosted_pg, reserve=False):
        state = await _claim_files(fixture, client)
        await _assert_unqualified_work_refused(fixture, state, monkeypatch)
        row, intent, completed, call = await _advance_to_queue(fixture, state)
        await _assert_late_evidence(hosted_pg, fixture, state, row, intent, completed, call)


@pytest.mark.asyncio
async def test_hosted_files_executor_uses_one_live_session_and_rejects_competing_claim(
    hosted_pg, monkeypatch
):
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    async for fixture, client in admitted_erasure(hosted_pg, reserve=False):
        hosted_pg.execute(
            "GRANT SELECT,INSERT,UPDATE,DELETE ON public.personal_agent_registry TO service_role"
        )
        hosted_pg.apply_file(ROOT / "db/migrations/parked/979_hosted_files_executor.sql")
        state = await _claim_dedicated_files(fixture, client)
        try:
            witness = await _assert_executor_session_and_competing_claim(hosted_pg, fixture, state)
            forged = await _assert_service_role_cannot_mutate_executor(
                hosted_pg, fixture, state, witness
            )
            await _finish_executor_and_assert_exit(hosted_pg, fixture, state, witness, forged)
        finally:
            if not state.executor.closed:
                await state.executor.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "defect",
    [
        "account_generation",
        "observed_host_tuple",
        "operation",
        "incarnation",
        "target",
        "deployed_image",
    ],
)
async def test_hosted_files_executor_claim_rejects_changed_authority_tuple(
    hosted_pg, monkeypatch, defect
):
    from hushh_mcp.services.pod_files.hosted_executor import HostedFilesExecutorError

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    async for fixture, client in admitted_erasure(hosted_pg, reserve=False):
        hosted_pg.apply_file(ROOT / "db/migrations/parked/979_hosted_files_executor.sql")
        with pytest.raises(HostedFilesExecutorError, match="claim was refused"):
            await _claim_dedicated_files(fixture, client, defect=defect)
        row = hosted_pg.execute(
            "SELECT backend_metadata FROM public.personal_agent_registry WHERE user_id=%s",
            (fixture.owner,),
        )[0][0]
        assert "upgradeLease" not in row
        assert "hostedFilesExecutor" not in row


@pytest.mark.asyncio
async def test_hosted_files_executor_joins_cancelled_blocked_session_callback(
    hosted_pg, monkeypatch
):
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    async for fixture, client in admitted_erasure(hosted_pg, reserve=False):
        hosted_pg.apply_file(ROOT / "db/migrations/parked/979_hosted_files_executor.sql")
        state = await _claim_dedicated_files(fixture, client)
        started, release = Event(), Event()

        def blocked_callback(started=started, release=release):
            started.set()
            if not release.wait(timeout=3):
                raise TimeoutError("test callback was not released")

        pending = asyncio.create_task(state.executor._call(blocked_callback))
        try:
            assert await asyncio.to_thread(started.wait, 1)
            pending.cancel()
            await asyncio.sleep(0.02)
            assert not pending.done()
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await pending
            witness = state.row["backend_metadata"]["hostedFilesExecutor"]
            assert await state.executor.session_lock_held(witness)
            await state.executor.finish()
        finally:
            release.set()
            if not state.executor.closed:
                await state.executor.close()


__all__ = [
    "test_interrupted_hosted_files_retains_obligations_without_claiming_drain",
    "test_hosted_files_executor_uses_one_live_session_and_rejects_competing_claim",
    "test_hosted_files_executor_claim_rejects_changed_authority_tuple",
    "test_hosted_files_executor_joins_cancelled_blocked_session_callback",
]
