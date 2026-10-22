"""Parked review is the same occurrence; lease rotation grants no effect authority."""

import asyncio
from copy import deepcopy
from dataclasses import replace
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.pod_mcp_pending import PodMcpPendingStore
from hushh_mcp.services.pod_scheduled_continuation import ScheduledTaskCheckpointStorage
from hushh_mcp.services.pod_scheduled_contracts import ScheduledContinuation, ScheduleRefused
from hushh_mcp.services.pod_scheduled_lease import ScheduledExecutionLease
from tests.test_pod_scheduled_authority import admitted_task as admitted_task
from tests.test_pod_scheduled_authority import hub_key as hub_key
from tests.test_pod_scheduled_continuation import first_native_review, native_review
from tests.test_pod_scheduled_tasks import schedule_request
from tests.test_pod_scheduled_tasks import scheduled_tasks as scheduled_tasks


@pytest.fixture
async def parked_task(admitted_task):
    from hushh_mcp.one_adk.scheduled_session_service import (
        ScheduledSessionService,
        pending_confirmations,
    )

    task = admitted_task
    created = await task.runtime.create(
        schedule_request(
            request_id="parked-reclaim",
            capability="agent_one.execute_task.v1",
            first_run_at=task.clock[0] + 1,
            authorization_expires_at=task.clock[0] + 500,
        ),
        grant={"subject_id": task.subject.subject_id, "version": 1},
    )
    task.clock[0] += 2
    claimed = await task.runtime.runner._claim(*task.runtime.delivery.offer.call_args.args[:3], 10)
    lease = ScheduledExecutionLease(task.runtime.journal, claimed)
    task.lease, task.invocation = lease, task.invocation.grants.invocation(lease)
    storage = ScheduledTaskCheckpointStorage(task.runtime.journal, claimed, lease.check)
    world = SimpleNamespace(
        task=task,
        storage=storage,
        pending=PodMcpPendingStore(storage),
        sessions=ScheduledSessionService(storage),
    )
    native = native_review(world)
    async with native.runner:
        checkpoint = await first_native_review(world, native)
    handle, confirmation = next(
        iter(
            pending_confirmations(
                checkpoint.session, checkpoint.pending, storage.invocation_id
            ).items()
        )
    )
    pending = checkpoint.pending[handle]
    continuation = ScheduledContinuation(
        handle,
        confirmation,
        {
            "pendingHandle": handle,
            "toolName": pending["tool_name"],
            "connectorId": pending["review"]["connectorId"],
            "directiveId": pending["review"]["directiveId"],
            "receipt": "a" * 32,
        },
    )
    task.clock[0] += 3
    await storage.park()
    await task.runtime.runner._settle(created["id"], claimed["last_run"]["id"], "needs_review")
    permit = SimpleNamespace(release=AsyncMock())
    task.runtime.runner.admission = SimpleNamespace(acquire_turn=AsyncMock(return_value=permit))
    cap = task.runtime.capabilities["agent_one.execute_task.v1"]
    cap.check_continuation, cap.continue_claimed = AsyncMock(), AsyncMock(return_value="completed")
    return SimpleNamespace(world=world, continuation=continuation, permit=permit, cap=cap)


async def _continue(parked, *, continuation=None, revision=None, caller_grant=None):
    task = parked.world.task
    row = await task.runtime.get(task.lease.claimed["id"])
    return await task.runtime.runner.continue_review(
        row["id"],
        revision or row["revision"],
        row["last_run"]["id"],
        continuation or parked.continuation,
        caller_check=AsyncMock(),
        caller_grant=caller_grant or {"subject_id": task.subject.subject_id, "version": 1},
    )


async def test_exact_reclaim_rotates_once_and_excludes_parked_wait_from_active_budget(parked_task):
    parked, task = parked_task, parked_task.world.task
    original = deepcopy(task.lease.claimed)
    revision = (await task.runtime.get(original["id"]))["revision"]
    task.clock[0] += 30  # Original 10-second execution segment is long past.
    result = await _continue(parked)
    lease, continuation = parked.cap.continue_claimed.await_args.args
    assert continuation == parked.continuation
    assert lease.claimed["last_run"]["id"] == original["last_run"]["id"]
    assert lease.claimed["last_run"]["claim_id"] != original["last_run"]["claim_id"]
    assert lease.claimed["checkpoint"]["claim_id"] == lease.claimed["last_run"]["claim_id"]
    assert lease.claimed["last_run"]["active_seconds"] == 3
    assert lease.claimed["last_run"]["deadline_at"] == task.clock[0] + 7
    assert lease.claimed["terms"] == original["terms"]
    assert result["state"] == "completed"
    parked.permit.release.assert_awaited_once()
    with pytest.raises(ScheduleRefused, match="CONTINUATION_CHANGED"):
        await _continue(parked, revision=revision)
    parked.cap.continue_claimed.assert_awaited_once()


@pytest.mark.parametrize(
    "changed", ["marker", "terms", "expired", "dispatching", "running", "model", "budget"]
)
async def test_reclaim_refuses_changed_or_uncertain_authority_before_effect(parked_task, changed):
    parked, task = parked_task, parked_task.world.task
    continuation = parked.continuation
    if changed == "marker":
        continuation = replace(continuation, confirmation_id="another-marker")
    elif changed == "terms":
        continuation = replace(
            continuation, approval={**continuation.approval, "toolName": "changed"}
        )
    elif changed == "expired":
        task.clock[0] += 400  # Review expires before the original schedule grant.
    elif changed == "model":
        parked.cap.check_continuation.side_effect = ScheduleRefused("SCHEDULE_MODEL_CHANGED")
    else:

        def edit(rows):
            row = rows[task.lease.claimed["id"]]
            row["revision"] += 1
            if changed == "budget":
                row["last_run"]["finished_at"] = row["last_run"]["deadline_at"]
                task.clock[0] = row["last_run"]["deadline_at"] + 1
            elif changed == "dispatching":
                row["checkpoint"].update(
                    phase="dispatching", dispatch_handle=continuation.pending_handle
                )
            else:
                row["state"] = row["last_run"]["state"] = "running"
            return row

        await task.runtime.journal.change(edit)
    with pytest.raises(ScheduleRefused):
        await _continue(parked, continuation=continuation)
    parked.cap.continue_claimed.assert_not_awaited()
    # Failed preflight or failed CAS never leaks the acquired update permit.
    assert (
        parked.permit.release.await_count == task.runtime.runner.admission.acquire_turn.await_count
    )


async def test_exact_continuation_also_requires_the_current_callers_scopes(parked_task):
    from tests.test_pod_session_authority import Subject, _binding

    task = parked_task.world.task
    caller = Subject("under-scoped-caller", "web")
    await task.world.admit(caller, _binding(caller, scopes=["pod.act"]))
    with pytest.raises(ScheduleRefused, match="SCHEDULE_GRANT_REFUSED"):
        await _continue(parked_task, caller_grant={"subject_id": caller.subject_id, "version": 1})
    parked_task.cap.continue_claimed.assert_not_awaited()
    task.runtime.runner.admission.acquire_turn.assert_not_awaited()


async def test_old_segment_cannot_settle_the_reclaimed_occurrence(parked_task):
    task = parked_task.world.task
    old = task.lease.claimed

    async def continue_current(lease, _continuation):
        with pytest.raises(ScheduleRefused, match="SCHEDULE_SETTLEMENT_CLAIM_CHANGED"):
            await task.runtime.runner._settle(
                old["id"],
                old["last_run"]["id"],
                "completed",
                claim_id=old["last_run"]["claim_id"],
            )
        await lease.check()
        return "completed"

    parked_task.cap.continue_claimed.side_effect = continue_current
    assert (await _continue(parked_task))["state"] == "completed"


@pytest.mark.parametrize("during_admission", [False, True])
async def test_review_expiry_is_precise_and_rechecked_after_awaited_admission(
    parked_task, during_admission
):
    parked, task = parked_task, parked_task.world.task
    start = task.clock[0]
    expiry = datetime.fromtimestamp(start + 0.5, UTC).isoformat()

    def edit(rows):
        row = rows[task.lease.claimed["id"]]
        value = row["checkpoint"]["pending"][parked.continuation.pending_handle]
        value["expires_at"] = value["review"]["expiresAt"] = expiry
        row["revision"] += 1
        return row

    await task.runtime.journal.change(edit)
    if during_admission:
        calls = 0

        async def delayed_admission(_row):
            nonlocal calls
            calls += 1
            if calls == 2:
                task.clock[0] = start + 0.9

        parked.cap.check_continuation.side_effect = delayed_admission
    else:
        task.clock[0] = start + 0.9
    with pytest.raises(ScheduleRefused, match="SCHEDULE_REVIEW_EXPIRED"):
        await _continue(parked)
    assert (await task.runtime.get(task.lease.claimed["id"]))["last_run"][
        "claim_id"
    ] == task.lease.claimed["last_run"]["claim_id"]
    parked.cap.continue_claimed.assert_not_awaited()


async def test_original_authorization_expiry_during_admission_leaves_review_parked(parked_task):
    parked, task = parked_task, parked_task.world.task
    expires = datetime.fromtimestamp(task.clock[0] + 1000, UTC).isoformat()

    def edit(rows):
        row = rows[task.lease.claimed["id"]]
        value = row["checkpoint"]["pending"][parked.continuation.pending_handle]
        value["expires_at"] = value["review"]["expiresAt"] = expires
        row["revision"] += 1
        return row

    await task.runtime.journal.change(edit)
    calls = 0

    async def delayed_admission(row):
        nonlocal calls
        calls += 1
        if calls == 2:
            task.clock[0] = row["authorization_expires_at"] + 0.1

    parked.cap.check_continuation.side_effect = delayed_admission
    with pytest.raises(ScheduleRefused, match="SCHEDULE_AUTHORIZATION_HORIZON_REFUSED"):
        await _continue(parked)
    row = (await task.runtime.journal.snapshot())[0][task.lease.claimed["id"]]
    assert row["state"] == "needs_review"
    assert row["last_run"]["claim_id"] == task.lease.claimed["last_run"]["claim_id"]
    parked.cap.continue_claimed.assert_not_awaited()


@pytest.mark.parametrize("stage", ["settlement", "permit"])
async def test_cancelled_caller_retains_terminal_reconciliation_and_permit_release(
    scheduled_tasks, stage
):
    world = scheduled_tasks
    await world.runtime.create(schedule_request(), grant={"subject_id": "browser", "version": 1})
    delivery = world.delivery.offer.call_args.args
    world.clock[0] = 1101
    entered, release = asyncio.Event(), asyncio.Event()
    if stage == "settlement":
        original = world.runtime.runner._settle
        calls = 0

        async def settle(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                entered.set()
                await release.wait()
            return await original(*args, **kwargs)

        world.runtime.runner._settle = settle
    else:

        async def release_permit():
            entered.set()
            await release.wait()

        world.permit.release.side_effect = release_permit
    running = asyncio.create_task(world.runtime.run(*delivery[:3]))
    await asyncio.wait_for(entered.wait(), 2)
    running.cancel()
    with pytest.raises(asyncio.CancelledError):
        await running
    release.set()
    await asyncio.gather(*world.runtime.runner._cleanup.values())
    await asyncio.sleep(0)
    assert not world.runtime.runner._cleanup
    world.permit.release.assert_awaited_once()
    state = (await world.runtime.get(delivery[0]))["last_run"]["state"]
    assert state == ("outcome_uncertain" if stage == "settlement" else "completed")
