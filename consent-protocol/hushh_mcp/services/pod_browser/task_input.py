"""Accepted owner Browser input, separate from task discovery and approval waits."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from .consent import private_commitment
from .contracts import BrowserAction, BrowserRefused
from .task_contracts import BrowserOwnerAccess, BrowserTaskSnapshot
from .task_state import BrowserTaskState

if TYPE_CHECKING:
    from .task_runtime import BrowserTaskRuntime


async def submit_owner_input(
    runtime: BrowserTaskRuntime, access: BrowserOwnerAccess, task_id: str, action: BrowserAction
) -> BrowserTaskSnapshot:
    """Accept one input; the existing cloud delivery owns its execution.

    Return before a website review waits. The owner can discover/confirm
    that exact review through the same task while the input remains parked.
    A repeated transport request joins its commitment, never types twice.
    """
    task = await runtime._task(access, task_id)
    commitment = private_commitment(runtime._request_key, action.model_dump(mode="json"))
    async with task.operation:
        if task.input_worker is not None and not task.input_worker.done():
            if task.input_commitment != commitment:
                raise BrowserRefused("BROWSER_INPUT_PENDING")
            return runtime._snapshot(task)
        control = task.control
        if control is None or control.control_owner != "owner":
            raise BrowserRefused("BROWSER_OWNER_CONTROL_REQUIRED")
        if (action.sequence, action.control_epoch) != (
            control.next_sequence,
            control.control_epoch,
        ):
            raise BrowserRefused("BROWSER_ACTION_REPLAY")
        task.input_commitment = commitment
        task.input_worker = asyncio.create_task(
            _run_input(runtime, task, access, action), name="owner-browser-input"
        )
        task.revision += 1
    # Fast inputs normally settle in this request. A review/slow page must
    # return promptly so another owner request can inspect and approve it.
    await asyncio.wait({task.input_worker}, timeout=0.15)
    return runtime._snapshot(task)


async def _run_input(
    runtime: BrowserTaskRuntime,
    task: BrowserTaskState,
    access: BrowserOwnerAccess,
    action: BrowserAction,
) -> None:
    try:
        await runtime.input(access, task.binding.task_id, action)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        if not task.closed and task.closing is None:
            code = exc.code if isinstance(exc, BrowserRefused) else "BROWSER_INPUT_UNCONFIRMED"
            await runtime._lifecycle.close(task, phase="unavailable", code=code)
    finally:
        task.input_commitment = None
        if not task.closed and task.closing is None:
            task.revision += 1


async def execute_owner_input(
    runtime: BrowserTaskRuntime, access: BrowserOwnerAccess, task_id: str, action: BrowserAction
) -> BrowserTaskSnapshot:
    task = await runtime._task(access, task_id)
    async with task.operation:
        if task.closed or task.control is None:
            raise BrowserRefused("BROWSER_CONTROL_UNAVAILABLE")
        if action.operation == "resize" and task.review is not None:
            raise BrowserRefused("BROWSER_REVIEW_PENDING")
        control = task.control
    # BrowserControl serializes input and checks sequence/epoch at dispatch.
    # Do not hold task metadata/review coordination while a website waits.
    try:
        await control.execute(action, actor="owner")
    except BaseException:
        if not task.closed and task.closing is None:
            if control.outcome_uncertain:
                task.phase, task.code = "outcome_uncertain", "BROWSER_OUTCOME_UNCERTAIN"
                await runtime._checkpoint(task)
                await runtime._lifecycle.close(task)
        raise
    if not task.closed and task.closing is None:
        await runtime._checkpoint(task)
    return runtime._snapshot(task)
