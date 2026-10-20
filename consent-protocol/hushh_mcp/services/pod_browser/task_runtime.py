"""One owner browser task lifecycle over qualified execution and existing authority.

There is deliberately no ambient launcher/model/export/approval fallback. Cloud
qualification is trusted startup input. Screens, goals, review terms, selected
values and model events live only in this process; recovery records are sealed
by the existing pod log and never authorize an automatic effect replay.
"""

from __future__ import annotations

import asyncio
import hmac
import os
import time
from collections.abc import Callable
from typing import Literal
from uuid import uuid4

from hushh_mcp.services.pod_upgrade_admission import (
    PodUpgradeAdmission,
    PodUpgradeAdmissionRefused,
)

from .consent import BrowserConsentPort, private_commitment
from .contracts import (
    BrowserAction,
    BrowserAuthorityPort,
    BrowserBinding,
    BrowserFrame,
    BrowserRefused,
)
from .information import BrowserInformation, BrowserModelProcessing, ConsentedProjectionPort
from .sessions import BrowserSessions
from .task_authority import TaskAuthority, TaskConsent, owner_review
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
)
from .task_lifecycle import BrowserTaskLifecycle
from .task_recovery import KIND as KIND
from .task_recovery import recover_browser_tasks
from .task_state import BrowserTaskState as _Task


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
        availability_check: Callable[[], None] | None = None,
        public_research_only: bool = False,
    ) -> None:
        self._owner, self._pod, self._incarnation = owner_id, pod_id, incarnation
        self._launcher, self._model, self._reviews, self._source = launcher, model, reviews, source
        self._authority_factory, self._log, self._admission = authority_factory, log, admission
        self._sessions_factory, self._clock = sessions_factory, clock
        self._availability_check, self._public_research_only = (
            availability_check,
            public_research_only,
        )
        self._tasks: dict[str, _Task] = {}
        self._request_key = os.urandom(32)
        self._requests: dict[str, str] = {}
        self._recovered: dict[str, BrowserTaskSnapshot] = {}
        self._lock = asyncio.Lock()
        self._hydrated, self._draining = False, False
        self._lifecycle = BrowserTaskLifecycle(
            launcher=launcher,
            model=model,
            reviews=reviews,
            clock=clock,
            capability=self.capability,
            draining=lambda: self._draining,
            checkpoint=self._checkpoint,
            snapshot=self._snapshot,
        )
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
            if self._availability_check:
                self._availability_check()
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
            public_research_only=self._public_research_only,
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
        self._recovered, self._requests = await recover_browser_tasks(
            self._log, self._owner, self._pod
        )
        self._hydrated = True

    def _snapshot(self, task: _Task) -> BrowserTaskSnapshot:
        if task.terminal is not None:
            return task.terminal.model_copy(
                update={
                    "phase": task.phase,
                    "code": task.code,
                    "revision": task.revision,
                    "capability": self.capability(),
                }
            )
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
            approved_origins=task.request.allowed_origins
            if task.processing_approved and task.request is not None
            else (),
            viewport=control.viewport if control else None,
        )

    async def _checkpoint(self, task: _Task) -> None:
        task.revision += 1
        snapshot = self._snapshot(task).model_copy(
            update={"summary": None, "review": None, "approved_origins": ()}
        )
        await self._log.append(
            KIND,
            {"request_id": task.request_id, "snapshot": snapshot.model_dump(mode="json")},
        )

    async def _metadata_task(self, access: BrowserOwnerAccess, task_id: str) -> _Task:
        await self._access(access)
        task = self._tasks.get(task_id)
        if task is None:
            raise BrowserRefused("BROWSER_TASK_NOT_FOUND")
        return task

    async def _task(
        self,
        access: BrowserOwnerAccess,
        task_id: str,
        *,
        closed_code: str = "BROWSER_CONTROL_UNAVAILABLE",
    ) -> _Task:
        task = await self._metadata_task(access, task_id)
        if task.closed or task.closing is not None or task.access is None:
            raise BrowserRefused(closed_code)
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
                commitment = private_commitment(self._request_key, request.model_dump(mode="json"))
                if not hmac.compare_digest(prior.request_commitment, commitment):
                    raise BrowserRefused("BROWSER_TASK_REQUEST_CONFLICT")
                if prior.access is not None:
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
            task = _Task(
                binding=binding,
                request=request,
                access=access,
                permit=permit,
                request_id=request.request_id,
                request_commitment=private_commitment(
                    self._request_key, request.model_dump(mode="json")
                ),
            )

            await self._prepare_task(task, access, request)
            self._tasks[binding.task_id], self._requests[request.request_id] = task, binding.task_id
            task.worker = asyncio.create_task(self._lifecycle.run(task), name="owner-browser-task")
            task.monitor = asyncio.create_task(
                self._lifecycle.monitor(task), name="owner-browser-idle"
            )
            return self._snapshot(task)

    async def _prepare_task(
        self, task: _Task, access: BrowserOwnerAccess, request: BrowserTaskRequest
    ) -> None:
        binding = task.binding

        def pending(offer: BrowserReviewOffer) -> None:
            task.review_ready.clear()
            task.review, task.phase, task.code = (
                offer,
                "needs_owner",
                "BROWSER_OWNER_APPROVAL_REQUIRED",
            )
            task.revision += 1

        async def wait_for_review() -> None:
            task.review_waiting = True
            try:
                await task.review_ready.wait()
            finally:
                task.review_waiting = False

        async def check_runtime() -> None:
            current = self.capability()
            if not current.available:
                raise BrowserRefused(current.code)

        task.consent = TaskConsent(
            binding, access, self._reviews, pending, self._clock, check_runtime, wait_for_review
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
            await self._reviews.release(binding)
            await task.permit.release()
            raise

    async def read(self, access: BrowserOwnerAccess, task_id: str) -> BrowserTaskSnapshot:
        await self._access(access)
        async with self._lock:
            await self._hydrate()
        await self._access(access)
        if task_id in self._recovered:
            return self._recovered[task_id]
        task = await self._metadata_task(access, task_id)
        async with task.operation:
            if task.review is not None and not task.closed:
                task.review = owner_review(
                    await self._reviews.refresh_review(task.binding, task.review.review_id)
                )
        return self._snapshot(task)

    async def list_tasks(self, access: BrowserOwnerAccess) -> list[BrowserTaskReceipt]:
        """Bounded rediscovery; private goals, reviews and frames stay in their ports.

        A recovered task is an uncertain receipt, never an executable browser
        context. Current admission is required even to discover that receipt.
        """
        await self._access(access)
        async with self._lock:
            await self._hydrate()
            snapshots = list(self._recovered.values()) + [
                self._snapshot(task) for task in self._tasks.values()
            ]
            receipts = [self.delegation_receipt(item) for item in snapshots[-20:]]
        await self._access(access)
        return receipts

    async def frame(
        self, access: BrowserOwnerAccess, task_id: str
    ) -> tuple[BrowserTaskSnapshot, BrowserFrame]:
        task = await self._task(access, task_id, closed_code="BROWSER_FRAME_UNAVAILABLE")
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
        # Current owner control may stop old work after its original processing
        # grant ends. It never renews that grant or permits more observation/input.
        task = await (
            self._metadata_task(access, task_id)
            if operation == "cancel"
            else self._task(access, task_id)
        )
        async with task.operation:
            control = task.control
            if control_epoch != self._snapshot(task).control_epoch:
                raise BrowserRefused("BROWSER_CONTROL_CHANGED")
            if operation == "cancel":
                await self._lifecycle.close(task, phase="cancelled", code="BROWSER_OWNER_CANCELLED")
                return self._snapshot(task)
            elif task.closed or task.closing is not None or control is None:
                raise BrowserRefused("BROWSER_CONTROL_UNAVAILABLE")
            elif operation == "takeover":
                await control.take_control()
                await self._lifecycle.cancel_worker(task)
                task.phase, task.code = "needs_owner", None
            elif operation == "resume":
                if task.processing is None:
                    raise BrowserRefused("BROWSER_TASK_COMPOSITION_UNAVAILABLE")
                await task.processing.require()
                await control.resume_agent()
                task.review, task.phase, task.code = None, "running", None
                task.worker = asyncio.create_task(
                    self._lifecycle.run(task), name="owner-browser-task"
                )
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
            if action.operation == "resize" and task.review is not None:
                raise BrowserRefused("BROWSER_REVIEW_PENDING")
            try:
                await task.control.execute(action, actor="owner")
            except BaseException:
                if task.control.outcome_uncertain:
                    task.phase, task.code = "outcome_uncertain", "BROWSER_OUTCOME_UNCERTAIN"
                    await self._checkpoint(task)
                    await self._lifecycle.close(task)
                raise
            await self._checkpoint(task)
            return self._snapshot(task)

    async def confirm_review(
        self, access: BrowserOwnerAccess, task_id: str, review_id: str, receipt: str
    ) -> BrowserTaskSnapshot:
        task = await self._task(access, task_id)
        async with task.operation:
            if task.closed or task.review is None or task.review.review_id != review_id:
                raise BrowserRefused("BROWSER_REVIEW_CHANGED")
            task.review = owner_review(await self._reviews.refresh_review(task.binding, review_id))
            if task.review.review_id != review_id:
                task.revision += 1
                raise BrowserRefused("BROWSER_REVIEW_CHANGED")
            await self._reviews.confirm_review(task.binding, review_id, receipt)
            if task.access is None:
                raise BrowserRefused("BROWSER_CONTROL_UNAVAILABLE")
            await task.access.check()
            resume_exact = (
                task.review.purpose == "provider_safety"
                and task.review_waiting
                and task.worker is not None
                and not task.worker.done()
            )
            task.review, task.code = None, None
            # Owner takeover/login remains paused until explicit Resume. Only
            # the initial model-processing review may awaken an agent task here.
            if resume_exact:
                task.phase = "running"
                task.review_ready.set()
            elif task.control is None or task.control.control_owner == "agent":
                await self._lifecycle.cancel_worker(task)
                task.phase = "running"
                task.worker = asyncio.create_task(
                    self._lifecycle.run(task), name="owner-browser-task"
                )
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
            if (
                task.sessions is None
                or task.request is None
                or origin not in task.request.allowed_origins
            ):
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
                await self._lifecycle.close(
                    task, phase="cancelled", code="BROWSER_SESSION_FORGOTTEN"
                )

    async def drain(self) -> None:
        async with self._lock:
            self._draining = True
        for task in self._tasks.values():
            if not task.closed:
                await self._lifecycle.close(task, phase="cancelled", code="BROWSER_DRAINING")
