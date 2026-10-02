"""Where this pod runs and which incarnation it is, read only from the platform.

Cloud Run sets ``K_SERVICE`` and ``K_REVISION``. Azure Container Apps sets
``CONTAINER_APP_NAME``, ``CONTAINER_APP_REVISION`` and
``CONTAINER_APP_REPLICA_NAME``. Hussh renders none of them, so the answer here is
the platform's, never a value a rendered environment could claim
(``docs/reference/architecture/byoc-azure.md``, agent environment contract).

The incarnation fences (the erasure fence, upgrade admission, the heartbeat's
self-report) compare these names against what the hub observed. Reading only the
Cloud Run pair made every fence refuse on Azure, where that pair is never set.
"""

from __future__ import annotations

import os
from typing import Literal

WorkloadPlatform = Literal["gcp", "azure", "local"]

# (service, revision) as each platform names them.
_GCP_NAMES = ("K_SERVICE", "K_REVISION")
_AZURE_NAMES = ("CONTAINER_APP_NAME", "CONTAINER_APP_REVISION")


def _env(name: str) -> str:
    return (os.getenv(name) or "").strip()


def workload_platform() -> WorkloadPlatform:
    """``azure`` on Container Apps, ``gcp`` on Cloud Run, otherwise ``local``."""
    if _env(_AZURE_NAMES[0]):
        return "azure"
    if _env(_GCP_NAMES[0]):
        return "gcp"
    return "local"


def _platform_names() -> tuple[str, str]:
    return _AZURE_NAMES if workload_platform() == "azure" else _GCP_NAMES


def pod_service_name() -> str:
    """The platform's name for this pod's service, or ``""`` when not on one."""
    return _env(_platform_names()[0])


def pod_revision_name() -> str:
    """The platform's name for the revision serving now, or ``""`` when not on one."""
    return _env(_platform_names()[1])


__all__ = [
    "WorkloadPlatform",
    "pod_revision_name",
    "pod_service_name",
    "workload_platform",
]
