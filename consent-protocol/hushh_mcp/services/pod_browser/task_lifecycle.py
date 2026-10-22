"""Joined execution, expiry and shutdown for one Browser task.

This owner seals terminal state and clears private references before releasing
update admission. BrowserTaskRuntime retains authenticated owner operations.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

from hushh_mcp.one_adk.computer_use_agent import BrowserTaskResultV1

from .contracts import BrowserRefused
from .control import BrowserControl
from .task_contracts import (
    BrowserCapability,
    BrowserLauncherPort,
    BrowserModelPort,
    BrowserReviewAuthorityPort,
    BrowserTaskSnapshot,
    Phase,
)
from .task_state import BrowserTaskState


class BrowserTaskLifecycle:
    def __init__(
        self,
        *,
        launcher: BrowserLauncherPort,
        model: BrowserModelPort,
        reviews: BrowserReviewAuthorityPort,
        clock: Callable[[], float],
        capability: Callable[[], BrowserCapability],
        draining: Callable[[], bool],
        checkpoint: Callable[[BrowserTaskState], Awaitable[None]],
        snapshot: Callable[[BrowserTaskState], BrowserTaskSnapshot],
    ) -> None:
        self._launcher, self._model, self._reviews, self._clock = launcher, model, reviews, clock
        self._capability, self._draining = capability, draining
        self._checkpoint, self._snapshot = checkpoint, snapshot

    async def run(self, task: BrowserTaskState) -> None:
        close = False
        try:
            if (
                task.processing is None
                or task.consent is None
                or task.authority is None
                or task.request is None
            ):
                raise BrowserRefused("BROWSER_TASK_COMPOSITION_UNAVAILABLE")
            await task.processing.require()  # approve provider/screens before allocating a worker
            task.processing_approved = True
            if task.closed or task.closing is not None or self._draining():
                return
            if task.control is None:
                async with asyncio.timeout(30):
                    executor = await self._launcher.launch(
                        task.binding,
                        allowed_origins=task.request.allowed_origins,
                        consent=task.consent,
                        authority=task.authority,
                    )
                task.control = BrowserControl(
                    binding=task.binding,
                    readiness=self._launcher.readiness,
                    executor=executor,
                    authority=task.authority,
                    wall_clock=self._clock,
                )
                await task.control.initialize()
            await task.control.require_model_observation()
            task.phase, task.code = "running", None
            result = await self._model.run(
                control=task.control, processing=task.processing, goal=task.request.goal
            )
            if task.closing is not None:
                return
            result = BrowserTaskResultV1.model_validate(result)
            await task.control.require_model_observation()
            task.phase, task.summary = result.outcome, result.summary
            if (
                task.phase == "completed"
                and task.control.downloads
                and task.control.downloads.offers
            ):
                task.model_completed = True
                task.phase, task.code = "needs_owner", "BROWSER_DOWNLOAD_READY"
            # A completed task is terminal in the owner interface. Release its
            # browser now, rather than retaining invisible compute until idle.
            close = task.phase in {"completed", "unavailable", "outcome_uncertain", "cancelled"}
            if not close:
                await self._checkpoint(task)
        except asyncio.CancelledError:
            # Takeover fences the epoch before cancelling the provider task.
            # A dispatch cancelled in-flight is fenced uncertain by BrowserControl.
            if task.control and task.control.outcome_uncertain:
                task.phase, task.code = "outcome_uncertain", "BROWSER_OUTCOME_UNCERTAIN"
                await self._checkpoint(task)
            raise
        except Exception as exc:
            if task.closing is not None:
                return
            from hushh_mcp.runtime_providers.dependency_health import is_resource_exhausted

            code = (
                exc.code
                if isinstance(exc, BrowserRefused)
                else "BROWSER_MODEL_RATE_LIMITED"
                if is_resource_exhausted(exc)
                else "BROWSER_TASK_UNAVAILABLE"
            )
            if code in {"BROWSER_MODEL_STOP_UNCONFIRMED", "BROWSER_LAUNCH_STOP_UNCONFIRMED"}:
                task.stop_refusal = code
            task.code = code
            if task.control and task.control.outcome_uncertain:
                task.phase = "outcome_uncertain"
            elif code in {
                "BROWSER_OWNER_APPROVAL_REQUIRED",
                "BROWSER_MODEL_OBSERVATION_PAUSED",
                "BROWSER_CONTINUATION_REQUIRED",
            }:
                task.phase = "needs_owner"
            else:
                task.phase = "unavailable"
            close = task.phase in {"unavailable", "outcome_uncertain"}
            if not close:
                await self._checkpoint(task)
        # A failed shutdown remains repairable; do not catch and retry our own
        # failure as though it were another model error.
        if close:
            await self.close(task)

    async def monitor(self, task: BrowserTaskState) -> None:
        try:
            while not task.closed:
                await asyncio.sleep(1)
                if task.closed or task.access is None:
                    return
                try:
                    await task.access.check()
                    if not self._capability().available:
                        raise BrowserRefused("BROWSER_QUALIFICATION_ENDED")
                    if task.binding.expires_at <= self._clock():
                        raise BrowserRefused("BROWSER_AUTHORIZATION_EXPIRED")
                    if task.control and await task.control.close_if_idle():
                        raise BrowserRefused("BROWSER_IDLE_CLOSED")
                except Exception:
                    await self.close(task, phase="cancelled", code="BROWSER_AUTHORIZATION_ENDED")
                    return
        except asyncio.CancelledError:
            raise

    async def cancel_worker(
        self, task: BrowserTaskState, *, except_task: asyncio.Task | None = None
    ) -> None:
        worker = task.worker
        if worker and worker not in {asyncio.current_task(), except_task} and not worker.done():
            worker.cancel()
            try:
                async with asyncio.timeout(15):
                    await worker
            except asyncio.CancelledError:
                pass
            except TimeoutError:
                task.stop_refusal = "BROWSER_MODEL_STOP_UNCONFIRMED"
                raise BrowserRefused("BROWSER_MODEL_STOP_UNCONFIRMED") from None

    async def close(
        self, task: BrowserTaskState, *, phase: Phase | None = None, code: str | None = None
    ) -> None:
        # Join the same terminal write/review release across owner cancellation,
        # expiry and update drain. Caller cancellation cannot cancel teardown.
        if task.closing is None or (task.closing.done() and not task.closed):
            if task.closed:
                return
            if phase is not None and task.close_payload is None:
                task.phase, task.code = phase, code
            task.closing = asyncio.create_task(
                self._close_once(task, asyncio.current_task()), name="owner-browser-close"
            )
        await asyncio.shield(task.closing)

    async def _close_once(self, task: BrowserTaskState, initiator: asyncio.Task | None) -> None:
        if task.closed:
            return
        # Close is out-of-band. The update permit remains held until shutdown
        # and pending-provider termination both acknowledge success.
        try:
            if task.close_payload is None:
                await self._quiesce(task, initiator)
                task.revision += 1
            task.closed, task.review = True, None
            await self._checkpoint(task)  # sealed shutdown state precedes any update idle receipt
        except BaseException:
            task.closed = False
            task.review = None
            if task.close_payload is None:
                task.revision += 1
                task.code = task.stop_refusal or "BROWSER_CLOSE_UNCONFIRMED"
                task.phase = (
                    "outcome_uncertain"
                    if task.control and task.control.outcome_uncertain
                    else "unavailable"
                )
            raise BrowserRefused(task.stop_refusal or "BROWSER_CLOSE_UNCONFIRMED") from None
        # Keep only the terminal owner-visible result and a keyed deduplication
        # commitment. The original session closure captures a bearer credential.
        # Successful teardown must release it, the private goal and all ports.
        task.detach_terminal(self._snapshot(task))
        task.close_payload = None
        await task.permit.release()
        task.finished.set()

    async def _quiesce(self, task: BrowserTaskState, initiator: asyncio.Task | None) -> None:
        stop = asyncio.create_task(task.control.stop()) if task.control else None
        try:
            # Begin the epoch fence first, then cancel calls that may hold the
            # control lock while awaiting owner approval. Waiting for stop's
            # lock before cancelling those calls deadlocks the approval path.
            await asyncio.sleep(0)
            starting = task.starting
            if starting is not None and starting is not initiator and not starting.done():
                starting.cancel()
                await asyncio.gather(starting, return_exceptions=True)
            input_worker = task.input_worker
            if (
                input_worker is not None
                and input_worker is not initiator
                and not input_worker.done()
            ):
                input_worker.cancel()
                await asyncio.gather(input_worker, return_exceptions=True)
            await self.cancel_worker(task, except_task=initiator)
        finally:
            if stop is not None:
                async with asyncio.timeout(35):
                    await asyncio.shield(stop)
        monitor = task.monitor
        saving = task.save_worker
        if saving is not None and saving is not initiator and not saving.done():
            # Stop has already terminated Browser. Join the owner's admitted
            # Files write before dropping custody/update permits; don't cancel
            # a provider write whose durable outcome must be reconciled.
            try:
                async with asyncio.timeout(60):
                    await asyncio.shield(saving)
            except TimeoutError:
                raise BrowserRefused("BROWSER_DOWNLOAD_SAVE_UNCONFIRMED") from None
            except asyncio.CancelledError:
                if not saving.cancelled():
                    raise
            except Exception:
                pass  # exact created-file identity survives for read-only reconciliation
        if monitor and monitor is not initiator:
            monitor.cancel()
            try:
                await monitor
            except asyncio.CancelledError:
                pass
        if task.stop_refusal:
            raise BrowserRefused(task.stop_refusal)
        if task.control and task.control.outcome_uncertain:
            task.phase, task.code = "outcome_uncertain", "BROWSER_OUTCOME_UNCERTAIN"
        release_model = getattr(self._model, "release_task", None)
        if release_model is not None:
            await release_model(task.binding)
        await self._reviews.release(task.binding)
