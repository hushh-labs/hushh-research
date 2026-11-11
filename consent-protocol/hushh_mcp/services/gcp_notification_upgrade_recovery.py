"""Orchestrate the reviewed one-owner GCP notification-upgrade recovery."""

from __future__ import annotations

import asyncio
import hashlib
import re
from collections.abc import Awaitable, Callable, Sequence
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, NoReturn

from hushh_mcp.services.gcp_notification_upgrade_recovery_proofs import (
    FAILED_EXECUTOR_SOURCE_SHA,
    REVIEW_EVIDENCE_SHA256,
    REVIEWED_EXECUTOR_REVISION,
    REVIEWED_TARGET_IMAGE,
    NotificationUpgradeRecoveryRefused,
    RecoveryCandidate,
    qualify_candidate,
    verify_failed_event,
)


def _refuse(reason: str) -> NoReturn:
    raise NotificationUpgradeRecoveryRefused(reason)


def _ready_condition(status: dict[str, Any]) -> bool:
    conditions = status.get("conditions")
    if not isinstance(conditions, list):
        return False
    ready = [item for item in conditions if isinstance(item, dict) and item.get("type") == "Ready"]
    return len(ready) == 1 and ready[0].get("status") == "True"


def _serving_container(service: dict[str, Any], candidate: RecoveryCandidate) -> dict[str, Any]:
    spec = service.get("spec")
    template = spec.get("template") if isinstance(spec, dict) else None
    template_meta = template.get("metadata") if isinstance(template, dict) else None
    template_spec = template.get("spec") if isinstance(template, dict) else None
    containers = template_spec.get("containers") if isinstance(template_spec, dict) else None
    annotations = template_meta.get("annotations") if isinstance(template_meta, dict) else None
    if (
        not isinstance(containers, list)
        or len(containers) != 1
        or not isinstance(containers[0], dict)
        or containers[0].get("image") != candidate.previous_ack["image"]
        or not isinstance(annotations, dict)
        or annotations.get("hussh/restart-nonce") != candidate.previous_ack["attemptId"]
    ):
        _refuse("owner Cloud Run template differs from its retained predecessor receipt")
    return containers[0]


def verify_native_predecessor(service: object, candidate: RecoveryCandidate) -> dict[str, Any]:
    """Prove the prior acknowledged image still serves on the same UID/generation."""

    if not isinstance(service, dict):
        _refuse("owner Cloud Run service is unavailable")
    metadata, status = service.get("metadata"), service.get("status")
    if not isinstance(metadata, dict) or not isinstance(status, dict):
        _refuse("owner Cloud Run service response is malformed")
    generation = metadata.get("generation")
    revision = status.get("latestReadyRevisionName")
    if (
        metadata.get("name") != candidate.service_name
        or metadata.get("uid") != candidate.service_uid
        or not isinstance(metadata.get("resourceVersion"), str)
        or not metadata["resourceVersion"]
        or type(generation) is not int
        or generation != candidate.previous_ack["generation"]
        or type(status.get("observedGeneration")) is not int
        or status["observedGeneration"] != generation
        or not isinstance(revision, str)
        or not revision.startswith(candidate.service_name + "-")
        or status.get("latestCreatedRevisionName") != revision
        or not _ready_condition(status)
    ):
        _refuse("owner Cloud Run no longer matches its retained predecessor receipt")
    _serving_container(service, candidate)
    _require_full_traffic(status, revision)
    return _native_receipt(service, candidate, generation, revision)


def _require_full_traffic(status: dict[str, Any], revision: str) -> None:
    traffic = status.get("traffic")
    if (
        not isinstance(traffic, list)
        or len(traffic) != 1
        or not isinstance(traffic[0], dict)
        or traffic[0].get("revisionName") != revision
        or type(traffic[0].get("percent")) is not int
        or traffic[0]["percent"] != 100
    ):
        _refuse("owner Cloud Run predecessor is not the sole serving revision")


def _native_receipt(
    service: dict[str, Any],
    candidate: RecoveryCandidate,
    generation: int,
    revision: str,
) -> dict[str, Any]:
    from hushh_mcp.services.gcp_run_client import GcpRunClient
    from hushh_mcp.services.pod_release import image_digest

    old = candidate.previous_ack
    actual = GcpRunClient.upgrade_acknowledgement(
        service,
        name=candidate.service_name,
        expected_uid=candidate.service_uid,
        attempt_id=old["attemptId"],
    )
    native_keys = ("version", "service", "serviceUid", "generation", "attemptId", "image")
    if any(actual.get(key) != old.get(key) for key in native_keys):
        _refuse("owner Cloud Run changed since its prior acknowledgement")
    digest = image_digest(actual.get("image"))
    if digest != image_digest(old.get("image")):
        _refuse("owner Cloud Run predecessor image changed")
    serving = GcpRunClient.erasure_fence_target(
        service, name=candidate.service_name, expected_uid=candidate.service_uid
    )
    return {
        "service": candidate.service_name,
        "serviceUid": candidate.service_uid,
        "generation": generation,
        "revision": revision,
        "resourceVersion": service["metadata"]["resourceVersion"],
        "attemptId": actual["attemptId"],
        "imageDigest": digest,
        "podUrl": serving["podUrl"],
    }


def verify_released_handoff(
    snapshot: object, candidate: RecoveryCandidate, native: dict[str, Any]
) -> dict[str, Any]:
    """Require authenticated accepting state and the exact sealed release receipt."""
    if not isinstance(snapshot, dict):
        _refuse("authenticated pod handoff evidence is unavailable")
    info, status = snapshot.get("info"), snapshot.get("status")
    receipt = status.get("releaseReceipt") if isinstance(status, dict) else None
    if (
        not isinstance(info, dict)
        or not isinstance(status, dict)
        or info.get("hushhId") != candidate.hushh_id
        or info.get("revision") != native["revision"]
        or status.get("incarnation") != native["revision"]
        or status.get("state") != "accepting"
        or status.get("operationId") is not None
        or type(status.get("activeWork")) is not int
        or status["activeWork"] != 0
        or not _nonempty(status.get("runtimeEpoch"))
        or not isinstance(receipt, dict)
        or receipt.get("operationId") != candidate.operation_id
        or receipt.get("incarnation") != native["revision"]
        or not _nonempty(receipt.get("runtimeEpoch"))
        or receipt.get("expectedIdleRecord") is not None
    ):
        _refuse("sealed handoff release does not match the blocked owner operation")
    cursor = receipt.get("releaseRecord")
    if not isinstance(cursor, dict) or not _valid_cursor(cursor):
        _refuse("sealed handoff release cursor is invalid")
    retained = receipt.get("retainedIdleRecord")
    approved_idle = candidate.approval.get("handoffIdleRecord")
    if approved_idle is not None and retained != approved_idle:
        _refuse("sealed handoff release lost the approved idle record")
    if (
        not isinstance(retained, dict)
        or not _valid_cursor(retained)
        or retained["seq"] >= cursor["seq"]
    ):
        _refuse("sealed handoff release retained an invalid idle cursor")
    return {
        "runtimeEpoch": status["runtimeEpoch"],
        "releaseRuntimeEpoch": receipt["runtimeEpoch"],
        "releaseRecord": deepcopy(cursor),
        "retainedIdleRecord": deepcopy(receipt.get("retainedIdleRecord")),
    }


def _nonempty(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _valid_cursor(value: object) -> bool:
    return (
        isinstance(value, dict)
        and type(value.get("seq")) is int
        and value["seq"] >= 1
        and isinstance(value.get("sha"), str)
        and re.fullmatch(r"[0-9a-f]{64}", value["sha"]) is not None
    )


def rearmed_metadata(
    candidate: RecoveryCandidate,
    *,
    event: dict[str, Any],
    native: dict[str, Any],
    handoff: dict[str, Any],
    running_hub_source: str,
    verified_at: datetime | None = None,
) -> dict[str, Any]:
    """Preserve the approval and failure marker while scheduling the same operation."""
    from copy import deepcopy

    from hushh_mcp.services.personal_agent_provisioning_service import (
        UPGRADE_RETRY_COOLDOWN_SECONDS,
    )

    current = verified_at or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    else:
        current = current.astimezone(timezone.utc)
    updated = deepcopy(candidate.metadata)
    updated.pop("upgradeLease", None)
    updated["upgradeApproval"] = {
        **candidate.approval,
        "status": "scheduled",
        "operationState": "scheduled",
        "presentationPhase": "scheduled",
    }
    updated["upgradeRecovery"] = {
        "version": 1,
        "kind": "gcp_notification_checkpoint_pre_dispatch",
        "recoveredAt": current.isoformat(),
        "cooldownSeconds": UPGRADE_RETRY_COOLDOWN_SECONDS,
        "failedExecutorSource": FAILED_EXECUTOR_SOURCE_SHA,
        "runningHubSource": running_hub_source,
        "operator_verified_source_provenance": {
            "revision": candidate.reviewed_executor_revision,
            "source": FAILED_EXECUTOR_SOURCE_SHA,
            "publicEvidenceSha256": candidate.review_evidence_sha256,
            "provenance": "operator_declared_preserved_public_evidence",
        },
        "releaseId": candidate.release_id,
        "operationId": candidate.operation_id,
        "targetDigest": candidate.target_digest,
        "failedAttempt": 1,
        "failedAttemptAt": candidate.attempted_at.isoformat(),
        "leaseSha256": hashlib.sha256(candidate.lease.encode()).hexdigest(),
        "failureEventSeq": event["seq"],
        "failureEventAt": event["occurredAt"],
        "nativeServiceUid": native["serviceUid"],
        "nativeGeneration": native["generation"],
        "nativeRevision": native["revision"],
        "nativeAckAttemptId": native["attemptId"],
        "nativeImageDigest": native["imageDigest"],
        "previousAckHubRevision": candidate.previous_ack.get("hubRevision") or None,
        "handoffRuntimeEpoch": handoff["runtimeEpoch"],
        "handoffReleaseRuntimeEpoch": handoff["releaseRuntimeEpoch"],
        "handoffReleaseRecord": deepcopy(handoff["releaseRecord"]),
        "handoffRetainedIdleRecord": deepcopy(handoff["retainedIdleRecord"]),
    }
    return updated


async def validate_notification_admission(registry: Any) -> None:
    """Require reviewed runtime readiness and the exact installed SQL validator."""
    from db.private_agent_adoption import NOTIFICATION_CHECKPOINT_SUCCESSOR_SHA256

    if await registry.notification_checkpoint_admission_ready() is not True:
        _refuse("notification checkpoint admission is not ready")
    result = await asyncio.to_thread(
        registry._db().execute_raw,
        """
        SELECT pg_get_functiondef(p.oid) AS definition, p.prosecdef, p.provolatile,
               p.proconfig, p.prorettype::regtype::text AS return_type
        FROM pg_proc p
        WHERE p.oid = to_regprocedure(
          'public.valid_personal_agent_notification_checkpoint(jsonb,jsonb,jsonb)')
        """,
        {},
    )
    rows = list(getattr(result, "data", None) or [])
    if len(rows) != 1:
        _refuse("the notification checkpoint validator is unavailable")
    validator = rows[0]
    definition = validator.get("definition")
    if (
        not isinstance(definition, str)
        or hashlib.sha256(definition.encode("utf-8")).hexdigest()
        != NOTIFICATION_CHECKPOINT_SUCCESSOR_SHA256
        or validator.get("prosecdef") is not False
        or validator.get("provolatile") != "i"
        or validator.get("return_type") != "boolean"
        or validator.get("proconfig") != ["search_path=public"]
    ):
        _refuse("the installed notification checkpoint validator is not the reviewed source")


async def recover_blocked_upgrade(
    *,
    user_id: str,
    row: object,
    target_image: str,
    running_hub_source: str,
    reviewed_operation_id: str,
    reviewed_executor_revision: str,
    review_evidence_sha256: str,
    event_reader: Callable[[RecoveryCandidate], Awaitable[Sequence[dict[str, Any]]]],
    native_reader: Callable[[RecoveryCandidate], Awaitable[dict[str, Any]]],
    handoff_reader: Callable[[RecoveryCandidate, dict[str, Any]], Awaitable[dict[str, Any]]],
    notification_validator: Callable[[], Awaitable[None]],
    writer: Callable[..., Awaitable[bool]],
    execute: bool = False,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Verify live owner proofs, then optionally perform the unchanged-metadata CAS."""
    candidate = qualify_candidate(
        row,
        user_id=user_id,
        target_image=target_image,
        running_hub_source=running_hub_source,
        reviewed_operation_id=reviewed_operation_id,
        reviewed_executor_revision=reviewed_executor_revision,
        review_evidence_sha256=review_evidence_sha256,
        now=now,
    )
    await notification_validator()
    failure = verify_failed_event(await event_reader(candidate), candidate)
    first = verify_native_predecessor(await native_reader(candidate), candidate)
    handoff = verify_released_handoff(await handoff_reader(candidate, first), candidate, first)
    second = verify_native_predecessor(await native_reader(candidate), candidate)
    if second != first:
        _refuse("owner Cloud Run changed while handoff evidence was being read")
    updated = rearmed_metadata(
        candidate,
        event=failure,
        native=second,
        handoff=handoff,
        running_hub_source=running_hub_source,
        verified_at=now,
    )
    if not execute:
        return {"status": "dry_run", "operationId": candidate.operation_id}
    published = await writer(
        user_id=user_id,
        backend_metadata=updated,
        expected_lease=candidate.lease,
        previous_metadata=candidate.metadata,
        observed=row,
        retain_lease=False,
        require_unchanged_metadata=True,
    )
    if published is not True:
        _refuse("owner registry changed before the recovery compare-and-swap")
    return {"status": "scheduled", "operationId": candidate.operation_id}


__all__ = [
    "FAILED_EXECUTOR_SOURCE_SHA",
    "REVIEWED_EXECUTOR_REVISION",
    "REVIEW_EVIDENCE_SHA256",
    "REVIEWED_TARGET_IMAGE",
    "NotificationUpgradeRecoveryRefused",
    "RecoveryCandidate",
    "qualify_candidate",
    "recover_blocked_upgrade",
    "rearmed_metadata",
    "validate_notification_admission",
    "verify_failed_event",
    "verify_native_predecessor",
    "verify_released_handoff",
]
