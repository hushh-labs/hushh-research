"""Verify an installed VM's authenticated recovery before releasing its fence.

Expected keys and image come from the admitted registry binding. This port never
adopts a newly reported key or treats provider power state as application health.
"""

from __future__ import annotations

import re

from hushh_mcp.services.azure_vm_power import AzureVmPowerRefused
from hushh_mcp.services.pod_azure_vm_identity import AzureVmInstallation


def _cursor(value: object) -> bool:
    return (
        isinstance(value, dict)
        and set(value) == {"seq", "sha"}
        and type(value["seq"]) is int
        and value["seq"] > 0
        and isinstance(value["sha"], str)
        and re.fullmatch(r"[a-f0-9]{64}", value["sha"]) is not None
    )


def verify_vm_identity(snapshot: dict, binding: dict) -> dict:
    info, keys, status = (snapshot.get(k) for k in ("info", "keys", "status"))
    installation = AzureVmInstallation.model_validate(binding["host"]["installation"])
    if (
        not isinstance(info, dict)
        or not isinstance(keys, dict)
        or not isinstance(status, dict)
        or info.get("vmInstallation") != installation.model_dump()
        or info.get("hushhId") != installation.hushh_id
        or info.get("podMode") is not True
        or info.get("memoryEnabled") is not True
        or info.get("storageBackend") != "commit_log"
        or keys.get("hushhId") != installation.hushh_id
        or keys.get("podKeyDurable") is not True
        or any(
            not binding.get(expected) or keys.get(reported) != binding[expected]
            for reported, expected in (
                ("podKeyId", "podKeyId"),
                ("podPublicKey", "podPublicKey"),
                ("podSigningKeyId", "signingKeyId"),
                ("podSigningKey", "signingPublicKey"),
            )
        )
        or status.get("incarnation") != installation.generation
        or status.get("sessionAuthority", {}).get("state") != "held"
        or status["sessionAuthority"].get("hushhId") != installation.hushh_id
        or status["sessionAuthority"].get("podKeyId") != binding.get("podKeyId")
        or status["sessionAuthority"].get("incarnation") != installation.generation
        or not isinstance(status.get("runtimeEpoch"), str)
        or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", status["runtimeEpoch"])
    ):
        raise AzureVmPowerRefused("VM_POWER_RECOVERY_IDENTITY_CHANGED")
    return status


def verify_vm_drain(snapshot: dict, binding: dict, receipt: dict, operation: str) -> None:
    status = verify_vm_identity(snapshot, binding)
    if (
        status.get("state") != "idle"
        or status.get("durable") is not True
        or status.get("operationId") != operation
        or status.get("activeWork") != 0
        or status.get("idleReceipt") != receipt
        or receipt.get("operationId") != operation
        or receipt.get("incarnation") != status["incarnation"]
        or receipt.get("runtimeEpoch") != status["runtimeEpoch"]
        or not _cursor(receipt.get("idleRecord"))
        or status.get("retainedIdleRecord") != receipt["idleRecord"]
    ):
        raise AzureVmPowerRefused("VM_POWER_DRAIN_UNVERIFIED")


def verify_vm_recovery(snapshot: dict, binding: dict, receipt: dict, operation: str) -> dict:
    status = verify_vm_identity(snapshot, binding)
    retained = receipt.get("idleRecord")
    released = status.get("releaseReceipt")
    if (
        not _cursor(retained)
        or receipt.get("operationId") != operation
        or receipt.get("incarnation") != status["incarnation"]
        or status["runtimeEpoch"] == receipt.get("runtimeEpoch")
    ):
        raise AzureVmPowerRefused("VM_POWER_RECOVERY_UNVERIFIED")
    if status.get("state") == "accepting":
        # A lost release response is reconciled from its sealed receipt. A later
        # restart cannot invent a release or adopt an unrelated operation.
        if (
            status.get("operationId") is not None
            or not isinstance(released, dict)
            or released.get("operationId") != operation
            or released.get("incarnation") != status["incarnation"]
            or not isinstance(released.get("runtimeEpoch"), str)
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", released["runtimeEpoch"])
            or released["runtimeEpoch"] == receipt.get("runtimeEpoch")
            or released.get("retainedIdleRecord") != retained
            or released.get("expectedIdleRecord") != retained
            or not _cursor(released.get("releaseRecord"))
        ):
            raise AzureVmPowerRefused("VM_POWER_RELEASE_UNVERIFIED")
        # Keep the sealed release's historical epoch after a later ordinary
        # process restart. Fresh live authority was independently checked above.
        epoch = released["runtimeEpoch"]
    elif (
        status.get("state") not in {"draining", "idle"}
        or status.get("operationId") != operation
        or status.get("durable") is not True
        or status.get("retainedIdleRecord") != retained
        or status.get("activeWork") != 0
    ):
        raise AzureVmPowerRefused("VM_POWER_RECOVERY_UNVERIFIED")
    else:
        epoch = status["runtimeEpoch"]
    return {
        "kind": "recovery",
        "incarnation": status["incarnation"],
        "podKeyId": binding["podKeyId"],
        "imageDigest": binding["host"]["installation"]["image_digest"],
        "runtimeEpoch": epoch,
        "retainedIdleRecord": retained,
    }


def verified_vm_release(status: dict, recovery: dict, operation: str) -> dict:
    receipt = status.get("releaseReceipt")
    if (
        status.get("state") != "accepting"
        or status.get("operationId") is not None
        or not isinstance(receipt, dict)
        or receipt.get("operationId") != operation
        or any(receipt.get(k) != recovery[k] for k in ("incarnation", "runtimeEpoch"))
        or receipt.get("retainedIdleRecord") != recovery["retainedIdleRecord"]
        or receipt.get("expectedIdleRecord") != recovery["retainedIdleRecord"]
        or not _cursor(receipt.get("releaseRecord"))
    ):
        raise AzureVmPowerRefused("VM_POWER_RELEASE_UNVERIFIED")
    return {
        "kind": "released",
        "operationId": operation,
        "incarnation": recovery["incarnation"],
        "runtimeEpoch": recovery["runtimeEpoch"],
        "releaseRecord": receipt["releaseRecord"],
    }
