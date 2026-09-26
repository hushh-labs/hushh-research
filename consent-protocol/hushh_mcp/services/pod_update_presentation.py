"""Read-only projections of retained pod upgrade approvals and release offers."""

from datetime import datetime, timezone
from typing import Optional

from hushh_mcp.services.personal_agent_provisioning_service import (
    upgrade_approval_matches,
    upgrade_operation_is_recoverable,
)
from hushh_mcp.services.pod_release import upgrade_is_supported


def _blocked_update(row: Optional[dict]) -> dict:
    """Project unresolved provider work without changing its recovery authority."""
    metadata = (row or {}).get("backend_metadata") or {}
    approval = metadata.get("upgradeApproval")
    if not (
        isinstance(approval, dict)
        and approval.get("status") == "blocked"
        and upgrade_operation_is_recoverable(row)
        and upgrade_approval_matches(row, approval.get("targetImage"), allow_unresolved=True)
    ):
        return {}
    message = "The update outcome could not be verified. Check again while recovery continues."
    return {
        "updateFailed": True,
        "updateOfferable": False,
        "updateError": message,
        "update": {
            "releaseId": approval["releaseId"],
            "operationId": approval["operationId"],
            "presentationState": "blocked",
            "summary": message,
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
    out["updateOfferable"] = upgrade_is_supported(release_metadata, installed_digest) and (
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
            if approval.get("operationId"):
                update["operationId"] = str(approval["operationId"])
    out["update"] = update
    return out
