"""Exact, read-only Cloud Run observations used to settle provider upgrades."""

from __future__ import annotations

import re
from typing import Any, Optional


def _qualified_image_digest(reference: Any) -> str | None:
    if not isinstance(reference, str):
        return None
    match = re.fullmatch(r".+@(sha256:[0-9a-f]{64})", reference)
    return match.group(1) if match else None


def service_uid(service: Optional[dict[str, Any]]) -> str:
    metadata = service.get("metadata") if isinstance(service, dict) else None
    uid = metadata.get("uid") if isinstance(metadata, dict) else None
    if not isinstance(uid, str) or not uid.strip():
        raise RuntimeError("Cloud Run service incarnation unverified")
    return uid


def require_service_uid(service: Optional[dict[str, Any]], expected_uid: str) -> None:
    if (
        not isinstance(expected_uid, str)
        or not expected_uid.strip()
        or service_uid(service) != expected_uid
    ):
        raise RuntimeError("Cloud Run service incarnation changed or unverified")


def upgrade_acknowledgement(
    service: dict[str, Any], *, name: str, expected_uid: str, attempt_id: str
) -> dict[str, Any]:
    """Narrow receipt from the replacement response; never a readiness claim."""
    require_service_uid(service, expected_uid)
    metadata = service.get("metadata") or {}
    template = (service.get("spec") or {}).get("template") or {}
    nonce = ((template.get("metadata") or {}).get("annotations") or {}).get("hussh/restart-nonce")
    generation = metadata.get("generation")
    containers = (template.get("spec") or {}).get("containers") or []
    image = containers[0].get("image") if containers and isinstance(containers[0], dict) else None
    if (
        not attempt_id
        or nonce != attempt_id
        or metadata.get("name") != name
        or not isinstance(generation, int)
        or isinstance(generation, bool)
        or generation < 1
        or not isinstance(image, str)
        or not image.strip()
    ):
        raise RuntimeError("Cloud Run upgrade acknowledgement unverified")
    return {
        "version": 1,
        "service": name,
        "serviceUid": expected_uid,
        "generation": generation,
        "attemptId": attempt_id,
        "image": image,
    }


def hosted_files_predecessor_observation(
    service: dict[str, Any], *, name: str, expected_uid: str
) -> dict[str, Any]:
    """Capture the exact v1 serving predecessor before an admitted PUT."""
    require_service_uid(service, expected_uid)
    metadata = service.get("metadata") or {}
    status = service.get("status") or {}
    generation = metadata.get("generation")
    observed_generation = status.get("observedGeneration")
    revision = status.get("latestReadyRevisionName")
    containers = (((service.get("spec") or {}).get("template") or {}).get("spec") or {}).get(
        "containers"
    ) or []
    annotations = (((service.get("spec") or {}).get("template") or {}).get("metadata") or {}).get(
        "annotations"
    ) or {}
    traffic = status.get("traffic") or []
    image = (
        containers[0].get("image")
        if len(containers) == 1 and isinstance(containers[0], dict)
        else None
    )
    nonce = annotations.get("hussh/restart-nonce")
    if (
        metadata.get("name") != name
        or not isinstance(metadata.get("resourceVersion"), str)
        or not metadata["resourceVersion"].strip()
        or type(generation) is not int
        or generation < 1
        or type(observed_generation) is not int
        or observed_generation != generation
        or not isinstance(revision, str)
        or not revision.startswith(name + "-")
        or status.get("latestCreatedRevisionName") != revision
        or len(traffic) != 1
        or traffic[0].get("revisionName") != revision
        or type(traffic[0].get("percent")) is not int
        or traffic[0].get("percent") != 100
        or not isinstance(image, str)
        or not image.strip()
        or (nonce is not None and (not isinstance(nonce, str) or not nonce))
    ):
        raise RuntimeError("Cloud Run serving predecessor is not exact and current")
    return {
        "version": 1,
        "service": name,
        "serviceUid": expected_uid,
        "generation": generation,
        "resourceVersion": metadata["resourceVersion"],
        "revision": revision,
        "image": image,
        "nonce": nonce,
    }


def _generation_value(value: Any) -> int | None:
    if type(value) is int and value > 0:
        return value
    if isinstance(value, str) and re.fullmatch(r"[1-9][0-9]*", value):
        return int(value)
    return None


def _conditions_are_terminal(values: Any) -> bool:
    if not isinstance(values, list) or not values:
        return False
    terminal_states = {"CONDITION_FAILED", "CONDITION_SUCCEEDED"}
    retry_reasons = {"IMMEDIATE_RETRY", "POSTPONED_RETRY", "WAITING_FOR_OPERATION"}
    for condition in values:
        if not isinstance(condition, dict) or condition.get("state") not in terminal_states:
            return False
        if any(
            condition.get(key) in retry_reasons
            for key in ("reason", "revisionReason", "executionReason", "instanceReason")
        ):
            return False
    return True


def _ready_failed(value: Any) -> bool:
    retry_reasons = {"IMMEDIATE_RETRY", "POSTPONED_RETRY", "WAITING_FOR_OPERATION"}
    return (
        isinstance(value, dict)
        and value.get("type") == "Ready"
        and value.get("state") == "CONDITION_FAILED"
        and not any(
            value.get(key) in retry_reasons
            for key in ("reason", "revisionReason", "executionReason", "instanceReason")
        )
    )


def _validate_failure_authority(
    service: dict[str, Any],
    *,
    name: str,
    expected_service_resource: str,
    expected_uid: str,
    target_image: str,
    deployed_image: str,
    attempt_id: str,
    expected_generation: int,
    predecessor: dict[str, Any],
) -> tuple[str, str, str, str]:
    source_digest = _qualified_image_digest(target_image)
    deployed_digest = _qualified_image_digest(deployed_image)
    service_name = service.get("name")
    if (
        not isinstance(service_name, str)
        or service_name != expected_service_resource
        or not service_name.endswith(f"/services/{name}")
        or not isinstance(predecessor, dict)
        or predecessor.get("version") != 1
        or predecessor.get("service") != name
        or predecessor.get("serviceUid") != expected_uid
        or type(predecessor.get("generation")) is not int
        or not predecessor.get("revision")
        or not predecessor.get("resourceVersion")
        or not predecessor.get("image")
        or not isinstance(attempt_id, str)
        or not attempt_id
        or not isinstance(target_image, str)
        or not target_image
        or source_digest is None
        or deployed_digest != source_digest
        or not isinstance(deployed_image, str)
        or not deployed_image
        or type(expected_generation) is not int
        or expected_generation < 1
        or expected_generation <= predecessor["generation"]
    ):
        raise RuntimeError("Cloud Run failed-reconciliation authority is incomplete")
    predecessor_revision = f"{service_name}/revisions/{predecessor['revision']}"
    latest_created = service.get("latestCreatedRevision")
    if (
        not isinstance(latest_created, str)
        or not latest_created.startswith(f"{service_name}/revisions/")
        or latest_created == predecessor_revision
    ):
        raise RuntimeError("Cloud Run failed revision identity is unavailable")
    return source_digest, predecessor_revision, latest_created, service_name


def _validate_failed_service(
    service: dict[str, Any],
    *,
    expected_uid: str,
    expected_generation: int,
    predecessor: dict[str, Any],
    predecessor_revision: str,
) -> tuple[Any, Any]:
    terminal = service.get("terminalCondition")
    observed_generation = _generation_value(service.get("observedGeneration"))
    traffic_statuses = service.get("trafficStatuses")
    if (
        service.get("uid") != expected_uid
        or _generation_value(service.get("generation")) != expected_generation
        or service.get("reconciling") is not False
        or not _ready_failed(terminal)
        or not _conditions_are_terminal(service.get("conditions"))
        or observed_generation != predecessor["generation"]
        or service.get("latestReadyRevision") != predecessor_revision
        or not isinstance(traffic_statuses, list)
        or len(traffic_statuses) != 1
        or traffic_statuses[0].get("revision") != predecessor_revision
        or type(traffic_statuses[0].get("percent")) is not int
        or traffic_statuses[0].get("percent") != 100
    ):
        raise RuntimeError("Cloud Run service reconciliation is pending or unbound")
    return terminal, observed_generation


def _validate_failed_revision(
    revision: dict[str, Any],
    *,
    expected_service: str,
    latest_created: str,
    attempt_id: str,
    deployed_image: str,
) -> tuple[list[dict[str, Any]], list[Any]]:
    containers = revision.get("containers")
    annotations = revision.get("annotations")
    conditions = revision.get("conditions", [])
    revision_ready = [
        item for item in conditions if isinstance(item, dict) and item.get("type") == "Ready"
    ]
    if (
        revision.get("name") != latest_created
        or revision.get("service") != expected_service
        or revision.get("reconciling") is not False
        or not _conditions_are_terminal(conditions)
        or len(revision_ready) != 1
        or not _ready_failed(revision_ready[0])
        or not isinstance(annotations, dict)
        or annotations.get("hussh/restart-nonce") != attempt_id
        or not isinstance(containers, list)
        or len(containers) != 1
        or not isinstance(containers[0], dict)
        or containers[0].get("image") != deployed_image
    ):
        raise RuntimeError("Cloud Run failed revision does not match this attempt")
    return containers, revision_ready


def _validate_failure_confirmation(
    service: dict[str, Any],
    confirmation: dict[str, Any],
    *,
    expected_uid: str,
    expected_service_resource: str,
    expected_generation: int,
    predecessor: dict[str, Any],
) -> None:
    stable_keys = (
        "name",
        "uid",
        "generation",
        "observedGeneration",
        "conditions",
        "latestReadyRevision",
        "latestCreatedRevision",
        "reconciling",
        "terminalCondition",
        "trafficStatuses",
    )
    if any(service.get(key) != confirmation.get(key) for key in stable_keys):
        raise RuntimeError("Cloud Run failure settlement changed during readback")
    if (
        confirmation.get("uid") != expected_uid
        or confirmation.get("name") != expected_service_resource
        or confirmation.get("reconciling") is not False
        or not _ready_failed(confirmation.get("terminalCondition"))
        or not _conditions_are_terminal(confirmation.get("conditions"))
        or _generation_value(confirmation.get("generation")) != expected_generation
        or _generation_value(confirmation.get("observedGeneration")) != predecessor["generation"]
    ):
        raise RuntimeError("Cloud Run failure settlement was not stable")


def _failed_receipt(
    service: dict[str, Any],
    revision: dict[str, Any],
    *,
    name: str,
    expected_uid: str,
    expected_generation: int,
    target_image: str,
    deployed_image: str,
    attempt_id: str,
    predecessor: dict[str, Any],
    source_digest: str,
    predecessor_revision: str,
    latest_created: str,
    terminal: Any,
    observed_generation: Any,
    containers: list[dict[str, Any]],
    revision_ready: list[Any],
) -> dict[str, Any]:
    revision_generation = _generation_value(revision.get("generation"))
    revision_uid = revision.get("uid")
    if revision_generation is None or not isinstance(revision_uid, str) or not revision_uid:
        raise RuntimeError("Cloud Run failed revision identity is incomplete")
    return {
        "version": 1,
        "outcome": "failed",
        "service": name,
        "serviceUid": expected_uid,
        "generation": expected_generation,
        "observedGeneration": observed_generation,
        "attemptId": attempt_id,
        "targetImage": target_image,
        "targetDigest": source_digest,
        "sourceImage": target_image,
        "sourceDigest": source_digest,
        "deployedImage": deployed_image,
        "image": containers[0]["image"],
        "nonce": attempt_id,
        "predecessor": predecessor,
        "revision": latest_created,
        "revisionUid": revision_uid,
        "revisionGeneration": revision_generation,
        "latestReadyRevision": predecessor_revision,
        "terminalCondition": terminal,
        "revisionCondition": revision_ready[0],
        "reconciling": False,
        "revisionReconciling": False,
        "trafficStatuses": service.get("trafficStatuses"),
        "ready": False,
    }


def hosted_files_failure_settlement_observation(
    service: dict[str, Any],
    revision: dict[str, Any],
    confirmation: dict[str, Any],
    *,
    name: str,
    expected_service_resource: str,
    expected_uid: str,
    target_image: str,
    deployed_image: str,
    attempt_id: str,
    expected_generation: int,
    predecessor: dict[str, Any],
) -> dict[str, Any]:
    """Prove a completed failed reconcile; Ready=False from v1 alone is insufficient."""
    deployed_image = target_image if deployed_image is None else deployed_image
    source_digest, predecessor_revision, latest_created, service_resource = (
        _validate_failure_authority(
            service,
            name=name,
            expected_service_resource=expected_service_resource,
            expected_uid=expected_uid,
            target_image=target_image,
            deployed_image=deployed_image,
            attempt_id=attempt_id,
            expected_generation=expected_generation,
            predecessor=predecessor,
        )
    )
    terminal, observed_generation = _validate_failed_service(
        service,
        expected_uid=expected_uid,
        expected_generation=expected_generation,
        predecessor=predecessor,
        predecessor_revision=predecessor_revision,
    )
    containers, revision_ready = _validate_failed_revision(
        revision,
        expected_service=service_resource,
        latest_created=latest_created,
        attempt_id=attempt_id,
        deployed_image=deployed_image,
    )
    _validate_failure_confirmation(
        service,
        confirmation,
        expected_uid=expected_uid,
        expected_service_resource=expected_service_resource,
        expected_generation=expected_generation,
        predecessor=predecessor,
    )
    return _failed_receipt(
        service,
        revision,
        name=name,
        expected_uid=expected_uid,
        expected_generation=expected_generation,
        target_image=target_image,
        deployed_image=deployed_image,
        attempt_id=attempt_id,
        predecessor=predecessor,
        source_digest=source_digest,
        predecessor_revision=predecessor_revision,
        latest_created=latest_created,
        terminal=terminal,
        observed_generation=observed_generation,
        containers=containers,
        revision_ready=revision_ready,
    )


def hosted_files_settlement_observation(
    service: dict[str, Any],
    *,
    name: str,
    expected_uid: str,
    target_image: str,
    deployed_image: str | None = None,
    attempt_id: str,
    expected_generation: int,
    predecessor: dict[str, Any],
) -> dict[str, Any]:
    """Qualify terminal Ready and serving evidence for one Files replacement."""
    acknowledged = upgrade_acknowledgement(
        service, name=name, expected_uid=expected_uid, attempt_id=attempt_id
    )
    source_digest = _qualified_image_digest(target_image)
    deployed_digest = _qualified_image_digest(deployed_image)
    metadata = service.get("metadata") or {}
    status = service.get("status") or {}
    revision = status.get("latestReadyRevisionName")
    traffic = status.get("traffic") or []
    ready = next(
        (item for item in status.get("conditions") or [] if item.get("type") == "Ready"),
        {},
    )
    if (
        acknowledged["generation"] != expected_generation
        or not isinstance(predecessor, dict)
        or predecessor.get("service") != name
        or predecessor.get("serviceUid") != expected_uid
        or type(predecessor.get("generation")) is not int
        or expected_generation <= predecessor["generation"]
        or source_digest is None
        or deployed_digest != source_digest
        or acknowledged["image"] != deployed_image
        or type(status.get("observedGeneration")) is not int
        or status.get("observedGeneration") != expected_generation
        or ready.get("status") != "True"
        or not isinstance(revision, str)
        or not revision.startswith(name + "-")
        or status.get("latestCreatedRevisionName") != revision
        or revision == predecessor.get("revision")
        or len(traffic) != 1
        or traffic[0].get("revisionName") != revision
        or type(traffic[0].get("percent")) is not int
        or traffic[0].get("percent") != 100
        or metadata.get("generation") != expected_generation
    ):
        raise RuntimeError("Cloud Run Files replacement is not terminal and serving")
    return {
        **acknowledged,
        "outcome": "ready",
        "targetImage": target_image,
        "targetDigest": source_digest,
        "sourceImage": target_image,
        "sourceDigest": source_digest,
        "deployedImage": deployed_image,
        "observedGeneration": status["observedGeneration"],
        "revision": revision,
        "predecessor": predecessor,
        "nonce": attempt_id,
        "ready": True,
    }
