"""Read-only projections of retained pod upgrade approvals and release offers."""

import os
from datetime import datetime, timezone
from typing import Optional

from hushh_mcp.services.personal_agent_provisioning_service import (
    upgrade_approval_matches,
    upgrade_operation_is_recoverable,
)
from hushh_mcp.services.pod_release import (
    image_digest,
    public_release,
    upgrade_is_supported,
    validate_release,
)


def _active_phase(approval: dict, metadata: dict) -> str:
    """Use only milestones persisted for this exact update operation."""
    if approval.get("status") != "updating":
        return "scheduled"
    receipt = metadata.get("upgradeAcknowledgement")
    if (
        approval.get("presentationPhase") == "verifying"
        and approval.get("providerAcknowledgedAt")
        and isinstance(receipt, dict)
        and receipt.get("operationId") == approval.get("operationId")
        and receipt.get("releaseId") == approval.get("releaseId")
        and receipt.get("podIncarnation") == approval.get("podIncarnation")
        and receipt.get("targetDigest") == image_digest(approval.get("targetImage"))
    ):
        return "verifying"
    if (
        approval.get("presentationPhase") in {"installing", "verifying"}
        and approval.get("handoffIdleAt")
        and approval.get("handoffIncarnation")
    ):
        return "installing"
    return "preparing"


def _blocked_update(row: Optional[dict]) -> dict:
    """Project unresolved provider work without changing its recovery authority."""
    metadata = (row or {}).get("backend_metadata") or {}
    approval = metadata.get("upgradeApproval")
    if (
        not approval
        and metadata.get("upgradeLease") is not None
        and (metadata.get("upgrade") or {}).get("outcome") == "unresolved"
    ):
        message = "An earlier update needs recovery before software updates can continue."
        return {
            "updateFailed": True,
            "updateOfferable": False,
            "updateInstallable": False,
            "updateError": message,
            "update": {"presentationState": "blocked", "phase": "blocked", "summary": message},
        }
    if not (
        isinstance(approval, dict)
        and approval.get("status") == "blocked"
        and upgrade_operation_is_recoverable(row)
        and upgrade_approval_matches(row, approval.get("targetImage"), allow_unresolved=True)
    ):
        return {}
    message = "The update outcome could not be verified. Check again while recovery continues."
    if approval.get("capabilityPlan") and metadata.get("filesUpgradeCheckpoint"):
        message = (
            "Files setup could not be verified. Existing information is preserved. "
            "Setup needs reconciliation before another update can start."
        )
    return {
        "updateFailed": True,
        "updateOfferable": False,
        "updateInstallable": False,
        "updateError": message,
        "update": {
            "releaseId": approval["releaseId"],
            "operationId": approval["operationId"],
            "presentationState": "blocked",
            "phase": "blocked",
            "summary": message,
        },
    }


def _active_update(row: Optional[dict]) -> dict:
    """Follow the approved operation even when the hub publishes a newer offer."""
    metadata = (row or {}).get("backend_metadata") or {}
    approval = metadata.get("upgradeApproval")
    if not isinstance(approval, dict) or approval.get("status") not in {
        "approved",
        "scheduled",
        "updating",
    }:
        return {}
    if not upgrade_approval_matches(row, approval.get("targetImage")):
        return {}
    state = "scheduled" if approval["status"] == "approved" else approval["status"]
    release = None
    try:
        release = public_release(
            validate_release(
                approval.get("releaseMetadata"),
                target_image=approval["targetImage"],
                environment=os.getenv("HUSHH_DEPLOY_ENV", ""),
            )
        )
    except (ValueError, TypeError):
        pass
    return {
        "updateOfferable": False,
        "updateInstallable": False,
        "updateInProgress": True,
        "availableRelease": release,
        "update": {
            "releaseId": approval["releaseId"],
            "operationId": approval["operationId"],
            "presentationState": state,
            "phase": _active_phase(approval, metadata),
        },
    }


def _update_offer(
    metadata: dict, release: str, release_metadata: Optional[dict], installed_digest: Optional[str]
) -> dict:
    out: dict = {}
    # Keep an unverified target visible to operators as a diagnostic, but do
    # not turn it into an owner-actionable offer.
    # A deferred offer stays in the status response for quiet access, but it
    # must not create a Feed card until the server deadline.  The deadline
    # is authoritative; clients cannot manufacture an early reminder.
    deferred_due = False
    if isinstance(metadata.get("upgradeDeferral"), dict):
        deferral = metadata["upgradeDeferral"]
        if deferral.get("releaseId") == release:
            reminder = str(deferral.get("remindAt") or "").strip()
            if reminder:
                try:
                    due = datetime.fromisoformat(reminder.replace("Z", "+00:00"))
                    if due.tzinfo is None:
                        due = due.replace(tzinfo=timezone.utc)
                    deferred_due = due <= datetime.now(timezone.utc)
                except ValueError:
                    deferred_due = False
    # Deferral silences Feed reminders, never the owner’s explicit Settings choice.
    out["updateInstallable"] = metadata.get("upgradeLease") is None and upgrade_is_supported(
        release_metadata, installed_digest
    )
    out["updateOfferable"] = out["updateInstallable"] and (
        not isinstance(metadata.get("upgradeDeferral"), dict)
        or metadata["upgradeDeferral"].get("releaseId") != release
        or deferred_due
    )
    approval = metadata.get("upgradeApproval")
    deferral = metadata.get("upgradeDeferral")
    update: dict[str, object] = {
        "releaseId": release,
        "summary": (
            release_metadata["descriptor"]["summary"]
            if release_metadata
            else "Software update compatibility has not been verified."
        ),
        "presentationState": "ready",
    }
    if isinstance(deferral, dict) and deferral.get("releaseId") == release:
        reminder = str(deferral.get("remindAt") or "").strip()
        if reminder:
            update["remindAt"] = reminder
            if "reminderGeneration" in deferral:
                try:
                    due = datetime.fromisoformat(reminder.replace("Z", "+00:00"))
                    if due.tzinfo is None:
                        due = due.replace(tzinfo=timezone.utc)
                    update["reminderDue"] = due <= datetime.now(timezone.utc)
                except ValueError:
                    update["reminderDue"] = False
        update["presentationState"] = "deferred"
    if isinstance(approval, dict) and approval.get("releaseId") == release:
        status = str(approval.get("status") or "").strip()
        if status in {"approved", "scheduled", "updating"}:
            update["presentationState"] = "scheduled" if status == "approved" else status
            update["phase"] = _active_phase(approval, metadata)
            if approval.get("operationId"):
                update["operationId"] = str(approval["operationId"])
    out["update"] = update
    return out
