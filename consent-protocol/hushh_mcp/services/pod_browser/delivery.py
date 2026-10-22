"""Real Browser work delivery, using the owner's existing authenticated queue.

The message contains identifiers only. Delivery never reconstructs or starts a
goal. A replacement process returns an interrupted receipt, without replay.
"""

from __future__ import annotations

import asyncio
import base64
import time
from collections.abc import Awaitable, Callable
from typing import Literal, Protocol

from pydantic import Field

from .contracts import BrowserBinding, BrowserRefused, StrictContract


class BrowserDelivery(StrictContract):
    version: int = Field(default=1, ge=1, le=1)
    capability: Literal["browser"] = "browser"
    task_id: str = Field(pattern=r"^browser_[a-f0-9]{32}$")
    incarnation: str = Field(min_length=1, max_length=256)
    delivery: str = Field(pattern=r"^[a-f0-9]{32}$")


class BrowserDeliveryPort(Protocol):
    def require_ready(self) -> None: ...

    async def publish(self, binding: BrowserBinding, delivery: BrowserDelivery) -> None: ...


def gcp_delivery_configuration(row: dict) -> dict[str, str]:
    """Reuse qualified Files resources, preserving their existing erasure owner."""
    from hushh_mcp.services.byoc_substrate import SubstrateReceipt
    from hushh_mcp.services.pod_files.provisioning import coordinates

    from .capability_update import commitment

    project, region = row["user_cloud_project"], row["user_cloud_region"]
    names = coordinates(row["hushh_id"], project, region)
    inventory = (row.get("backend_metadata") or {}).get("substrateReceipt") or {}
    planned = [
        {"type": "cloud_tasks_queue", "id": names["queueId"]},
        {"type": "service_account", "id": names["worker"]},
    ]
    observations = [
        item
        for item in inventory.get("resourceObservations", [])
        if isinstance(item, dict) and {"type": item.get("type"), "id": item.get("id")} in planned
    ]
    qualified = (
        SubstrateReceipt(
            applied=False,
            tenant_ref=f"{project}/{region}",
            planned_resources=planned,
            resource_observations=observations,
        )
        .as_record()
        .get("resourceObservations", [])
    )
    if (
        len(qualified) != 2
        or qualified != observations
        or {(item["type"], item["id"]) for item in qualified}
        != {(item["type"], item["id"]) for item in planned}
    ):
        raise ValueError("Browser requires qualified owner background resource receipts")
    return {
        "POD_FILES_ENABLED": "true",
        "POD_FILES_TASK_QUEUE": names["queue"],
        "POD_FILES_WORKER_SERVICE_ACCOUNT": names["worker"],
        "inventoryDigest": commitment(qualified),
        "workerUniqueId": next(
            item["identity"]["uniqueId"] for item in qualified if item["type"] == "service_account"
        ),
    }


class GcpBrowserDelivery:
    """Cloud Tasks owns the active request after the initiating app disconnects."""

    def __init__(self, store) -> None:
        self._store = store

    def require_ready(self) -> None:
        from hushh_mcp.services.pod_platform import workload_platform
        from hushh_mcp.services.pod_worker_binding import WorkerBindingRefused, gcp_worker_binding

        if workload_platform() != "gcp":
            raise BrowserRefused("BROWSER_TASK_DELIVERY_UNQUALIFIED")
        try:
            gcp_worker_binding(capability="browser")
        except WorkerBindingRefused:
            raise BrowserRefused("BROWSER_TASK_DELIVERY_UNAVAILABLE") from None

    async def publish(self, binding: BrowserBinding, delivery: BrowserDelivery) -> None:
        from hushh_mcp.services.pod_files.jobs import worker_origin
        from hushh_mcp.services.pod_worker_binding import gcp_worker_binding

        self.require_ready()
        if delivery.task_id != binding.task_id or delivery.incarnation != binding.incarnation:
            raise BrowserRefused("BROWSER_TASK_DELIVERY_REFUSED")
        worker, origin = gcp_worker_binding(capability="browser"), worker_origin()
        task = {
            "name": f"{worker.queue}/tasks/browser-{delivery.delivery}",
            "dispatchDeadline": "1000s",
            "httpRequest": {
                "httpMethod": "POST",
                "url": origin + "/api/one/pod/browser/worker",
                "headers": {"Content-Type": "application/json"},
                "oidcToken": {"serviceAccountEmail": worker.service_account, "audience": origin},
                "body": base64.b64encode(delivery.model_dump_json().encode()).decode(),
            },
        }
        from hushh_mcp.services.pod_object_version import run_write_to_completion

        def publish():
            def send(headers):
                response = self._store._session.post(
                    f"https://cloudtasks.googleapis.com/v2/{worker.queue}/tasks",
                    json={"task": task},
                    headers=headers,
                    timeout=20,
                    allow_redirects=False,
                )
                try:
                    return response.status_code
                finally:
                    response.close()

            return self._store._authorized(send)

        try:
            status = await run_write_to_completion(publish)
        except Exception:
            # The same named task is retained for a retry; no blind new delivery.
            raise BrowserRefused("BROWSER_TASK_DELIVERY_UNCONFIRMED") from None
        if status not in {200, 201, 409}:
            raise BrowserRefused("BROWSER_TASK_DELIVERY_REFUSED")


def require_gcp_delivery(client, plan) -> None:
    """Read the existing queue and exact scoped grants before owner replacement.

    Bootstrap authority stays in the control plane. No resource is repaired or
    created here; an absent permission leaves the approved update repairable.
    """
    import requests  # type: ignore[import-untyped]

    from hushh_mcp.services.pod_files.provisioning import queue_matches

    config = plan.deliveryConfiguration
    if config is None:
        raise ValueError("Browser delivery needs a fresh configuration review")
    queue, worker = config["POD_FILES_TASK_QUEUE"], config["POD_FILES_WORKER_SERVICE_ACCOUNT"]
    runtime = f"serviceAccount:{plan.runtimeAccount}"

    def read(session, url, *, post=False):
        response = session.request(
            "POST" if post else "GET",
            url,
            headers=client._headers(),
            **({"json": {}} if post else {}),
            timeout=20,
            allow_redirects=False,
        )
        try:
            if response.status_code != 200 or len(response.content) > 1024 * 1024:
                raise ValueError("Browser background delivery readback unavailable")
            value = response.json()
            if not isinstance(value, dict):
                raise ValueError("Browser background delivery readback invalid")
            return value
        finally:
            response.close()

    def granted(policy, role, member):
        return any(
            entry.get("role") == role
            and member in entry.get("members", [])
            and not entry.get("condition")
            for entry in policy.get("bindings", [])
            if isinstance(entry, dict)
        )

    with requests.Session() as session:
        queue_url = "https://cloudtasks.googleapis.com/v2/" + queue
        observed = read(session, queue_url)
        expected = {
            "name": queue,
            "rateLimits": {"maxDispatchesPerSecond": 1, "maxConcurrentDispatches": 1},
            "retryConfig": {
                "maxAttempts": 3,
                "maxRetryDuration": "0s",
                "minBackoff": "10s",
                "maxBackoff": "60s",
                "maxDoublings": 2,
            },
        }
        worker_url = (
            f"https://iam.googleapis.com/v1/projects/{plan.project}/serviceAccounts/{worker}"
        )
        identity = read(session, worker_url)
        if (
            not queue_matches(observed, expected)
            or identity.get("email") != worker
            or identity.get("disabled")
            or identity.get("uniqueId") != config.get("workerUniqueId")
        ):
            raise ValueError("Browser background delivery changed")
        checks = [
            (
                read(session, queue_url + ":getIamPolicy", post=True),
                "roles/cloudtasks.enqueuer",
                runtime,
            ),
            (
                read(session, worker_url + ":getIamPolicy", post=True),
                "roles/iam.serviceAccountUser",
                runtime,
            ),
            (client.get_iam_policy(plan.service), "roles/run.invoker", f"serviceAccount:{worker}"),
        ]
        project_url = f"https://cloudresourcemanager.googleapis.com/v1/projects/{plan.project}"
        project = read(session, project_url)
        number = str(project.get("projectNumber", ""))
        if not number.isdigit():
            raise ValueError("Browser delivery project identity unavailable")
        checks.append(
            (
                read(session, project_url + ":getIamPolicy", post=True),
                "roles/cloudtasks.serviceAgent",
                f"serviceAccount:service-{number}@gcp-sa-cloudtasks.iam.gserviceaccount.com",
            )
        )
        if any(not granted(policy, role, member) for policy, role, member in checks):
            raise ValueError("Browser background delivery permission changed")


async def hold_delivery(
    runtime,
    delivery: BrowserDelivery,
    *,
    check: Callable[[], Awaitable[None]],
    clock: Callable[[], float] = time.time,
) -> dict:
    """Attach to existing memory only; current delivery identity is checked first."""
    await check()
    task = runtime._tasks.get(delivery.task_id)
    if (
        task is None
        or task.binding.incarnation != delivery.incarnation
        or task.delivery_id != delivery.delivery
    ):
        return {"state": "interrupted"}
    if task.closed:
        return {"state": "completed"}
    if task.delivery_attached.is_set():
        return {"state": "duplicate"}
    await task.consent.check_binding(task.binding)
    await check()
    # Two authenticated deliveries can cross either await above. Attachment is
    # a synchronous claim after the last authority check, never two holders.
    if task.closed or task.closing is not None:
        return {"state": "completed" if task.closed else "interrupted"}
    if task.delivery_attached.is_set():
        return {"state": "duplicate"}
    task.delivery_attached.set()
    try:
        async with asyncio.timeout(max(0, task.binding.expires_at - clock()) + 40):
            await task.finished.wait()
        await check()
        return {"state": "completed"}
    finally:
        if not task.closed:
            # A lost work request/lease fences the actual Browser, not just the
            # delivery waiter. Its admission permit remains until joined stop.
            await runtime._lifecycle.close(
                task, phase="cancelled", code="BROWSER_TASK_DELIVERY_ENDED"
            )
