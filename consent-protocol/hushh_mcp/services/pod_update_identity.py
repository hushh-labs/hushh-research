"""One release identity for image-only and explicitly approved capability updates."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from hushh_mcp.services.pod_release import image_digest

if TYPE_CHECKING:
    from hushh_mcp.services.azure_vm_host_binding import AzureVmHostBinding


def verified_image_changed(
    previous: dict[str, Any], target: str, observation: dict[str, Any]
) -> bool:
    """Compare saved image identities after provider verification, not tag labels."""
    prior = previous.get("image_digest") or previous.get("source_image") or previous.get("image")
    return observation.get("upgraded") is not False and image_digest(prior) != image_digest(target)


def verified_upgrade_approval(approval: object) -> dict[str, Any] | None:
    """Label an externally verified completion, preserving the exact approval.

    Call only after the owning upgrade path verifies the provider result. This
    projection neither approves an installation nor changes its identity.
    """
    if not isinstance(approval, dict) or not approval.get("operationId"):
        return None
    return {
        **approval,
        "status": "succeeded",
        "operationState": "succeeded",
        "presentationPhase": "verified",
        "verifiedAt": datetime.now(timezone.utc).isoformat(),
    }


def merged_upgrade_metadata(previous: dict, handle: dict, *, vm: AzureVmHostBinding | None) -> dict:
    """Keep publication atomic; the owning SQL guard verifies VM retirement."""
    merged = {**previous, **handle}
    if vm is not None:
        merged.pop("vmPower", None)
    return merged


def release_identity(
    hushh_id: str,
    incarnation: str,
    target_image: str,
    *,
    capability_digest: str | None = None,
    browser_digest: str | None = None,
) -> str:
    # Preserve every existing image-only identifier. Capability approval is a
    # distinct release, including when the image digest is already installed.
    fields: tuple[str, ...] = (hushh_id.strip(), incarnation.strip(), target_image.strip())
    if capability_digest is not None and browser_digest is not None:
        raise ValueError("capability approvals cannot be combined")
    if capability_digest is not None:
        if re.fullmatch(r"[0-9a-f]{64}", capability_digest) is None:
            raise ValueError("invalid capability approval digest")
        fields += ("files.v1", capability_digest)
    if browser_digest is not None:
        if re.fullmatch(r"[0-9a-f]{64}", browser_digest) is None:
            raise ValueError("invalid Browser approval digest")
        fields += ("browser.v1", browser_digest)
    return "rel_" + hashlib.sha256("|".join(fields).encode()).hexdigest()[:32]


def approved_files_plan(approval: dict):
    """Validate a saved plan independently of the currently offered image."""
    from hushh_mcp.services.pod_files.capability_contract import decode_plan

    if approval.get("version") == 2:
        approved_browser_plan(approval)
        return None
    if approval.get("browserPlan") is not None or approval.get("browserPlanDigest") is not None:
        raise ValueError("Browser requires its explicit approval version")
    digest = approval.get("capabilityPlanDigest")
    encoded = approval.get("capabilityPlan")
    if digest is None and encoded is None:
        return None
    plan = decode_plan(encoded)
    if (
        digest != plan.digest
        or approval.get("ownerId") != plan.ownerId
        or approval.get("hushhId") != plan.hushhId
        or approval.get("podIncarnation") != plan.serviceUid
        or approval.get("targetImage") != plan.targetImage
    ):
        raise ValueError("Files approval does not match the saved owner and pod plan")
    return plan


def approved_browser_plan(approval: dict):
    """Decode only the separately approved Browser configuration envelope."""
    from hushh_mcp.services.pod_browser.capability_update import GcpBrowserCapabilityPlan

    encoded, digest = approval.get("browserPlan"), approval.get("browserPlanDigest")
    if encoded is None and digest is None and approval.get("version") != 2:
        return None
    if (
        approval.get("version") != 2
        or approval.get("capability") != "browser"
        or approval.get("capabilityPlan") is not None
        or approval.get("capabilityPlanDigest") is not None
    ):
        raise ValueError("Browser requires an independent capability approval")
    plan = GcpBrowserCapabilityPlan.model_validate_json(json.dumps(encoded))
    if (
        digest != plan.digest
        or approval.get("ownerId") != plan.ownerId
        or approval.get("hushhId") != plan.hushhId
        or approval.get("podIncarnation") != plan.serviceUid
        or approval.get("targetImage") != plan.targetImage
        or (
            "releaseId" in approval
            and approval["releaseId"]
            != release_identity(
                plan.hushhId, plan.serviceUid, plan.targetImage, browser_digest=plan.digest
            )
        )
    ):
        raise ValueError("Browser approval does not match its saved owner and pod plan")
    return plan


def configuration_approval_pending(approval: object) -> bool:
    return isinstance(approval, dict) and bool(
        approval.get("capabilityPlanDigest") or approval.get("browserPlanDigest")
    )
