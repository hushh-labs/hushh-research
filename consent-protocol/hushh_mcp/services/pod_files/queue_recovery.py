"""Explicit recovery of one definitively denied Files queue creation.

No release approval or new lease is minted. Unknown provider outcomes remain held.
"""

from __future__ import annotations

import asyncio
import hashlib
from copy import deepcopy
from datetime import datetime, timezone

from hushh_mcp.services.pod_files.capability_bootstrap import FilesCapabilityBootstrap
from hushh_mcp.services.pod_files.capability_update import FilesCapabilityPlan


def denied_queue_prefix(
    plan: FilesCapabilityPlan, checkpoint: dict, *, operation: str, lease: str
) -> list[dict]:
    """Only the recorded first queue denial admits one suffix continuation."""
    calls = FilesCapabilityBootstrap(capability=plan).plan_calls(plan.substrate_plan())
    names = [call["step"] for call in calls]
    queue_index = names.index("files_queue")
    completed = checkpoint.get("completed")
    if (
        checkpoint.get("version") != 1
        or checkpoint.get("planDigest") != plan.digest
        or checkpoint.get("operationId") != operation
        or checkpoint.get("attemptId") != hashlib.sha256(lease.encode()).hexdigest()
        or checkpoint.get("phase") != "observed"
        or checkpoint.get("step") != "files_queue"
        or checkpoint.get("recovery") is not None
        or not isinstance(completed, list)
        or len(completed) != queue_index + 1
        or [item.get("step") for item in completed] != names[: queue_index + 1]
        or any(item.get("ok") is not True for item in completed[:-1])
        or completed[-1] != {"step": "files_queue", "status": 403, "ok": False}
    ):
        raise ValueError("Files queue recovery needs its exact denied checkpoint")
    return deepcopy(completed[:-1])


def verify_queue_absence(plan: FilesCapabilityPlan, prefix: list[dict]) -> dict:
    """Read under the existing bootstrap identity; no resource or IAM writes."""
    import requests

    from hushh_mcp.services.user_gcp_bootstrap import mint_bootstrap_token

    token = mint_bootstrap_token(bootstrap_sa=plan.bootstrapAccount)
    headers = {"Authorization": "Bearer " + token}
    queue = plan.environment["POD_FILES_TASK_QUEUE"]
    with requests.Session() as session:
        permissions = session.post(
            f"https://cloudresourcemanager.googleapis.com/v1/projects/{plan.project}:testIamPermissions",
            headers=headers,
            json={"permissions": ["cloudtasks.queues.create", "cloudtasks.queues.get"]},
            timeout=30,
            allow_redirects=False,
        )
        if permissions.status_code != 200 or not {
            "cloudtasks.queues.create",
            "cloudtasks.queues.get",
        } <= set(permissions.json().get("permissions", [])):
            raise ValueError("Files queue permissions are not effective")
        observed = session.get(
            "https://cloudtasks.googleapis.com/v2/" + queue,
            headers=headers,
            timeout=30,
            allow_redirects=False,
        )
        if observed.status_code != 404:
            raise ValueError("Files queue absence is not verified")
        worker = plan.environment["POD_FILES_WORKER_SERVICE_ACCOUNT"]
        account = session.get(
            f"https://iam.googleapis.com/v1/projects/{plan.project}/serviceAccounts/{worker}",
            headers=headers,
            timeout=30,
            allow_redirects=False,
        )
        retained = next(item for item in prefix if item["step"] == "files_worker_account")
        identity = (retained.get("resourceObservation") or {}).get("identity")
        if (
            account.status_code != 200
            or not identity
            or any(account.json().get(key) != value for key, value in identity.items())
        ):
            raise ValueError("Files worker identity changed")
    return {"queue": queue, "status": 404, "observedAt": datetime.now(timezone.utc).isoformat()}


async def claim_queue_retry(
    *, registry, row: dict, spec, backend, operation: str
) -> tuple[dict, list[dict]]:
    """CAS one recovery executor into the existing owner-approved reservation."""
    from hushh_mcp.services.personal_agent_provisioning_service import upgrade_approval_matches

    metadata = row["backend_metadata"]
    approval = metadata.get("upgradeApproval") or {}
    lease = metadata.get("upgradeLease")
    acknowledgement = metadata.get("upgradeAcknowledgement") or {}
    if (
        not lease
        or approval.get("status") != "blocked"
        or approval.get("operationId") != operation
        or not upgrade_approval_matches(row, spec.upgrade_target_image, allow_unresolved=True)
        or not spec.files_upgrade_plan
        or getattr(backend, "live", False) is not True
        or acknowledgement.get("operationId") == operation
        or acknowledgement.get("attemptId") == hashlib.sha256(str(lease).encode()).hexdigest()
    ):
        raise ValueError("Files recovery requires the existing exact blocked approval")
    plan = FilesCapabilityPlan.model_validate(spec.files_upgrade_plan)
    plan.require_owner(row, spec.upgrade_target_image)
    checkpoint = metadata.get("filesUpgradeCheckpoint") or {}
    prefix = denied_queue_prefix(plan, checkpoint, operation=operation, lease=lease)
    existing = await backend.inspect_files_capability(spec)
    plan.require_observation(existing)
    absence = await asyncio.to_thread(verify_queue_absence, plan, prefix)
    # Recheck configuration after provider reads; CAS below separately fences registry authority.
    plan.require_observation(await backend.inspect_files_capability(spec))
    retry = {
        **checkpoint,
        "phase": "retry_authorized",
        "completed": prefix,
        "recovery": {
            "reason": "queue_create_denied",
            "failedObservation": deepcopy(checkpoint["completed"][-1]),
            "absence": absence,
        },
    }
    updated = {
        **metadata,
        "filesUpgradeCheckpoint": retry,
        "upgradeApproval": {
            **approval,
            "status": "updating",
            "operationState": "installing",
        },
    }
    if not await registry.record_image_upgrade(
        user_id=row["user_id"],
        observed=row,
        expected_lease=lease,
        previous_metadata=metadata,
        backend_metadata=updated,
        retain_lease=True,
        require_unchanged_metadata=True,
    ):
        raise RuntimeError("Files recovery authority changed before continuation")
    # Advance only the acknowledged write. The caller compares its fresh read
    # with this snapshot before executing the already frozen PodSpec.
    return {**row, "backend_metadata": updated}, prefix
