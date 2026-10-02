"""One release identity for image-only and explicitly approved capability updates."""

from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone
from typing import Any

from hushh_mcp.services.pod_release import image_digest


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


def release_identity(
    hushh_id: str, incarnation: str, target_image: str, *, capability_digest: str | None = None
) -> str:
    # Preserve every existing image-only identifier. Capability approval is a
    # distinct release, including when the image digest is already installed.
    fields = (hushh_id.strip(), incarnation.strip(), target_image.strip())
    if capability_digest is not None:
        if re.fullmatch(r"[0-9a-f]{64}", capability_digest) is None:
            raise ValueError("invalid capability approval digest")
        fields += ("files.v1", capability_digest)
    return "rel_" + hashlib.sha256("|".join(fields).encode()).hexdigest()[:32]


def approved_files_plan(approval: dict):
    """Validate a saved plan independently of the currently offered image."""
    from hushh_mcp.services.pod_files.capability_update import FilesCapabilityPlan

    digest = approval.get("capabilityPlanDigest")
    encoded = approval.get("capabilityPlan")
    if digest is None and encoded is None:
        return None
    plan = FilesCapabilityPlan.model_validate(encoded)
    if (
        digest != plan.digest
        or approval.get("ownerId") != plan.ownerId
        or approval.get("hushhId") != plan.hushhId
        or approval.get("podIncarnation") != plan.serviceUid
        or approval.get("targetImage") != plan.targetImage
    ):
        raise ValueError("Files approval does not match the saved owner and pod plan")
    return plan
