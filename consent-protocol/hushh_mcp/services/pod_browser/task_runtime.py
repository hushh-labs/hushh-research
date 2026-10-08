"""One owner browser task lifecycle over qualified execution and existing authority.

There is deliberately no ambient launcher/model/export/approval fallback. Cloud
qualification is trusted startup input. Screens, goals, review terms, selected
values and model events live only in this process; recovery records are sealed
by the existing pod log and never authorize an automatic effect replay.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal
from uuid import uuid4

from hushh_mcp.one_adk.computer_use_agent import BrowserTaskResultV1
from hushh_mcp.services.pod_upgrade_admission import (
    PodUpgradeAdmission,
    PodUpgradeAdmissionRefused,
    TurnPermit,
)

from .consent import BrowserConsentPort
from .contracts import (
    BrowserAction,
    BrowserAuthorityPort,
    BrowserBinding,
    BrowserFrame,
    BrowserRefused,
)
from .control import BrowserControl
from .information import BrowserInformation, BrowserModelProcessing, ConsentedProjectionPort
from .sessions import BrowserSessions
from .task_authority import TaskAuthority, TaskConsent
from .task_contracts import (
    BrowserCapability,
    BrowserLauncherPort,
    BrowserModelPort,
    BrowserOwnerAccess,
    BrowserReviewAuthorityPort,
    BrowserReviewOffer,
    BrowserTaskLogPort,
    BrowserTaskReceipt,
    BrowserTaskRequest,
    BrowserTaskSnapshot,
    Phase,
)

KIND = "browser_task_v1"
_TERMINAL = {"completed", "unavailable", "outcome_uncertain", "cancelled"}


@dataclass
class _Task:
    binding: BrowserBinding
    request: BrowserTaskRequest = field(repr=False)
    access: BrowserOwnerAccess = field(repr=False)
    permit: TurnPermit = field(repr=False)
    consent: TaskConsent | None = field(default=None, repr=False)
    authority: TaskAuthority | None = field(default=None, repr=False)
    control: BrowserControl | None = field(default=None, repr=False)
    processing: BrowserModelProcessing | None = field(default=None, repr=False)
    sessions: BrowserSessions | None = field(default=None, repr=False)
    worker: asyncio.Task | None = field(default=None, repr=False)
    monitor: asyncio.Task | None = field(default=None, repr=False)
    phase: Phase = "running"
    revision: int = 1
    code: str | None = None
    summary: str | None = field(default=None, repr=False)
    review: BrowserReviewOffer | None = field(default=None, repr=False)
    closed: bool = False
    processing_approved: bool = False
    model_stop_unconfirmed: bool = False
    operation: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)


class BrowserTaskRuntime:
    def __init__(
        self,
        *,
        owner_id: str,
        pod_id: str,
        incarnation: str,
        launcher: BrowserLauncherPort,
        model: BrowserModelPort,
        reviews: BrowserReviewAuthorityPort,
        source: ConsentedProjectionPort,
        authority_factory: Callable[[BrowserBinding, BrowserConsentPort], BrowserAuthorityPort],
        log: BrowserTaskLogPort,
        admission: PodUpgradeAdmission,
        sessions_factory: Callable[[BrowserConsentPort], BrowserSessions] | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._owner, self._pod, self._incarnation = owner_id, pod_id, incarnation
        self._launcher, self._model, self._reviews, self._source = launcher, model, reviews, source
        self._authority_factory, self._log, self._admission = authority_factory, log, admission
        self._sessions_factory, self._clock = sessions_factory, clock
        self._tasks: dict[str, _Task] = {}
        self._requests: dict[str, str] = {}
        self._recovered: dict[str, BrowserTaskSnapshot] = {}
        self._lock = asyncio.Lock()
        self._hydrated, self._draining = False, False
        admission.register_drain(incarnation=incarnation, name="pod_browser", callback=self.drain)

    def capability(self) -> BrowserCapability:
        identity = {
            "owner_id": self._owner,
            "pod_id": self._pod,
            "incarnation": self._incarnation,
            "environment": "development",
        }
        if os.getenv("POD_COMPUTER_USE_ENABLED", "").lower() not in {"1", "true"}:
            return BrowserCapability(available=False, code="BROWSER_DISABLED", **identity)
        if self._draining:
            return BrowserCapability(available=False, code="BROWSER_DRAINING", **identity)
        try:
            ready = self._launcher.readiness
            ready.require_ready()
            if (
                ready.model_name != self._model.model_name
                or ready.model_transport != self._model.transport
            ):
                raise BrowserRefused("BROWSER_MODEL_TRANSPORT_UNVERIFIED")
        except BrowserRefused as exc:
            return BrowserCapability(available=False, code=exc.code, **identity)
        return BrowserCapability(
            available=True,
            code="BROWSER_QUALIFIED",
            remembered_sessions_available=self._sessions_factory is not None,
            **identity,
        )

    async def require_owner(self, access: BrowserOwnerAccess) -> None:
        await self._access(access)

    async def delegate(
        self, access: BrowserOwnerAccess, request: BrowserTaskRequest
    ) -> BrowserTaskReceipt:
        """One's trusted invocation seam; native task runs in its own ADK session.

        Information authority does not transfer back to One implicitly. Returning
        a summary or private review values to its provider requires a separate
        scoped export to that actual model/transport.
        """
        snapshot = await self.start(access, request)
        return self.delegation_receipt(snapshot)

    @staticmethod
    def delegation_receipt(snapshot: BrowserTaskSnapshot) -> BrowserTaskReceipt:
        return BrowserTaskReceipt(
            binding=snapshot.binding,
            phase=snapshot.phase,
            revision=snapshot.revision,
            code=snapshot.code,
            review_id=snapshot.review.review_id if snapshot.review else None,
            review_purpose=snapshot.review.purpose if snapshot.review else None,
        )

    async def _access(self, access: BrowserOwnerAccess) -> None:
        if (access.owner_id, access.pod_id, access.incarnation) != (
            self._owner,
            self._pod,
            self._incarnation,
        ) or access.expires_at <= self._clock():
            raise BrowserRefused("BROWSER_OWNER_REFUSED")
        await access.check()
        await self._log.require_open()

    async def _hydrate(self) -> None:
        if self._hydrated:
            return
        records = await self._log.replay()
        if len(records) > 30000:
            raise BrowserRefused("BROWSER_TASK_HISTORY_LIMIT")
        recovered: dict[str, BrowserTaskSnapshot] = {}
        requests: dict[str, str] = {}
        for record in records:
            if record.get("kind") != KIND:
                continue
            try:
                payload = record["payload"]
                if set(payload) != {"request_id", "snapshot"}:
                    raise ValueError
                snapshot = BrowserTaskSnapshot.model_validate_json(json.dumps(payload["snapshot"]))
                if snapshot.binding.owner_id != self._owner or snapshot.binding.pod_id != self._pod:
                    raise ValueError
                request_id = payload["request_id"]
                if not isinstance(request_id, str) or not 8 <= len(request_id) <= 128:
                    raise ValueError
                # Recovery records must never contain frames, goals, values or reviews.
                if (
                    snapshot.summary is not None
                    or snapshot.review is not None
                    or snapshot.approved_origins
                ):
                    raise ValueError
            except (ValueError, KeyError, TypeError):
                raise BrowserRefused("BROWSER_TASK_LOG_INVALID") from None
            prior = recovered.get(snapshot.binding.task_id)
            if prior and snapshot.revision <= prior.revision:
                raise BrowserRefused("BROWSER_TASK_LOG_INVALID")
            recovered[snapshot.binding.task_id] = snapshot
            requests[request_id] = snapshot.binding.task_id
        for task_id, snapshot in recovered.items():
            recovered[task_id] = snapshot.model_copy(
                update={
                    "phase": snapshot.phase if snapshot.phase in _TERMINAL else "outcome_uncertain",
                    "control_owner": "stopped",
                    "code": "BROWSER_TASK_RECOVERED_NO_REPLAY",
                    "revision": snapshot.revision + 1,
                }
            )
        self._recovered, self._requests, self._hydrated = recovered, requests, True

    def _snapshot(self, task: _Task) -> BrowserTaskSnapshot:
        control = task.control
        return BrowserTaskSnapshot(
            binding=task.binding,
            phase=task.phase,
            control_owner=control.control_owner
            if control
            else ("stopped" if task.closed else "agent"),
            control_epoch=control.control_epoch if control else 1,
            next_sequence=control.next_sequence if control else 1,
            revision=task.revision + (control.revision if control else 0),
            capability=self.capability(),
            code=task.code,
            summary=task.summary,
            review=task.review,
            approved_origins=task.request.allowed_origins if task.processing_approved else (),
        )

    async def _checkpoint(self, task: _Task) -> None:
        task.revision += 1
        snapshot = self._snapshot(task).model_copy(
            update={"summary": None, "review": None, "approved_origins": ()}
        )
        await self._log.append(
            KIND,
            {"request_id": task.request.request_id, "snapshot": snapshot.model_dump(mode="json")},
        )

    async def _task(self, access: BrowserOwnerAccess, task_id: str) -> _Task:
        await self._access(access)
        task = self._tasks.get(task_id)
        if task is None:
            raise BrowserRefused("BROWSER_TASK_NOT_FOUND")
        await task.access.check()
        await self._reviews.check_binding(task.binding)
        return task

    async def start(
        self, access: BrowserOwnerAccess, request: BrowserTaskRequest
    ) -> BrowserTaskSnapshot:
        await self._access(access)
        capability = self.capability()
        if not capability.available:
            raise BrowserRefused(capability.code)
        async with self._lock:
            await self._hydrate()
            if self._draining:
                raise BrowserRefused("BROWSER_DRAINING")
            prior_id = self._requests.get(request.request_id)
            if prior_id:
                prior = self._tasks.get(prior_id)
                if prior is None:
                    raise BrowserRefused("BROWSER_TASK_RECOVERY_REQUIRES_OWNER")
                if prior.request != request:
                    raise BrowserRefused("BROWSER_TASK_REQUEST_CONFLICT")
                await prior.access.check()
                return self._snapshot(prior)
            if len(self._tasks) >= 128 or len(self._requests) >= 10000:
                raise BrowserRefused("BROWSER_TASK_LIMIT")
            if any(not task.closed for task in self._tasks.values()):
                raise BrowserRefused("BROWSER_TASK_ACTIVE")
            binding = BrowserBinding(
                owner_id=self._owner,
                pod_id=self._pod,
                incarnation=self._incarnation,
                task_id="browser_" + uuid4().hex,
                environment="development",
                expires_at=min(access.expires_at, int(self._clock()) + 900),
            )
            try:
                permit = await self._admission.acquire_turn(incarnation=self._incarnation)
            except PodUpgradeAdmissionRefused:
                raise BrowserRefused("BROWSER_DRAINING") from None
            task = _Task(binding=binding, request=request, access=access, permit=permit)

            def pending(offer: BrowserReviewOffer) -> None:
                task.review, task.phase, task.code = (
                    offer,
                    "needs_owner",
                    "BROWSER_OWNER_APPROVAL_REQUIRED",
                )
                task.revision += 1

            async def check_runtime() -> None:
                current = self.capability()
                if not current.available:
                    raise BrowserRefused(current.code)

            task.consent = TaskConsent(
                binding, access, self._reviews, pending, self._clock, check_runtime
            )
            authority = self._authority_factory(binding, task.consent)
            pending_check = getattr(authority, "check_no_pending_dispatch", None)
            try:
                if not callable(pending_check):
                    raise BrowserRefused("BROWSER_DISPATCH_RECOVERY_UNAVAILABLE")
                await task.consent.check_binding(binding)
                await pending_check(binding)
                task.authority = TaskAuthority(binding, task.consent, authority)
                task.processing = BrowserModelProcessing(
                    information=BrowserInformation(self._source, task.consent),
                    binding=binding,
                    fields=request.fields,
                    model_name=self._model.model_name,
                    transport=self._model.transport,
                    allowed_origins=request.allowed_origins,
                    task_goal=request.goal,
                )
                if self._sessions_factory:
                    task.sessions = self._sessions_factory(task.consent)
                await self._checkpoint(task)
            except BaseException:
                await permit.release()
                raise
            self._tasks[binding.task_id], self._requests[request.request_id] = task, binding.task_id
            task.worker = asyncio.create_task(self._run(task), name="owner-browser-task")
            task.monitor = asyncio.create_task(self._monitor(task), name="owner-browser-idle")
            return self._snapshot(task)

    async def _run(self, task: _Task) -> None:
        try:
            if task.processing is None or task.consent is None or task.authority is None:
                raise BrowserRefused("BROWSER_TASK_COMPOSITION_UNAVAILABLE")
            await task.processing.require()  # approve provider/screens before allocating a worker
            task.processing_approved = True
            if task.closed or self._draining:
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
            result = BrowserTaskResultV1.model_validate(result)
            await task.control.require_model_observation()
            task.phase, task.summary = result.outcome, result.summary
            if result.outcome in {"unavailable", "outcome_uncertain", "cancelled"}:
                await self._close(task)
            await self._checkpoint(task)
        except asyncio.CancelledError:
            # Takeover fences the epoch before cancelling the provider task.
            # A dispatch cancelled in-flight is fenced uncertain by BrowserControl.
            if task.control and task.control.outcome_uncertain:
                task.phase, task.code = "outcome_uncertain", "BROWSER_OUTCOME_UNCERTAIN"
                await self._checkpoint(task)
            raise
        except Exception as exc:
            code = exc.code if isinstance(exc, BrowserRefused) else "BROWSER_TASK_UNAVAILABLE"
            if code == "BROWSER_MODEL_STOP_UNCONFIRMED":
                task.model_stop_unconfirmed = True
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
            await self._checkpoint(task)
            if task.phase in {"unavailable", "outcome_uncertain"}:
                await self._close(task)

    async def _monitor(self, task: _Task) -> None:
        try:
            while not task.closed:
                await asyncio.sleep(1)
                try:
                    await task.access.check()
                    if not self.capability().available:
                        raise BrowserRefused("BROWSER_QUALIFICATION_ENDED")
                    if task.binding.expires_at <= self._clock():
                        raise BrowserRefused("BROWSER_AUTHORIZATION_EXPIRED")
                    if task.control and await task.control.close_if_idle():
                        raise BrowserRefused("BROWSER_IDLE_CLOSED")
                except Exception:
                    task.phase, task.code = "cancelled", "BROWSER_AUTHORIZATION_ENDED"
                    await self._close(task)
                    await self._checkpoint(task)
                    return
        except asyncio.CancelledError:
            raise

    async def _cancel_worker(self, task: _Task) -> None:
        worker = task.worker
        if worker and worker is not asyncio.current_task() and not worker.done():
            worker.cancel()
            try:
                async with asyncio.timeout(15):
                    await worker
            except asyncio.CancelledError:
                pass
            except TimeoutError:
                task.model_stop_unconfirmed = True
                raise BrowserRefused("BROWSER_MODEL_STOP_UNCONFIRMED") from None

    async def _close(self, task: _Task) -> None:
        if task.closed:
            return
        # Close is out-of-band. The update permit remains held until shutdown
        # and pending-provider termination both acknowledge success.
        try:
            if task.control:
                async with asyncio.timeout(35):
                    await task.control.stop()
            await self._cancel_worker(task)
            if task.model_stop_unconfirmed:
                raise BrowserRefused("BROWSER_MODEL_STOP_UNCONFIRMED")
            if task.control and task.control.outcome_uncertain:
                task.phase, task.code = "outcome_uncertain", "BROWSER_OUTCOME_UNCERTAIN"
            task.closed, task.review = True, None
            task.revision += 1
            await self._checkpoint(task)  # sealed shutdown state precedes any update idle receipt
            await task.permit.release()
        except BaseException:
            task.closed = False
            task.review = None
            task.revision += 1
            task.code = (
                "BROWSER_MODEL_STOP_UNCONFIRMED"
                if task.model_stop_unconfirmed
                else "BROWSER_CLOSE_UNCONFIRMED"
            )
            task.phase = (
                "outcome_uncertain"
                if task.control and task.control.outcome_uncertain
                else "unavailable"
            )
            raise BrowserRefused(task.code) from None
        monitor = task.monitor
        if monitor and monitor is not asyncio.current_task():
            monitor.cancel()

    async def read(self, access: BrowserOwnerAccess, task_id: str) -> BrowserTaskSnapshot:
        await self._access(access)
        async with self._lock:
            await self._hydrate()
        if task_id in self._recovered:
            return self._recovered[task_id]
        task = await self._task(access, task_id)
        return self._snapshot(task)

    async def frame(
        self, access: BrowserOwnerAccess, task_id: str
    ) -> tuple[BrowserTaskSnapshot, BrowserFrame]:
        task = await self._task(access, task_id)
        control = task.control
        if task.closed or control is None or control.control_owner in {"stopped", "uncertain"}:
            raise BrowserRefused("BROWSER_FRAME_UNAVAILABLE")
        frame = control.latest_frame
        if frame is None:
            raise BrowserRefused("BROWSER_FRAME_NOT_READY")
        return self._snapshot(task), frame

    async def control(
        self,
        access: BrowserOwnerAccess,
        task_id: str,
        operation: Literal["takeover", "resume", "cancel"],
        control_epoch: int,
    ) -> BrowserTaskSnapshot:
        task = await self._task(access, task_id)
        async with task.operation:
            control = task.control
            if control_epoch != (control.control_epoch if control else 1):
                raise BrowserRefused("BROWSER_CONTROL_CHANGED")
            if operation == "cancel":
                task.phase, task.code = "cancelled", "BROWSER_OWNER_CANCELLED"
                await self._close(task)
            elif task.closed or control is None:
                raise BrowserRefused("BROWSER_CONTROL_UNAVAILABLE")
            elif operation == "takeover":
                await control.take_control()
                await self._cancel_worker(task)
                task.phase, task.code = "needs_owner", None
            elif operation == "resume":
                if task.processing is None:
                    raise BrowserRefused("BROWSER_TASK_COMPOSITION_UNAVAILABLE")
                await task.processing.require()
                await control.resume_agent()
                task.review, task.phase, task.code = None, "running", None
                task.worker = asyncio.create_task(self._run(task), name="owner-browser-task")
            else:
                raise BrowserRefused("BROWSER_CONTROL_INVALID")
            await self._checkpoint(task)
            return self._snapshot(task)

    async def input(
        self, access: BrowserOwnerAccess, task_id: str, action: BrowserAction
    ) -> BrowserTaskSnapshot:
        task = await self._task(access, task_id)
        async with task.operation:
            if task.closed or task.control is None:
                raise BrowserRefused("BROWSER_CONTROL_UNAVAILABLE")
            try:
                await task.control.execute(action, actor="owner")
            except BaseException:
                if task.control.outcome_uncertain:
                    task.phase, task.code = "outcome_uncertain", "BROWSER_OUTCOME_UNCERTAIN"
                    await self._checkpoint(task)
                    await self._close(task)
                raise
            await self._checkpoint(task)
            return self._snapshot(task)

    async def confirm_review(
        self, access: BrowserOwnerAccess, task_id: str, review_id: str
    ) -> BrowserTaskSnapshot:
        task = await self._task(access, task_id)
        async with task.operation:
            if task.closed or task.review is None or task.review.review_id != review_id:
                raise BrowserRefused("BROWSER_REVIEW_CHANGED")
            await self._reviews.confirm_review(task.binding, review_id)
            await task.access.check()
            task.review, task.code = None, None
            # Owner takeover/login remains paused until explicit Resume. Only
            # the initial model-processing review may awaken an agent task here.
            if task.control is None or task.control.control_owner == "agent":
                await self._cancel_worker(task)
                task.phase = "running"
                task.worker = asyncio.create_task(self._run(task), name="owner-browser-task")
            await self._checkpoint(task)
            return self._snapshot(task)

    async def session(
        self,
        access: BrowserOwnerAccess,
        task_id: str,
        operation: Literal["remember", "restore", "forget"],
        origin: str,
        account_id: str,
    ) -> dict:
        task = await self._task(access, task_id)
        async with task.operation:
            if task.sessions is None or origin not in task.request.allowed_origins:
                raise BrowserRefused("BROWSER_SESSION_UNAVAILABLE")
            site = task.sessions.site_id(origin, account_id)
            origins = frozenset({origin})
            if operation == "forget":
                # Existing session owner fences live contexts before tombstone.
                receipt = await task.sessions.forget(task.binding, site)
                return {
                    "fenced": receipt.fenced,
                    "persisted": receipt.persisted,
                    "deletion_requested": receipt.deletion_requested,
                    "physical_deletion": receipt.physical_deletion,
                    "remote_logout": False,
                }
            if task.closed or task.control is None or task.control.control_owner != "owner":
                raise BrowserRefused("BROWSER_OWNER_CONTROL_REQUIRED")
            if operation == "remember":
                state = await task.control.export_session(origins)
                revision = await task.sessions.remember(
                    task.binding, site, state, approved_origins=origins
                )
                return {"remembered": True, "generation": revision.generation}
            if operation == "restore":

                async def install(state):
                    await task.control.import_session(state, origins)

                restored = await task.sessions.restore_for_task(
                    task.binding, site, approved_origins=origins, install=install
                )
                return {"restored": restored, "authenticated": False}
            raise BrowserRefused("BROWSER_SESSION_OPERATION_INVALID")

    async def fence_live_contexts(self, site: str) -> None:
        # Pilot runs at most one live browser. Forget closes it regardless of
        # whether the opaque site was imported, preventing retained live login.
        for task in self._tasks.values():
            if not task.closed:
                task.phase, task.code = "cancelled", "BROWSER_SESSION_FORGOTTEN"
                await self._close(task)
                await self._checkpoint(task)

    async def drain(self) -> None:
        async with self._lock:
            self._draining = True
        for task in self._tasks.values():
            if not task.closed:
                task.phase, task.code = "cancelled", "BROWSER_DRAINING"
                await self._close(task)
                await self._checkpoint(task)
