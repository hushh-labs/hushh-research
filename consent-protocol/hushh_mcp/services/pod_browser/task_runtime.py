"""One owner browser task lifecycle over qualified execution and existing authority.

There is deliberately no ambient launcher/model/export/approval fallback. Cloud
qualification is trusted startup input. Screens, goals, review terms, selected
values and model events live only in this process. A completed owner summary is
sealed by the existing pod log after joined shutdown; recovery never authorizes
an automatic effect replay or returns private output to One's model.
"""

from __future__ import annotations

import asyncio
import hashlib
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
from .delivery import BrowserDelivery, BrowserDeliveryPort
from .information import ConsentedProjectionPort
from .sessions import BrowserSessions
from .task_authority import owner_review, prepare_task
from .task_contracts import (
    BrowserCapability,
    BrowserLauncherPort,
    BrowserModelPort,
    BrowserOwnerAccess,
    BrowserReviewAuthorityPort,
    BrowserTaskLogPort,
    BrowserTaskReceipt,
    BrowserTaskRequest,
    BrowserTaskSnapshot,
)
from .task_input import execute_owner_input, submit_owner_input
from .task_lifecycle import BrowserTaskLifecycle
from .task_recovery import KIND as KIND
from .task_recovery import checkpoint_browser_task, recover_browser_tasks
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
        delivery: BrowserDeliveryPort | None = None,
        environment: Literal["development", "uat"] = "development",
        credential_source=None,
    ) -> None:
        self._owner, self._pod, self._incarnation = owner_id, pod_id, incarnation
        self._environment: Literal["development", "uat"] = (
            "uat" if environment == "uat" else "development"
        )
        self._launcher, self._model, self._reviews, self._source = launcher, model, reviews, source
        self._authority_factory, self._log, self._admission = authority_factory, log, admission
        self._sessions_factory, self._clock = sessions_factory, clock
        self._availability_check, self._public_research_only = (
            availability_check,
            public_research_only,
        )
        self._delivery = delivery
        self._credential_source = credential_source
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
            credentials_factory=self._credentials,
        )
        admission.register_drain(incarnation=incarnation, name="pod_browser", callback=self.drain)

    def capability(self) -> BrowserCapability:
        identity = {
            "owner_id": self._owner,
            "pod_id": self._pod,
            "incarnation": self._incarnation,
            "environment": self._environment,
        }
        if os.getenv("POD_COMPUTER_USE_ENABLED", "").lower() not in {"1", "true"}:
            return BrowserCapability(available=False, code="BROWSER_DISABLED", **identity)
        if self._draining:
            return BrowserCapability(available=False, code="BROWSER_DRAINING", **identity)
        try:
            if self._availability_check:
                self._availability_check()
            if self._delivery is not None:
                self._delivery.require_ready()
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
            remembered_sessions_available=(
                self._sessions_factory is not None and not self._public_research_only
            ),
            public_research_only=self._public_research_only,
            saved_logins_available=self._credentials_available(),
            **identity,
        )

    def _credentials_available(self) -> bool:
        if self._credential_source is None or self._public_research_only:
            return False
        from .credential_contracts import require_credential_execution

        try:
            require_credential_execution(self._launcher.readiness)
            return True
        except BrowserRefused:
            return False

    def _credentials(self, task):
        if not self._credentials_available():
            return None
        from .credential_use import BrowserCredentialUse

        def pending(request):
            task.phase, task.code = "needs_owner", "BROWSER_CREDENTIAL_OWNER_REQUIRED"
            task.revision += 1

        return BrowserCredentialUse(
            task.control,
            self._credential_source,
            task.consent,
            allowed_origins=task.request.allowed_origins,
            pending=pending,
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
            self._log, self._owner, self._pod, incarnation=self._incarnation
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
            downloads=control.downloads.offers if control and control.downloads else (),
            goal_completed=task.model_completed,
            credential_entry_active=bool(control and control._secret_entry),
            credential_request=(
                {
                    **{
                        name: getattr(control.credentials.selection, name)
                        for name in ("operation_id", "origin")
                    },
                    # The owner picker keeps its selected sec_id separately.
                    # Preserve the v1 request wire enum after preparation too.
                    "handle": "owner_selection",
                    "lease_key": control.credentials.lease_key,
                }
                if control and control.credentials and control.credentials.selection
                else None
            ),
            summary=task.summary,
            activity_receipt=task.activity_receipt,
            review=task.review,
            approved_origins=task.request.allowed_origins
            if task.processing_approved and task.request is not None
            else (),
            viewport=control.viewport if control else None,
            input_pending=not task.closed
            and any(
                worker is not None and not worker.done()
                for worker in (task.input_worker, task.credential_worker)
            ),
        )

    async def _checkpoint(self, task: _Task) -> None:
        if (
            task.closed
            and task.control
            and task.control.credentials
            and task.control.credentials.selection
        ):
            from .activity_receipt import activity_receipt

            task.activity_receipt = activity_receipt(
                kind="browser_sign_in",
                state="cancelled",
                task_id=task.binding.task_id,
                operation_id=task.control.credentials.selection.operation_id,
            )
        await checkpoint_browser_task(self._log, task, self._snapshot)

    def _owner_snapshot(self, task: _Task) -> BrowserTaskSnapshot:
        snapshot = self._snapshot(task)
        # Model completion precedes joined browser shutdown, sealed settlement
        # and permit release. Publish completion only after that same close ends.
        if (task.close_payload is not None and not task.closed) or (
            snapshot.phase == "completed" and task.closing is not None and not task.closing.done()
        ):
            return snapshot.model_copy(update={"phase": "running", "summary": None})
        return snapshot

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
                task = self._tasks.get(prior_id)
                if task is None:
                    raise BrowserRefused("BROWSER_TASK_RECOVERY_REQUIRES_OWNER")
                commitment = private_commitment(self._request_key, request.model_dump(mode="json"))
                if not hmac.compare_digest(task.request_commitment, commitment):
                    raise BrowserRefused("BROWSER_TASK_REQUEST_CONFLICT")
                if task.access is not None:
                    await task.access.check()
            else:
                if len(self._tasks) >= 128 or len(self._requests) >= 10000:
                    raise BrowserRefused("BROWSER_TASK_LIMIT")
                if any(not task.closed for task in self._tasks.values()):
                    raise BrowserRefused("BROWSER_TASK_ACTIVE")
                binding = BrowserBinding(
                    owner_id=self._owner,
                    pod_id=self._pod,
                    incarnation=self._incarnation,
                    task_id="browser_" + uuid4().hex,
                    environment=self._environment,
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
                    delivery_id=uuid4().hex if self._delivery is not None else None,
                )
                await self._prepare_task(task, access, request)
                self._tasks[binding.task_id], self._requests[request.request_id] = (
                    task,
                    binding.task_id,
                )
                task.starting = asyncio.create_task(
                    self._start_delivered(task), name="owner-browser-delivery"
                )
        # Delivery attaches without this lock. Repeated Start joins the same
        # publication/attachment rather than submitting another goal.
        starting = task.starting
        if self._delivery is not None and starting is not None:
            # Request-based Cloud Run cannot own an unjoined publication after
            # returning 202. Persist/publish while this request still owns CPU;
            # the authenticated worker then owns execution, not UI polling.
            try:
                async with asyncio.timeout(25):
                    await task.publication_finished.wait()
            except TimeoutError:
                await self._lifecycle.close(
                    task, phase="unavailable", code="BROWSER_TASK_DELIVERY_UNCONFIRMED"
                )
        if starting is not None:
            await asyncio.wait({starting}, timeout=0.15)
            if starting.done():
                await starting
        return self._owner_snapshot(task)

    async def _start_delivered(self, task: _Task) -> None:
        try:
            task.monitor = asyncio.create_task(
                self._lifecycle.monitor(task), name="owner-browser-idle"
            )
            if self._delivery is not None:
                delivery = BrowserDelivery(
                    task_id=task.binding.task_id,
                    incarnation=task.binding.incarnation,
                    delivery=task.delivery_id,
                )
                await self._delivery.publish(task.binding, delivery)
                task.code = "BROWSER_WAITING_FOR_WORKER"
                await self._checkpoint(task)
                task.publication_finished.set()
                async with asyncio.timeout(max(0, task.binding.expires_at - self._clock())):
                    await task.delivery_attached.wait()
            if task.closed or task.closing is not None or self._draining:
                raise BrowserRefused("BROWSER_DRAINING")
            task.worker = asyncio.create_task(self._lifecycle.run(task), name="owner-browser-task")
            task.code = None
        except BaseException as exc:
            if task.closing is not None or task.closed:
                return
            code = (
                exc.code if isinstance(exc, BrowserRefused) else "BROWSER_TASK_DELIVERY_UNCONFIRMED"
            )
            await self._lifecycle.close(task, phase="unavailable", code=code)
        finally:
            task.publication_finished.set()
            # Start is an accepted task receipt, including when delivery later
            # fails. The durable terminal outcome is discoverable without an
            # unobserved task exception or a second publication.

    async def _prepare_task(
        self, task: _Task, access: BrowserOwnerAccess, request: BrowserTaskRequest
    ) -> None:
        await prepare_task(self, task, access, request)

    async def read_activity_receipts(self, access, task_ids):
        import re

        from .activity_receipt import parse_activity_receipt

        if (
            not isinstance(task_ids, (list, tuple))
            or len(task_ids) > 20
            or any(
                not isinstance(task_id, str) or not re.fullmatch(r"browser_[a-f0-9]{32}", task_id)
                for task_id in task_ids
            )
            or len(set(task_ids)) != len(task_ids)
        ):
            raise BrowserRefused("BROWSER_ACTIVITY_RECEIPTS_REFUSED")
        await self._access(access)
        async with self._lock:
            await self._hydrate()
        result = {}
        for task_id in task_ids:
            task = self._tasks.get(task_id)
            snapshot = self._snapshot(task) if task is not None else self._recovered.get(task_id)
            if (
                snapshot is not None
                and (snapshot.binding.owner_id, snapshot.binding.pod_id)
                == (access.owner_id, access.pod_id)
                and parse_activity_receipt(snapshot.activity_receipt) is not None
            ):
                result[task_id] = snapshot
        await self._access(access)
        return result

    async def read(self, access: BrowserOwnerAccess, task_id: str) -> BrowserTaskSnapshot:
        await self._access(access)
        async with self._lock:
            await self._hydrate()
        await self._access(access)
        if task_id in self._recovered:
            return self._recovered[task_id].model_copy(update={"capability": self.capability()})
        task = await self._metadata_task(access, task_id)
        if task.close_payload is not None and not task.closed:
            # Reconcile an already stopped task; never launch or rerun its goal.
            await self._lifecycle.close(task)
        # An owner input can be waiting on the website. Status must not join
        # that dispatch or prevent the owner from discovering a pending review.
        # Confirmation still refreshes and consumes the authoritative receipt.
        if not task.review_operation.locked() and task.review_waiting is None:
            async with task.review_operation:
                if task.review is not None and not task.closed and task.review_waiting is None:
                    review_id = task.review.review_id
                    refreshed = await self._reviews.refresh_review(task.binding, review_id)
                    if (
                        not task.closed
                        and task.closing is None
                        and task.review is not None
                        and task.review.review_id == review_id
                    ):
                        task.review = owner_review(refreshed)
        return self._owner_snapshot(task)

    async def list_tasks(self, access: BrowserOwnerAccess) -> list[BrowserTaskReceipt]:
        """Bounded rediscovery; private goals, reviews and frames stay in their ports.

        A recovered task is an uncertain receipt, never an executable browser
        context. Current admission is required even to discover that receipt.
        """
        await self._access(access)
        async with self._lock:
            await self._hydrate()
            snapshots = list(self._recovered.values()) + [
                self._owner_snapshot(task) for task in self._tasks.values()
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
        if operation == "cancel":
            # Close fences BrowserControl before joining in-flight work. Taking
            # the input lock here would queue Stop behind the action it must
            # interrupt. The same close task retains admission until teardown.
            if control_epoch != self._snapshot(task).control_epoch:
                raise BrowserRefused("BROWSER_CONTROL_CHANGED")
            await self._lifecycle.close(task, phase="cancelled", code="BROWSER_OWNER_CANCELLED")
            return self._snapshot(task)
        async with task.operation:
            control = task.control
            if control_epoch != self._snapshot(task).control_epoch:
                raise BrowserRefused("BROWSER_CONTROL_CHANGED")
            if task.closed or task.closing is not None or control is None:
                raise BrowserRefused("BROWSER_CONTROL_UNAVAILABLE")
            elif operation == "takeover":
                await control.take_control(interrupt=lambda: self._lifecycle.cancel_worker(task))
                credentials = control.credentials
                if credentials is not None and credentials.selection is not None:
                    from .activity_receipt import activity_receipt

                    task.activity_receipt = activity_receipt(
                        kind="browser_sign_in",
                        state="superseded",
                        task_id=task.binding.task_id,
                        operation_id=credentials.selection.operation_id,
                    )
                    credentials.selection = credentials.lease_key = credentials.prepared = None
                    credentials.owner_pending = False
                    if task.review is not None and task.review.purpose == "credential_fill":
                        task.review = None
                task.phase, task.code = "needs_owner", None
            elif operation == "resume":
                if task.model_completed:
                    raise BrowserRefused("BROWSER_DOWNLOAD_PENDING")
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

    async def submit_input(
        self, access: BrowserOwnerAccess, task_id: str, action: BrowserAction
    ) -> BrowserTaskSnapshot:
        return await submit_owner_input(self, access, task_id, action)

    async def input(
        self, access: BrowserOwnerAccess, task_id: str, action: BrowserAction
    ) -> BrowserTaskSnapshot:
        return await execute_owner_input(self, access, task_id, action)

    async def confirm_review(
        self, access: BrowserOwnerAccess, task_id: str, review_id: str, receipt: str
    ) -> BrowserTaskSnapshot:
        task = await self._task(access, task_id)
        async with task.review_operation:
            if (
                task.closed
                or task.closing is not None
                or task.review is None
                or task.review.review_id != review_id
            ):
                raise BrowserRefused("BROWSER_REVIEW_CHANGED")
            refreshed = await self._reviews.refresh_review(task.binding, review_id)
            if refreshed.review_id != review_id:
                if task.review_waiting == review_id:
                    await self._lifecycle.close(
                        task, phase="cancelled", code="BROWSER_REVIEW_EXPIRED"
                    )
                else:
                    task.review = owner_review(refreshed)
                task.revision += 1
                raise BrowserRefused("BROWSER_REVIEW_CHANGED")
            if task.closed or task.closing is not None:
                raise BrowserRefused("BROWSER_REVIEW_CHANGED")
            await self._reviews.confirm_review(task.binding, review_id, receipt)
            if (
                task.closed
                or task.closing is not None
                or task.review is None
                or task.review.review_id != review_id
            ):
                raise BrowserRefused("BROWSER_REVIEW_CHANGED")
            access = task.access
            if access is None:
                raise BrowserRefused("BROWSER_CONTROL_UNAVAILABLE")
            await access.check()
            if (
                task.closed
                or task.closing is not None
                or task.review is None
                or task.review.review_id != review_id
            ):
                raise BrowserRefused("BROWSER_REVIEW_CHANGED")
            resume_exact = task.review_waiting == review_id
            if task.review.purpose == "disclose" and not resume_exact:
                # No surviving request means there is nothing safe to resume.
                # Never start another interpretation of a submission goal.
                raise BrowserRefused("BROWSER_REVIEW_REQUEST_INTERRUPTED")
            from .activity_receipt import activity_receipt

            credential_review = task.review.purpose == "credential_fill"
            operation_id = (
                task.control.credentials.selection.operation_id
                if credential_review
                and task.control
                and task.control.credentials
                and task.control.credentials.selection
                else "review_" + hashlib.sha256(review_id.encode()).hexdigest()[:32]
            )
            task.activity_receipt = activity_receipt(
                kind="browser_sign_in" if credential_review else "browser_review",
                state="allowed" if credential_review else "completed",
                task_id=task.binding.task_id,
                operation_id=operation_id,
            )
            task.review, task.code = None, None
            if credential_review:
                # Approval never restarts a model or fills; the unlocked device
                # must still deliver the exact one-use ciphertext to this key.
                task.phase = "needs_owner"
                await self._checkpoint(task)
                return self._snapshot(task)
            # Owner takeover/login remains paused until explicit Resume. Only
            # the initial model-processing review may awaken an agent task here.
            if resume_exact:
                task.phase = (
                    "running"
                    if task.control is None or task.control.control_owner == "agent"
                    else "needs_owner"
                )
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
            if operation != "forget" and self._public_research_only:
                raise BrowserRefused("BROWSER_SESSION_NOT_QUALIFIED")
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

    async def credential_catalog(self, access, task_id: str, origin: str) -> list[dict]:
        task = await self._task(access, task_id)
        if task.closed or task.control is None or task.control.credentials is None:
            raise BrowserRefused("BROWSER_CREDENTIAL_EXECUTION_UNQUALIFIED")
        return [
            item.model_dump(mode="json") for item in await task.control.credentials.catalog(origin)
        ]

    async def prepare_credential(self, access, task_id, **metadata):
        task = await self._task(access, task_id)
        if task.closed or task.control is None or task.control.credentials is None:
            raise BrowserRefused("BROWSER_CREDENTIAL_EXECUTION_UNQUALIFIED")
        async with task.review_operation:
            if task.review_waiting is not None or (
                task.review is not None and task.review.purpose != "credential_fill"
            ):
                raise BrowserRefused("BROWSER_REVIEW_CHANGED")
            terms = await task.control.credentials.prepare_owner(**metadata)
            task.review = owner_review(
                await self._reviews.offer_review(task.binding, "credential_fill", terms)
            )
            task.phase, task.code = "needs_owner", "BROWSER_CREDENTIAL_OWNER_REQUIRED"
            task.revision += 1
            await self._checkpoint(task)
            return self._snapshot(task)

    async def use_credential(
        self,
        access,
        task_id: str,
        *,
        handle: str,
        operation_id: str,
        control_epoch: int,
        transient: tuple[dict, dict] | None = None,
    ):
        task = await self._task(access, task_id)
        control = task.control
        if task.closed or control is None or control.credentials is None:
            raise BrowserRefused("BROWSER_CREDENTIAL_EXECUTION_UNQUALIFIED")
        selection = control.credentials.selection
        if (
            selection is None
            or selection.operation_id != operation_id
            or control_epoch != control.control_epoch
        ):
            raise BrowserRefused("BROWSER_CREDENTIAL_SELECTION_CHANGED")
        request = selection.model_copy(update={"handle": handle, "control_epoch": control_epoch})
        if task.credential_worker is not None and not task.credential_worker.done():
            raise BrowserRefused("BROWSER_CREDENTIAL_ENTRY_ACTIVE")

        async def run():
            try:
                await control.credentials.use(
                    request,
                    owner_selected=True,
                    interrupt=lambda: self._lifecycle.cancel_worker(task),
                    transient=transient,
                )
                await access.check()
                await self._remember_credential_session(task)
                from .activity_receipt import activity_receipt

                task.activity_receipt = activity_receipt(
                    kind="browser_sign_in",
                    state="completed",
                    task_id=task.binding.task_id,
                    operation_id=operation_id,
                )
                task.code = "BROWSER_CREDENTIAL_SUBMITTED"
                if control.control_owner == "agent":
                    task.phase = "running"
                    task.worker = asyncio.create_task(
                        self._lifecycle.run(task), name="owner-browser-task"
                    )
                await self._checkpoint(task)
            except BrowserRefused as exc:
                if control.outcome_uncertain:
                    await self._lifecycle.close(
                        task, phase="outcome_uncertain", code="BROWSER_OUTCOME_UNCERTAIN"
                    )
                elif control.control_owner == "stopped":
                    await self._lifecycle.close(task, phase="cancelled", code=exc.code)
                elif not task.closed and task.closing is None:
                    task.phase, task.code = "needs_owner", exc.code
                    await self._checkpoint(task)
            except asyncio.CancelledError:
                raise
            except Exception:
                await self._lifecycle.close(
                    task, phase="outcome_uncertain", code="BROWSER_OUTCOME_UNCERTAIN"
                )
            finally:
                if transient is not None:
                    transient[0].clear()
                    transient[1].clear()

        task.phase, task.code = "running", "BROWSER_CREDENTIAL_ENTRY_PENDING"
        task.revision += 1
        task.credential_worker = asyncio.create_task(run(), name="owner-browser-credential")
        return self._snapshot(task)

    async def _remember_credential_session(self, task):
        credentials = task.control.credentials
        permit, credentials.retention = credentials.retention, None
        if permit is None or not permit[1]:
            return
        request, _, aad = permit
        if task.sessions is None:
            raise BrowserRefused("BROWSER_SESSION_UNAVAILABLE")
        origins = frozenset({request.origin})

        async def authorized():
            await task.consent.check_binding(task.binding)
            await credentials.source.validate_transient(task.binding, aad)

        await authorized()
        state = await task.control._executor.export_session(origins)
        state = state.model_copy(
            update={"origins": ()}
        )  # never persist localStorage or raw login values
        await task.sessions.remember(
            task.binding,
            task.sessions.site_id(request.origin, request.handle),
            state,
            approved_origins=origins,
            credential_authorization=authorized,
        )

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
