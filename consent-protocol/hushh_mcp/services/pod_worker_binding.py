"""Owner-project delivery identity, independent of a task's model or Files flag."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Literal


class WorkerBindingRefused(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class GcpWorkerBinding:
    project: str
    region: str
    queue: str
    service_account: str


def gcp_worker_binding(*, capability: Literal["files", "browser"] = "files") -> GcpWorkerBinding:
    from hushh_mcp.services.pod_files.provisioning import coordinates

    key = re.fullmatch(
        r"projects/([a-z][a-z0-9-]{4,61}[a-z0-9])/locations/([a-z]+-[a-z]+[0-9]+)/"
        r"keyRings/[A-Za-z0-9_-]+/cryptoKeys/[A-Za-z0-9_-]+",
        os.getenv("HUSSH_POD_KMS_KEY", ""),
    )
    owner = os.getenv("HUSSH_ID", "")
    if (
        not key
        or not owner
        or os.getenv("HUSSH_POD_USER_ADC_ENABLED", "").lower() not in {"1", "true"}
    ):
        raise WorkerBindingRefused("POD_WORKER_IDENTITY_UNAVAILABLE")
    project, region = key.groups()
    names = coordinates(owner, project, region)
    queue = names["queue"]
    if capability == "browser" and (
        os.getenv("POD_BROWSER_DELIVERY_MODE") != "owner_files_queue_v1"
        or os.getenv("POD_FILES_ENABLED", "").lower() not in {"1", "true"}
    ):
        raise WorkerBindingRefused("POD_WORKER_DELIVERY_NOT_CONFIGURED")
    if (
        os.getenv("POD_FILES_TASK_QUEUE") != queue
        or os.getenv("POD_FILES_WORKER_SERVICE_ACCOUNT") != names["worker"]
    ):
        raise WorkerBindingRefused("POD_WORKER_DELIVERY_NOT_CONFIGURED")
    return GcpWorkerBinding(project, region, queue, names["worker"])
