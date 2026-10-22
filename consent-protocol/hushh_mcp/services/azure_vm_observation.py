"""Read-only VM installation fencing, separate from wake and application health."""

from __future__ import annotations

import time
from collections.abc import Callable

from hushh_mcp.services.azure_arm_client import API_VERSIONS, ArmClient
from hushh_mcp.services.azure_vm_host_binding import AzureVmHostBinding


def verified_vm(host: AzureVmHostBinding, arm: ArmClient, *, op: str) -> dict:
    body = arm.get(
        host.installation.resource_id, api_version=API_VERSIONS["virtual_machines"], op=op
    )
    if not isinstance(body, dict):
        raise ValueError("Azure VM installation observation is unavailable")
    host.target().require_current(body)
    return body


def observe_power(
    host: AzureVmHostBinding, *, observer: Callable[[], ArmClient], guard: Callable[[], None]
) -> str:
    # Federation retains its own bounded token-acquisition contract. This bounds
    # ARM requests; it is not a total cold-start or application-latency claim.
    deadline = time.monotonic() + 45

    def remaining() -> float:
        guard()
        value = deadline - time.monotonic()
        if value <= 0:
            raise TimeoutError("Azure VM ARM read budget exceeded")
        return min(30.0, value)

    guard()
    source = observer()
    arm = source.with_request_budget(remaining)
    try:
        api, resource_id = API_VERSIONS["virtual_machines"], host.installation.resource_id
        resource = arm.get_or_none(resource_id, api_version=api, op="vm_observe")
        if resource is None:
            return "gone"  # Only exact-resource GET404 establishes absence.
        host.target().require_current(resource)
        body = arm.get(resource_id + "/instanceView", api_version=api, op="vm_observe")
        statuses = body.get("statuses")
        if not isinstance(statuses, list):
            raise ValueError("Azure VM power observation is unavailable")
        states: list[str] = [
            entry["code"].removeprefix("PowerState/")
            for entry in statuses
            if isinstance(entry, dict)
            and isinstance(entry.get("code"), str)
            and entry["code"].startswith("PowerState/")
        ]
        if len(states) != 1 or states[0] not in {
            "starting",
            "running",
            "stopping",
            "stopped",
            "deallocating",
            "deallocated",
            "unknown",
        }:
            raise ValueError("Azure VM power observation is unavailable")
        # Fence replacement across the separate provider reads.
        verified_vm(host, arm, op="vm_observe")
        guard()
        return states[0]
    finally:
        arm.close()
        source.close()
