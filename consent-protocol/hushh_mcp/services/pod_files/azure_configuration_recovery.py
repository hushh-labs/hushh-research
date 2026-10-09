"""One legacy null-scaler continuation, before any Container App replacement.

Both legacy V2 writers failed unconditionally on the approved explicit null
scaler. Their complete resource receipt predates replacement intent. New writers
journal that intent before PUT; unknown outcomes therefore cannot enter here.
"""

from __future__ import annotations

import hashlib
from dataclasses import replace
from datetime import datetime, timezone

from .azure_capability import AzureFilesCapabilityPlan
from .azure_checkpoint import AzureFilesUpgradeCheckpoint


def configuration_checkpoint(row: dict, *, operation: str) -> AzureFilesUpgradeCheckpoint:
    metadata = row.get("backend_metadata") or {}
    approval = metadata.get("upgradeApproval") or {}
    lease = metadata.get("upgradeLease")
    acknowledgement = metadata.get("upgradeAcknowledgement") or {}
    previous = metadata.get("filesUpgradeCheckpoint") or {}
    if (
        not isinstance(lease, str)
        or not lease
        or approval.get("status") != "blocked"
        or approval.get("operationId") != operation
        or acknowledgement.get("operationId") == operation
        or acknowledgement.get("attemptId") == hashlib.sha256(lease.encode()).hexdigest()
        or metadata.get("filesConfigurationReconciliation") is not None
        or previous.get("phase") != "observed"
    ):
        raise ValueError("Files configuration continuation requires its blocked legacy operation")
    plan = AzureFilesCapabilityPlan.model_validate(approval.get("capabilityPlan"))
    plan.require_owner(row, approval.get("targetImage"))
    if approval.get("capabilityPlanDigest") != plan.digest:
        raise ValueError("Files configuration approval changed")
    checkpoint = AzureFilesUpgradeCheckpoint(
        plan=plan,
        operation_id=operation,
        attempt_id=hashlib.sha256(lease.encode()).hexdigest(),
        original_inventory=metadata.get("azureFilesInventory", {}),
        previous=previous,
    )
    if not checkpoint.complete:
        raise ValueError("Files configuration continuation requires every resource readback")
    return checkpoint


def settled_configuration_operation(row: dict, job: dict | None) -> str | None:
    approval = (row.get("backend_metadata") or {}).get("upgradeApproval") or {}
    operation = approval.get("operationId")
    if not isinstance(operation, str) or not job:
        return None
    try:
        checkpoint = configuration_checkpoint(row, operation=operation)
        start = datetime.fromisoformat(str(approval["startedAt"]).replace("Z", "+00:00"))
        created = datetime.fromisoformat(str(job["created_at"]).replace("Z", "+00:00"))
        finished = datetime.fromisoformat(str(job["updated_at"]).replace("Z", "+00:00"))
    except (ValueError, KeyError, TypeError):
        return None
    if (
        job.get("user_id") != checkpoint.plan.ownerId
        or str(job.get("project_id", "")).lower() != checkpoint.plan.scopes.group.lower()
        or job.get("status") != "failed"
        or job.get("error_code") != "UNEXPECTED"
        or job.get("stage") != "importing_image"
        or not job.get("job_id")
        or any(value.tzinfo is None for value in (created, start, finished))
        or not created <= start <= finished
    ):
        return None
    return operation


async def claim_configuration_reconciliation(
    *, registry, row: dict, spec, backend, operation: str
) -> tuple[dict, list[dict]]:
    from hushh_mcp.services.personal_agent_provisioning_service import upgrade_approval_matches

    checkpoint = configuration_checkpoint(row, operation=operation)
    # The newly claimed authorization job replaced the terminated job row. Its
    # immutable predecessor receipt is passed through the existing job owner.
    evidence = getattr(spec, "files_upgrade_recovery_job", None)
    if (
        settled_configuration_operation(row, evidence) != operation
        or getattr(backend, "live", False) is not True
        or spec.files_upgrade_plan != checkpoint.plan.model_dump()
        or not upgrade_approval_matches(row, spec.upgrade_target_image, allow_unresolved=True)
    ):
        raise ValueError("Files configuration executor or owner authority changed")
    metadata = row["backend_metadata"]
    qualified = await backend.qualify_files_upgrade_prefix(
        replace(spec, upgrade_attempt_id=checkpoint.attempt_id), count=len(checkpoint.calls)
    )
    if qualified != checkpoint.previous["completed"]:
        raise ValueError("Files configuration resources changed")
    updated = {
        **metadata,
        "filesConfigurationReconciliation": {
            "operationId": operation,
            "attemptId": checkpoint.attempt_id,
            "jobId": evidence["job_id"],
            "failedJob": {
                key: str(evidence[key])
                for key in ("job_id", "status", "stage", "error_code", "created_at", "updated_at")
            },
            "reason": "legacy_null_scaler_before_replacement",
            "templateDigest": checkpoint.plan.templateDigest,
            "failedCheckpoint": checkpoint.previous,
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
        raise RuntimeError("Files configuration authority changed before continuation")
    return {**row, "backend_metadata": updated}, qualified
