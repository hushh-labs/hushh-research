"""Read-only recovery of a Files replacement whose acknowledgement was lost."""

from __future__ import annotations

import hashlib
from dataclasses import replace

from hushh_mcp.services.pod_files.capability_checkpoint import FilesUpgradeCheckpoint
from hushh_mcp.services.pod_files.capability_update import FilesCapabilityPlan
from hushh_mcp.services.pod_release import image_digest


async def discover_replacement(*, row: dict, spec, backend, lease: str) -> dict | None:
    """Positive provider evidence only; partial or uncertain resource work stays held."""
    discover = getattr(backend, "discover_files_upgrade_ack", None)
    metadata = row.get("backend_metadata") or {}
    approval = metadata.get("upgradeApproval") or {}
    if not spec.files_upgrade_plan or discover is None or not lease:
        return None
    plan = FilesCapabilityPlan.model_validate(spec.files_upgrade_plan)
    plan.require_owner(row, spec.upgrade_target_image)
    attempt = hashlib.sha256(lease.encode()).hexdigest()
    checkpoint = FilesUpgradeCheckpoint(
        plan=plan,
        operation_id=spec.upgrade_operation_id or "",
        attempt_id=attempt,
        original_inventory=metadata["substrateReceipt"],
        previous=metadata.get("filesUpgradeCheckpoint"),
    )
    if not checkpoint.complete:
        return None
    receipt = await discover(replace(spec, upgrade_attempt_id=attempt))
    if receipt is None:
        return None
    if (
        receipt.get("attemptId") != attempt
        or receipt.get("serviceUid") != plan.serviceUid
        or receipt.get("service") != plan.service
        or image_digest(receipt.get("image")) != image_digest(plan.targetImage)
    ):
        raise RuntimeError("Files replacement observation is not bound to the approved operation")
    return {
        **receipt,
        "targetImage": plan.targetImage,
        "targetDigest": image_digest(plan.targetImage),
        "operationId": spec.upgrade_operation_id,
        "releaseId": approval["releaseId"],
        "podIncarnation": plan.serviceUid,
    }
