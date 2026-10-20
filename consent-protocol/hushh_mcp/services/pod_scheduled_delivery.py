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
