"""One release identity for image-only and explicitly approved capability updates."""

from __future__ import annotations

import hashlib
import re


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
