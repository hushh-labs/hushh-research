"""Where this pod runs and which incarnation it is, read only from the platform.

Cloud Run sets ``K_SERVICE`` and ``K_REVISION``. Azure Container Apps sets
``CONTAINER_APP_NAME``, ``CONTAINER_APP_REVISION`` and
``CONTAINER_APP_REPLICA_NAME``. Hussh renders none of those native service fields
(``docs/reference/architecture/byoc-azure.md``, agent environment contract).
The disabled VM qualification instead uses an installation registered against
fixed provider metadata before custody. Its revision is the verified installation
generation; publishing that generation still requires lifecycle-controller proof.

The incarnation fences (the erasure fence, upgrade admission, the heartbeat's
self-report) compare these names against what the hub observed. Reading only the
Cloud Run pair made every fence refuse on Azure, where that pair is never set.
"""

from __future__ import annotations

import os
from typing import Literal

from hushh_mcp.services.pod_azure_vm_identity import active_vm_installation

WorkloadPlatform = Literal["gcp", "azure", "local"]

# (service, revision) as each platform names them.
_GCP_NAMES = ("K_SERVICE", "K_REVISION")
_AZURE_NAMES = ("CONTAINER_APP_NAME", "CONTAINER_APP_REVISION")


def _env(name: str) -> str:
    return (os.getenv(name) or "").strip()


def workload_platform() -> WorkloadPlatform:
    """Verified VM or native service platform; never infer a VM from Azure env."""
    if active_vm_installation() is not None:
        return "azure"
    if _env(_AZURE_NAMES[0]):
        return "azure"
    if _env(_GCP_NAMES[0]):
        return "gcp"
    return "local"


def _platform_names() -> tuple[str, str]:
    return _AZURE_NAMES if workload_platform() == "azure" else _GCP_NAMES


def pod_service_name() -> str:
    """The platform's name for this pod's service, or ``""`` when not on one."""
    vm = active_vm_installation()
    return vm.resource_id if vm else _env(_platform_names()[0])


def pod_revision_name() -> str:
    """The platform's name for the revision serving now, or ``""`` when not on one."""
    vm = active_vm_installation()
    return vm.generation if vm else _env(_platform_names()[1])


__all__ = [
    "WorkloadPlatform",
    "pod_revision_name",
    "pod_service_name",
    "workload_platform",
]
