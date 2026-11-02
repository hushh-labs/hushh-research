"""Pure proof checks for one reviewed GCP notification-checkpoint recovery."""

from __future__ import annotations

import hashlib
import re
from collections.abc import Sequence
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, NoReturn

FAILED_EXECUTOR_SOURCE_SHA = "351d975545b490769fa28bc2ebff6cc61f9ddd37"
REVIEWED_EXECUTOR_REVISION = (
    "projects/hushh-pda-dev/locations/us-central1/services/consent-protocol/"
    "revisions/consent-protocol-00341-crm"
)
REVIEW_EVIDENCE_SHA256 = "423b115956a57fef8ebc5fa8dde425c2db8205a1379bd407c80217b8cb553eb4"
REVIEWED_TARGET_IMAGE = (
    "gcr.io/hushh-pda-dev/consent-protocol-pod@sha256:"
    "3c3615f2a6e3dbfaa436d061b3580b0a416c56a9507ab8083f6f1aaa7df42610"
)
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_SOURCE_SHA = re.compile(r"[0-9a-f]{40}\Z")
_IMMUTABLE_IMAGE = re.compile(r"[^\s@]+@sha256:[0-9a-f]{64}\Z")


class NotificationUpgradeRecoveryRefused(RuntimeError):
    """The owner-scoped recovery proof is incomplete or no longer current."""


@dataclass(frozen=True)
class RecoveryCandidate:
    user_id: str
    hushh_id: str
    service_name: str
    service_uid: str
    lease: str
    attempt_id: str
    operation_id: str
    release_id: str
    target_image: str
    target_digest: str
    attempted_at: datetime
    metadata: dict[str, Any]
    approval: dict[str, Any]
    marker: dict[str, Any]
    previous_ack: dict[str, Any]
    reviewed_executor_revision: str
    review_evidence_sha256: str


def _refuse(reason: str) -> NoReturn:
    raise NotificationUpgradeRecoveryRefused(reason)


def _utc(value: object) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str) and value.strip():
        try:
            parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _validate_review_inputs(
    *,
    target_image: str,
    running_hub_source: str,
    reviewed_operation_id: str,
    reviewed_executor_revision: str,
    review_evidence_sha256: str,
) -> None:
    if target_image != REVIEWED_TARGET_IMAGE or _IMMUTABLE_IMAGE.fullmatch(target_image) is None:
        _refuse("target image is outside the reviewed recovery case")
    if (
        not isinstance(running_hub_source, str)
        or _SOURCE_SHA.fullmatch(running_hub_source) is None
        or running_hub_source == FAILED_EXECUTOR_SOURCE_SHA
    ):
        _refuse("recovery must run from a distinct qualified hub source")
    if not isinstance(reviewed_operation_id, str) or not reviewed_operation_id.strip():
        _refuse("an explicit reviewed owner operation is required")
    if reviewed_executor_revision != REVIEWED_EXECUTOR_REVISION:
        _refuse("executor revision does not match the reviewed source evidence")
    if review_evidence_sha256 != REVIEW_EVIDENCE_SHA256:
        _refuse("public executor evidence does not match the reviewed capture")


def _validate_owner_approval(
    row: dict[str, Any], *, user_id: str, target_image: str, operation_id: str
) -> tuple[dict[str, Any], dict[str, Any]]:
    from hushh_mcp.services.personal_agent_provisioning_service import (
        _approval_is_well_formed,
        upgrade_approval_matches,
    )

    metadata = row.get("backend_metadata")
    approval = metadata.get("upgradeApproval") if isinstance(metadata, dict) else None
    if row.get("user_id") != user_id or row.get("deployment_target") != "user_gcp":
        _refuse("registry row is not the requested owner's GCP pod")
    if row.get("status") != "provisioned" or not isinstance(metadata, dict):
        _refuse("owner registry row is not provisioned")
    if (
        not isinstance(approval, dict)
        or approval.get("version") != 1
        or approval.get("status") != "blocked"
        or approval.get("operationState") != "blocked"
        or approval.get("presentationPhase") != "blocked"
        or approval.get("operationId") != operation_id
        or not _approval_is_well_formed(row, approval, allow_unresolved=True)
        or not upgrade_approval_matches(row, target_image, allow_unresolved=True)
    ):
        _refuse("no matching blocked owner approval is available")
    if any(
        approval.get(key) is not None
        for key in ("capabilityPlan", "capabilityPlanDigest", "browserPlan", "browserPlanDigest")
    ):
        _refuse("recovery is limited to image-only owner approvals")
    return metadata, approval


def _validate_lease_and_failure(
    metadata: dict[str, Any], *, target_image: str, now: datetime | None
) -> tuple[str, datetime, dict[str, Any]]:
    from hushh_mcp.services.personal_agent_feed import FEED_REASON_TEMPORARY
    from hushh_mcp.services.personal_agent_provisioning_service import (
        UPGRADE_RETRY_COOLDOWN_SECONDS,
    )

    lease_value = metadata.get("upgradeLease")
    marker_value = metadata.get("upgrade")
    if not isinstance(lease_value, str) or not isinstance(marker_value, dict):
        _refuse("the unresolved owner lease or failure marker is unavailable")
    lease = lease_value
    marker: dict[str, Any] = marker_value
    parts = lease.split("|", 2)
    attempted = _utc(marker.get("lastAttemptAt"))
    attempts = marker.get("attempts")
    lease_started = _utc(parts[0]) if len(parts) == 3 else None
    current = _utc(now) or datetime.now(timezone.utc)
    if (
        len(parts) != 3
        or parts[2] != target_image
        or lease_started is None
        or re.fullmatch(r"[0-9a-f]{32}", parts[1]) is None
        or marker.get("outcome") != "unresolved"
        or marker.get("failedImage") != target_image
        or marker.get("lastError") != FEED_REASON_TEMPORARY
        or type(attempts) is not int
        or attempts != 1
        or attempted is None
        or lease_started > attempted
        or (current - attempted).total_seconds() < UPGRADE_RETRY_COOLDOWN_SECONDS
        or metadata.get("upgradeRecovery") is not None
    ):
        _refuse("the owner failure is not eligible for this one-attempt recovery")
    return lease, attempted, marker


def _validate_previous_ack(
    row: dict[str, Any],
    metadata: dict[str, Any],
    target_image: str,
    *,
    operation_id: str,
    release_id: str,
) -> tuple[str, str, dict[str, Any], str]:
    from hushh_mcp.services.pod_release import image_digest

    hushh_id = str(row.get("hushh_id") or "").strip()
    service_name = str(row.get("external_agent_id") or "").strip()
    service_uid = str(metadata.get("serviceUid") or "").strip()
    acknowledgement = metadata.get("upgradeAcknowledgement")
    hub_revision = acknowledgement.get("hubRevision") if isinstance(acknowledgement, dict) else None
    if (
        not hushh_id
        or not service_name
        or not service_uid
        or not isinstance(acknowledgement, dict)
        or type(acknowledgement.get("version")) is not int
        or acknowledgement.get("version") != 1
        or acknowledgement.get("service") != service_name
        or acknowledgement.get("serviceUid") != service_uid
        or not isinstance(acknowledgement.get("operationId"), str)
        or not acknowledgement["operationId"].strip()
        or acknowledgement["operationId"] == operation_id
        or not isinstance(acknowledgement.get("releaseId"), str)
        or not acknowledgement["releaseId"].strip()
        or acknowledgement["releaseId"] == release_id
        or acknowledgement.get("podIncarnation") != service_uid
        or acknowledgement.get("outcome") != "ready"
        or not isinstance(acknowledgement.get("attemptId"), str)
        or _SHA256.fullmatch(acknowledgement["attemptId"]) is None
        # Some valid legacy receipts predate reliable K_REVISION attribution.
        # The recovery flow independently proves the exact native predecessor
        # (UID, generation, image, restart nonce, readiness and 100% traffic)
        # before it can write, so an absent/empty hub revision is not a reason
        # to strand an otherwise fully verifiable approved operation.
        or (
            hub_revision not in (None, "")
            and (
                not isinstance(hub_revision, str)
                or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", hub_revision) is None
            )
        )
        or type(acknowledgement.get("generation")) is not int
        or acknowledgement["generation"] < 1
        or not isinstance(acknowledgement.get("image"), str)
        or _IMMUTABLE_IMAGE.fullmatch(acknowledgement["image"]) is None
        or not isinstance(acknowledgement.get("targetImage"), str)
        or _IMMUTABLE_IMAGE.fullmatch(acknowledgement["targetImage"]) is None
    ):
        _refuse("the retained native predecessor acknowledgement is incomplete")
    target_digest = image_digest(target_image)
    old_digest = image_digest(acknowledgement["image"])
    acknowledged_target_digest = image_digest(acknowledgement["targetImage"])
    if (
        not target_digest
        or not old_digest
        or old_digest != acknowledged_target_digest
        or target_digest == old_digest
    ):
        _refuse("the approval is not a forward image change")
    if acknowledgement.get("targetDigest") != old_digest:
        _refuse("the retained provider acknowledgement is not bound to its image")
    if metadata.get("image_digest") and image_digest(metadata["image_digest"]) != old_digest:
        _refuse("registry image and retained native acknowledgement disagree")
    return hushh_id, service_name, acknowledgement, target_digest


def _refuse_current_attempt_receipts(
    metadata: dict[str, Any], operation_id: str, attempt_id: str
) -> None:
    checkpoint = metadata.get("notificationCheckpoint")
    if isinstance(checkpoint, dict) and (
        checkpoint.get("attemptId") == attempt_id
        or checkpoint.get("phase") == "intent"
        or (checkpoint.get("operationId") == operation_id and checkpoint.get("phase") != "observed")
    ):
        _refuse("a notification checkpoint may already have dispatched")
    keys = (
        "upgradeAcknowledgement",
        "filesUpgradeCheckpoint",
        "browserUpgradeCheckpoint",
        "browserUpdateCheckpoint",
    )
    for key in keys:
        receipt = metadata.get(key)
        if isinstance(receipt, dict) and (
            receipt.get("attemptId") == attempt_id or receipt.get("operationId") == operation_id
        ):
            _refuse("a current-attempt provider receipt is already present")


def qualify_candidate(
    row: object,
    *,
    user_id: str,
    target_image: str,
    running_hub_source: str,
    reviewed_operation_id: str,
    reviewed_executor_revision: str,
    review_evidence_sha256: str,
    now: datetime | None = None,
) -> RecoveryCandidate:
    """Bind the explicit review evidence to one blocked owner row and lease."""
    _validate_review_inputs(
        target_image=target_image,
        running_hub_source=running_hub_source,
        reviewed_operation_id=reviewed_operation_id,
        reviewed_executor_revision=reviewed_executor_revision,
        review_evidence_sha256=review_evidence_sha256,
    )
    if not isinstance(row, dict):
        _refuse("owner registry row is unavailable")
    metadata, approval = _validate_owner_approval(
        row, user_id=user_id, target_image=target_image, operation_id=reviewed_operation_id
    )
    lease, attempted, marker = _validate_lease_and_failure(
        metadata, target_image=target_image, now=now
    )
    hushh_id, service_name, previous_ack, target_digest = _validate_previous_ack(
        row,
        metadata,
        target_image,
        operation_id=reviewed_operation_id,
        release_id=str(approval["releaseId"]),
    )
    attempt_id = hashlib.sha256(lease.encode()).hexdigest()
    _refuse_current_attempt_receipts(metadata, reviewed_operation_id, attempt_id)
    return RecoveryCandidate(
        user_id=user_id,
        hushh_id=hushh_id,
        service_name=service_name,
        service_uid=str(metadata["serviceUid"]),
        lease=lease,
        attempt_id=attempt_id,
        operation_id=reviewed_operation_id,
        release_id=str(approval["releaseId"]),
        target_image=target_image,
        target_digest=target_digest,
        attempted_at=attempted,
        metadata=deepcopy(metadata),
        approval=deepcopy(approval),
        marker=deepcopy(marker),
        previous_ack=deepcopy(previous_ack),
        reviewed_executor_revision=reviewed_executor_revision,
        review_evidence_sha256=review_evidence_sha256,
    )


def verify_failed_event(
    events: Sequence[dict[str, Any]], candidate: RecoveryCandidate
) -> dict[str, Any]:
    """Require one owner-bound failure as the newest event after its attempt."""
    if len(events) >= 64:
        _refuse("owner lifecycle evidence is ambiguous")
    ordered: list[tuple[datetime, int, dict[str, Any]]] = []
    for event in events:
        occurred = _utc(event.get("occurred_at"))
        seq = event.get("seq")
        if (
            event.get("user_id") != candidate.user_id
            or event.get("hushh_id") != candidate.hushh_id
            or type(event.get("attempt")) is not int
            or event["attempt"] != 1
            or occurred is None
            or occurred < candidate.attempted_at
            or type(seq) is not int
            or seq < 1
        ):
            _refuse("owner lifecycle event does not bind the failed attempt")
        ordered.append((occurred, seq, event))
    failures = [entry for entry in ordered if entry[2].get("event") == "upgrade_failed"]
    if len(failures) != 1 or not ordered:
        _refuse("the owner failure event is missing or repeated")
    failure = failures[0]
    event = failure[2]
    if (
        max(ordered, key=lambda entry: (entry[0], entry[1])) != failure
        or event.get("stage") != "authority_live"
        or event.get("registry_status") != "provisioned"
        or event.get("reason") != candidate.marker.get("lastError")
    ):
        _refuse("the owner failure event is superseded or differs from its marker")
    return {"seq": failure[1], "occurredAt": failure[0].isoformat(), "reason": event["reason"]}


__all__ = [
    "FAILED_EXECUTOR_SOURCE_SHA",
    "REVIEWED_EXECUTOR_REVISION",
    "REVIEW_EVIDENCE_SHA256",
    "REVIEWED_TARGET_IMAGE",
    "NotificationUpgradeRecoveryRefused",
    "RecoveryCandidate",
    "qualify_candidate",
    "verify_failed_event",
]
