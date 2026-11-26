"""Due-time wake delivery in the owner's project; no task contents or secrets."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import time
from datetime import UTC, datetime

from hushh_mcp.services.pod_scheduled_tasks import ScheduleRefused


class GcpScheduledDelivery:
    def __init__(self, store, *, clock=time.time):
        self.store, self.clock = store, clock

    def require_ready(self) -> None:
        from hushh_mcp.services.pod_platform import workload_platform
        from hushh_mcp.services.pod_worker_binding import WorkerBindingRefused, gcp_worker_binding

        if workload_platform() != "gcp":
            # A delayed Azure Queue message must not be mistaken for a proven
            # scale-to-zero timer. No polling/always-awake fallback is installed.
            raise ScheduleRefused("SCHEDULE_CLOUD_DELIVERY_UNQUALIFIED")
        try:
            # Delivery authorizes identifiers, not model processing. The actual
            # capability rechecks its selected model and information grants.
            # Keep the exact owner-project queue/worker checks for every task.
            gcp_worker_binding()
        except WorkerBindingRefused:
            raise ScheduleRefused("SCHEDULE_DELIVERY_NOT_CONFIGURED") from None
        if not re.fullmatch(
            r"projects/[a-z][a-z0-9-]+/locations/[a-z0-9-]+/queues/[a-zA-Z0-9_-]+",
            os.getenv("POD_FILES_TASK_QUEUE", ""),
        ) or not os.getenv("POD_FILES_WORKER_SERVICE_ACCOUNT"):
            raise ScheduleRefused("SCHEDULE_DELIVERY_NOT_CONFIGURED")

    async def offer(self, schedule_id: str, revision: int, occurrence_id: str, due_at: int) -> None:
        from hushh_mcp.services.pod_files.jobs import worker_origin

        self.require_ready()
        if (
            not re.fullmatch(r"schedule_[a-f0-9]{32}", schedule_id)
            or not re.fullmatch(r"[a-f0-9]{32}", occurrence_id)
            or type(revision) is not int
            or revision < 1
        ):
            raise ScheduleRefused("SCHEDULE_DELIVERY_REFUSED")
        # Tasks permit a bounded future horizon. A long schedule uses monthly
        # metadata-only checkpoints; those wakes never execute the capability.
        horizon = 28 * 86400
        remaining = max(0, due_at - int(self.clock()))
        # Anchor checkpoints at the due time so retries name the same delivery.
        dispatch_at = due_at - max(0, (remaining - 1) // horizon) * horizon
        queue, account = (
            os.environ["POD_FILES_TASK_QUEUE"],
            os.environ["POD_FILES_WORKER_SERVICE_ACCOUNT"],
        )
        origin = worker_origin()
        body = {"schedule_id": schedule_id, "revision": revision, "occurrence_id": occurrence_id}
        task = {
            "name": f"{queue}/tasks/agent-{occurrence_id}-{dispatch_at}",
            "scheduleTime": datetime.fromtimestamp(dispatch_at, UTC).isoformat(),
            "dispatchDeadline": "1000s",  # maximum active task plus bounded shutdown
            "httpRequest": {
                "httpMethod": "POST",
                "url": origin + "/api/one/pod/tasks/worker",
                "headers": {"Content-Type": "application/json"},
                "oidcToken": {"serviceAccountEmail": account, "audience": origin},
                "body": base64.b64encode(json.dumps(body).encode()).decode(),
            },
        }
        try:
            response = await asyncio.to_thread(
                self.store._authorized,
                lambda headers: self.store._session.post(
                    f"https://cloudtasks.googleapis.com/v2/{queue}/tasks",
                    json={"task": task},
                    headers=headers,
                    timeout=20,
                    allow_redirects=False,
                ),
            )
        except Exception:
            raise ScheduleRefused("SCHEDULE_DELIVERY_UNCONFIRMED") from None
        if response.status_code not in {200, 201, 409}:
            raise ScheduleRefused("SCHEDULE_DELIVERY_FAILED")


class ResidentScheduledDelivery:
    """In-sandbox timer delivery for persistent Confidential Sandbox (`ace`) microVMs.

    Durability, CAS claiming, execution leases, and turn admission remain owned by
    `ScheduledTaskJournal` and `ScheduledTaskRunner` in the sealed pod log; this
    adapter only replaces the external Cloud Tasks wake callback on resident VMs.
    """

    def __init__(self, *, clock=time.time, runner=None):
        self.clock = clock
        self._runner = runner
        self._timers: dict[tuple[str, int, str], asyncio.Task] = {}
        self._rehydrating: asyncio.Task | None = None
        self._rehydrated = False

    def bind_runner(self, runner) -> None:
        self._runner = runner

    def require_ready(self) -> None:
        from hushh_mcp.services.pod_platform import workload_platform

        if workload_platform() != "ace":
            raise ScheduleRefused("SCHEDULE_CLOUD_DELIVERY_UNQUALIFIED")

    async def offer(self, schedule_id: str, revision: int, occurrence_id: str, due_at: int) -> None:
        self.require_ready()
        if (
            not re.fullmatch(r"schedule_[a-f0-9]{32}", schedule_id)
            or not re.fullmatch(r"[a-f0-9]{32}", occurrence_id)
            or type(revision) is not int
            or revision < 1
        ):
            raise ScheduleRefused("SCHEDULE_DELIVERY_REFUSED")
        self._arm(schedule_id, revision, occurrence_id, due_at)

    def _arm(self, schedule_id: str, revision: int, occurrence_id: str, due_at: int) -> None:
        key = (schedule_id, revision, occurrence_id)
        existing = self._timers.get(key)
        if existing is not None and not existing.done():
            return
        task = asyncio.create_task(
            self._wait_and_run(schedule_id, revision, occurrence_id, due_at),
            name=f"pod-schedule-{occurrence_id[:12]}",
        )
        self._timers[key] = task
        task.add_done_callback(
            lambda done, k=key: self._timers.pop(k, None) if self._timers.get(k) is done else None
        )

    async def _wait_and_run(
        self, schedule_id: str, revision: int, occurrence_id: str, due_at: int
    ) -> None:
        try:
            while True:
                remaining = float(due_at) - float(self.clock())
                if remaining <= 0:
                    break
                await asyncio.sleep(min(remaining, 3600.0))
            runner = self._runner
            if runner is None:
                from hushh_mcp.services.pod_scheduled_runtime import active_scheduled_tasks

                runner = active_scheduled_tasks().run
            await runner(schedule_id, revision, occurrence_id)
        except asyncio.CancelledError:
            raise
        except Exception:
            # Transient or refused execution leaves state in the sealed journal for
            # inspection/recovery; never surface private details on background tasks.
            return

    def ensure_rehydrated(self, runtime) -> None:
        if self._rehydrated or (self._rehydrating is not None and not self._rehydrating.done()):
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._rehydrating = loop.create_task(
            self._rehydrate(runtime), name="pod-schedule-rehydrate"
        )

    async def _rehydrate(self, runtime) -> None:
        from hushh_mcp.services.pod_scheduled_contracts import occurrence_id as make_occurrence_id

        try:
            rows, _ = await runtime.journal.snapshot()
            for row in rows.values():
                if row.get("state") == "scheduled" and isinstance(row.get("next_run_at"), int):
                    occ = make_occurrence_id(row["id"], row["next_run_at"])
                    self._arm(row["id"], int(row["revision"]), occ, int(row["next_run_at"]))
            self._rehydrated = True
        except Exception:
            return
