"""Observe a lost Browser configuration response without another replacement."""

from __future__ import annotations

import hashlib
import json
from dataclasses import replace

from hushh_mcp.services.gcp_run_client import GcpRunClient
from hushh_mcp.services.pod_release import image_digest

from .capability_update import GcpBrowserCapabilityPlan


async def discover_replacement(*, row: dict, spec, backend, lease: str) -> dict | None:
    inspect = getattr(backend, "inspect_pod_configuration", None)
    if spec.browser_upgrade_plan is None or inspect is None or not lease:
        return None
    plan = GcpBrowserCapabilityPlan.model_validate_json(json.dumps(spec.browser_upgrade_plan))
    plan.require_owner(row, spec.upgrade_target_image)
    plan.require_qualification(spec.browser_qualification)
    attempt = hashlib.sha256(lease.encode()).hexdigest()
    observed = await inspect(replace(spec, upgrade_attempt_id=attempt))
    try:
        receipt = GcpRunClient.upgrade_acknowledgement(
            observed, name=plan.service, expected_uid=plan.serviceUid, attempt_id=attempt
        )
        plan.require_installed(observed)
    except (ValueError, RuntimeError):
        return None
    return {
        **receipt,
        "targetImage": plan.targetImage,
        "targetDigest": image_digest(plan.targetImage),
        "operationId": spec.upgrade_operation_id,
        "releaseId": row["backend_metadata"]["upgradeApproval"]["releaseId"],
        "podIncarnation": plan.serviceUid,
    }
