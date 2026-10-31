"""Observe a lost Browser configuration response without another replacement."""

from __future__ import annotations

import hashlib
from dataclasses import replace

from hushh_mcp.services.gcp_run_client import GcpRunClient
from hushh_mcp.services.pod_release import image_digest


async def discover_replacement(*, row: dict, spec, backend, lease: str) -> dict | None:
    inspect = getattr(backend, "inspect_pod_configuration", None)
    if spec.browser_upgrade_plan is None or inspect is None or not lease:
        return None
    from hushh_mcp.services.pod_update_identity import approved_browser_plan

    plan = approved_browser_plan(row["backend_metadata"]["upgradeApproval"])
    if plan is None or plan.model_dump(mode="json") != spec.browser_upgrade_plan:
        raise ValueError("Browser recovery approval changed")
    plan.require_owner(row, spec.upgrade_target_image)
    plan.require_qualification(spec.browser_qualification)
    attempt = hashlib.sha256(lease.encode()).hexdigest()
    observed = await inspect(replace(spec, upgrade_attempt_id=attempt))
    try:
        if plan.hostKind == "azure_container_apps":
            from hushh_mcp.services.azure_agent_upgrade import revision_suffix

            revision = "ca-hussh-one-pod--" + revision_suffix(attempt)
            properties = observed.get("properties") or {}
            if (
                properties.get("latestRevisionName") != revision
                or properties.get("latestReadyRevisionName") != revision
            ):
                return None
            receipt = {
                "version": 1,
                "service": plan.installation.service,
                "serviceUid": plan.serviceUid,
                "attemptId": attempt,
                "revision": revision,
                "image": properties["template"]["containers"][0]["image"],
            }
        else:
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
