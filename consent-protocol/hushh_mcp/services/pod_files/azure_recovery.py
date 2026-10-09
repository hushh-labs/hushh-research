"""Read-only reconciliation of an uncertain Files role under the existing lease."""

from __future__ import annotations

import hashlib
from copy import deepcopy
from datetime import datetime, timezone

from .azure_capability import AzureFilesCapabilityPlan
from .azure_checkpoint import AzureFilesUpgradeCheckpoint


def uncertain_role_checkpoint(
    row: dict, *, operation: str
) -> tuple[AzureFilesCapabilityPlan, dict]:
    metadata = row.get("backend_metadata") or {}
    approval = metadata.get("upgradeApproval") or {}
    lease = metadata.get("upgradeLease")
    acknowledgement = metadata.get("upgradeAcknowledgement") or {}
    if (
        not isinstance(lease, str)
        or not lease
        or approval.get("status") != "blocked"
        or approval.get("operationId") != operation
        or acknowledgement.get("operationId") == operation
        or acknowledgement.get("attemptId") == hashlib.sha256(lease.encode()).hexdigest()
        or metadata.get("filesUpgradeReconciliation") is not None
    ):
        raise ValueError("Files reconciliation requires the exact blocked operation")
    plan = AzureFilesCapabilityPlan.model_validate(approval.get("capabilityPlan"))
    plan.require_owner(row, approval.get("targetImage"))
    if approval.get("capabilityPlanDigest") != plan.digest:
        raise ValueError("Files reconciliation approval changed")
    previous = metadata.get("filesUpgradeCheckpoint") or {}
    checkpoint = AzureFilesUpgradeCheckpoint(
        plan=plan,
        operation_id=operation,
        attempt_id=hashlib.sha256(lease.encode()).hexdigest(),
        original_inventory=metadata.get("azureFilesInventory", {}),
        previous=previous,
    )
    completed = previous.get("completed", [])
    if (
        previous.get("phase") != "observed"
        or previous.get("step") != "files_custody_role"
        or len(completed) != 2
        or completed[0].get("ok") is not True
        or completed[1] != {"step": "files_custody_role", "ok": False, "status": 0}
        or checkpoint.calls[1]["kind"] != "role_definition"
    ):
        raise ValueError("Files reconciliation requires its uncertain role readback")
    return plan, previous


def settled_role_operation(row: dict, job: dict | None) -> str | None:
    """A completed worker exception proves more than a stale heartbeat or quiet logs.

    The setup job must cover this operation's actual start, on this owner/group.
    Its UNEXPECTED exception is recorded only after the awaited ARM worker exits.
    """
    approval = (row.get("backend_metadata") or {}).get("upgradeApproval") or {}
    operation = approval.get("operationId")
    if not isinstance(operation, str) or not job:
        return None
    try:
        plan, _ = uncertain_role_checkpoint(row, operation=operation)
        start = datetime.fromisoformat(str(approval["startedAt"]).replace("Z", "+00:00"))
        created = datetime.fromisoformat(str(job["created_at"]).replace("Z", "+00:00"))
        finished = datetime.fromisoformat(str(job["updated_at"]).replace("Z", "+00:00"))
    except (ValueError, KeyError, TypeError):
        return None
    if (
        job.get("user_id") != plan.ownerId
        or job.get("project_id", "").lower() != plan.scopes.group.lower()
        or job.get("status") != "failed"
        or job.get("error_code") != "UNEXPECTED"
        or job.get("stage") != "importing_image"
        or any(value.tzinfo is None for value in (created, start, finished))
        or not created <= start <= finished
    ):
        return None
    return operation


async def claim_role_reconciliation(*, registry, row: dict, spec, backend, operation: str):
    """Caller proves executor termination; fresh owner authority proves every read.

    Status zero is uncertain. Never replay its PUT: qualify existing resources,
    retain the failed receipt and claim only the unfinished suffix through CAS.
    """
    from hushh_mcp.services.personal_agent_provisioning_service import upgrade_approval_matches

    plan, failed = uncertain_role_checkpoint(row, operation=operation)
    if (
        getattr(backend, "live", False) is not True
        or spec.files_upgrade_plan != plan.model_dump()
        or not upgrade_approval_matches(row, spec.upgrade_target_image, allow_unresolved=True)
    ):
        raise ValueError("Files reconciliation authority changed")
    qualified = await backend.qualify_files_upgrade_prefix(spec, count=2)
    metadata = row["backend_metadata"]
    checkpoint = {**failed, "completed": qualified}
    verified_checkpoint = AzureFilesUpgradeCheckpoint(
        plan=plan,
        operation_id=operation,
        attempt_id=failed["attemptId"],
        original_inventory=metadata.get("azureFilesInventory", {}),
        previous=checkpoint,
    )
    inventory = verified_checkpoint.inventory_for(qualified)
    updated = {
        **metadata,
        "filesUpgradeCheckpoint": checkpoint,
        "azureFilesInventory": inventory,
        "filesUpgradeReconciliation": {
            "operationId": operation,
            "failedCheckpoint": deepcopy(failed),
            "observedAt": datetime.now(timezone.utc).isoformat(),
        },
        "upgradeApproval": {
            **metadata["upgradeApproval"],
            "status": "updating",
            "operationState": "installing",
        },
    }
    if not await registry.record_image_upgrade(
        user_id=row["user_id"],
        observed=row,
        expected_lease=metadata["upgradeLease"],
        previous_metadata=metadata,
        backend_metadata=updated,
        retain_lease=True,
        require_unchanged_metadata=True,
    ):
        raise RuntimeError("Files reconciliation authority changed before continuation")
    return {**row, "backend_metadata": updated}, qualified
