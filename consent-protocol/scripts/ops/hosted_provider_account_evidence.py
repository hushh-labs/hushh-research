from __future__ import annotations

import asyncio
import re
from typing import Any

from scripts.ops.hosted_provider_account_identity import (
    OperatorRefused,
    _attempt,
    _digest,
    _owner_hash,
    _service_parts,
)


def _claim_metadata(claim: dict[str, Any]) -> dict[str, Any]:
    value = claim.get("backend_metadata")
    return value if isinstance(value, dict) else {}


def _claim_project(claim: Any) -> str | None:
    if not isinstance(claim, dict):
        return None
    metadata = _claim_metadata(claim)
    project = metadata.get("project") or metadata.get("user_cloud_project")
    if isinstance(project, str) and project:
        return project
    snapshot = metadata.get("erasure", {}).get("registrySnapshot")
    if isinstance(snapshot, dict):
        snapshot_metadata = snapshot.get("backend_metadata") or {}
        project = snapshot_metadata.get("project") or snapshot.get("user_cloud_project")
        return project if isinstance(project, str) and project else None
    return None


def _claim_attempt_id(claim: dict[str, Any]) -> str | None:
    attempt = _claim_metadata(claim).get("provisionAttempt")
    value = attempt.get("attemptId") if isinstance(attempt, dict) else None
    return value if isinstance(value, str) and value else None


def _claim_service(claim: dict[str, Any]) -> str | None:
    metadata = _claim_metadata(claim)
    value = metadata.get("service") or claim.get("external_agent_id")
    return value if isinstance(value, str) and value else None


def _retained_hosted_service_expectation(
    claim: Any, *, owner_id: str, project_id: str, project_number: str
) -> dict[str, str] | None:
    if not isinstance(claim, dict):
        return None
    metadata = _claim_metadata(claim)
    attempt = metadata.get("provisionAttempt")
    if not isinstance(attempt, dict):
        return None
    admission = attempt.get("hostedAdmission")
    assignment = admission.get("assignment") if isinstance(admission, dict) else None
    evidence = attempt.get("evidence")
    evidence = evidence if isinstance(evidence, dict) else {}
    reserved = evidence.get("reserved")
    reserved = reserved if isinstance(reserved, dict) else {}
    project_observation = reserved.get("projectObservation")
    project_observation = project_observation if isinstance(project_observation, dict) else {}
    host_requested = evidence.get("host_requested")
    host_requested = host_requested if isinstance(host_requested, dict) else {}
    acknowledgement = host_requested.get("creationAcknowledgement")
    acknowledgement = acknowledgement if isinstance(acknowledgement, dict) else {}
    intent = attempt.get("intent")
    intent = intent if isinstance(intent, dict) else {}

    retained_owner_id = claim.get("user_id")
    hushh_id = claim.get("hushh_id")
    service = _claim_service(claim)
    attempt_id = _claim_attempt_id(claim)
    service_uid = acknowledgement.get("serviceUid")
    runtime_principal = metadata.get("runtime_service_account")
    image_digest = admission.get("imageDigest") if isinstance(admission, dict) else None
    region = metadata.get("region")
    fields = {
        "ownerId": owner_id,
        "retainedOwnerId": retained_owner_id,
        "hushhId": hushh_id,
        "service": service,
        "attemptId": attempt_id,
        "serviceUid": service_uid,
        "runtimePrincipal": runtime_principal,
        "imageDigest": image_digest,
        "region": region,
    }
    if not _valid_retained_hosted_service_fields(
        fields,
        attempt,
        intent,
        assignment,
        metadata,
        project_observation,
        acknowledgement,
        project_id,
        project_number,
    ):
        return None
    image = f"{region}-docker.pkg.dev/{project_id}/one-pod/consent-protocol-pod@{image_digest}"
    return {
        "projectId": project_id,
        "projectNumber": project_number,
        "service": service,
        "attemptId": attempt_id,
        "serviceUid": service_uid,
        "imageDigest": image_digest,
        "runtimePrincipal": runtime_principal,
        "image": image,
    }


def _valid_retained_hosted_service_fields(
    fields: dict[str, Any],
    attempt: dict[str, Any],
    intent: dict[str, Any],
    assignment: Any,
    metadata: dict[str, Any],
    observation: dict[str, Any],
    acknowledgement: dict[str, Any],
    project_id: str,
    project_number: str,
) -> bool:
    owner_id = fields["ownerId"]
    hushh_id = fields["hushhId"]
    service = fields["service"]
    service_uid = fields["serviceUid"]
    image_digest = fields["imageDigest"]
    region = fields["region"]
    image = f"{region}-docker.pkg.dev/{project_id}/one-pod/consent-protocol-pod@{image_digest}"
    return bool(
        all(
            isinstance(fields[key], str) and fields[key]
            for key in (
                "ownerId",
                "hushhId",
                "service",
                "attemptId",
                "serviceUid",
                "runtimePrincipal",
                "region",
            )
        )
        and isinstance(image_digest, str)
        and re.fullmatch(r"sha256:[a-f0-9]{64}", image_digest)
        and (fields["retainedOwnerId"] is None or fields["retainedOwnerId"] == owner_id)
        and attempt.get("ownerId") == owner_id
        and intent.get("user_id") == owner_id
        and intent.get("hushh_id") == hushh_id
        and isinstance(assignment, dict)
        and assignment.get("ownerHash") == _owner_hash(owner_id)
        and assignment.get("project") == project_id
        and (
            assignment.get("projectNumber") is None
            or str(assignment.get("projectNumber")) == project_number
        )
        and metadata.get("project") == project_id
        and observation.get("projectId") == project_id
        and str(observation.get("projectNumber")) == project_number
        and acknowledgement.get("backend") == "gcp"
        and acknowledgement.get("project") == project_id
        and acknowledgement.get("region") == region
        and acknowledgement.get("service") == service
        and acknowledgement.get("initialImage") == image
        and metadata.get("serviceUid", service_uid) == service_uid
    )


def _retained_hosted_service_matches(service: Any, expected: dict[str, str]) -> bool:
    if not isinstance(service, dict):
        return False
    metadata, labels, template_spec, container = _service_parts(service)
    image = container.get("image")
    return bool(
        metadata.get("name") == expected["service"]
        and metadata.get("namespace") == expected["projectNumber"]
        and metadata.get("uid") == expected["serviceUid"]
        and labels.get("app") == "hussh-one-pod"
        and labels.get("hussh-tenancy") == "hussh-hosted"
        and labels.get("hussh-provision-attempt") == expected["attemptId"]
        and template_spec.get("serviceAccountName") == expected["runtimePrincipal"]
        and image == expected["image"]
    )


def _claim_is_owner_owned(claim: dict[str, Any]) -> bool:
    metadata = _claim_metadata(claim)
    return bool(
        claim.get("backend") == "user_gcp"
        or metadata.get("tenancy") == "user-owned"
        or metadata.get("user_cloud_project")
        or claim.get("deployment_target") in {"user_gcp", "user_azure"}
    )


def _claim_is_hosted(claim: dict[str, Any]) -> bool:
    metadata = _claim_metadata(claim)
    return bool(
        metadata.get("tenancy") == "hussh-hosted"
        or isinstance(metadata.get("provisionAttempt"), dict)
        and isinstance(metadata["provisionAttempt"].get("hostedAdmission"), dict)
    )


def _claim_summary(claim: dict[str, Any]) -> dict[str, Any]:
    return {
        "hushhId": claim.get("hushh_id"),
        "source": claim.get("claim_source"),
        "status": claim.get("status"),
        "projectId": _claim_project(claim),
        "service": _claim_service(claim),
        "attemptId": _claim_attempt_id(claim),
        "hostingClass": "owner_owned"
        if _claim_is_owner_owned(claim)
        else "hosted"
        if _claim_is_hosted(claim)
        else "unclassified",
    }


def _transition_summary(transition: Any) -> dict[str, Any] | None:
    if not isinstance(transition, dict):
        return None
    return {
        "phase": transition.get("phase"),
        "generation": transition.get("generation"),
        "settlementCount": len(transition.get("settlements", []))
        if isinstance(transition.get("settlements"), list)
        else None,
        "intentSha256": _digest(transition.get("intent"))
        if isinstance(transition.get("intent"), dict)
        else None,
    }


def _tombstone_summary(auxiliary: dict[str, Any]) -> dict[str, Any]:
    personal = auxiliary.get("personalTombstones") or []
    accounts = auxiliary.get("accountTombstones") or []
    account_states = sorted(
        str(item.get("cleanup_status") or "unknown") for item in accounts if isinstance(item, dict)
    )
    if not personal and not accounts:
        return {"state": "none"}
    current_erasure_pair = bool(auxiliary.get("currentErasureTombstonePair") is True)
    return {
        "state": "current_erasure" if current_erasure_pair else "retained",
        "personalCount": len(personal),
        "personalStatuses": sorted(
            str(item.get("status") or "unknown") for item in personal if isinstance(item, dict)
        ),
        "accountStatuses": account_states,
    }


def _current_erasure_tombstone_pair(
    row: dict[str, Any] | None, auxiliary: dict[str, Any], expected: dict[str, Any]
) -> bool:
    if not isinstance(row, dict) or row.get("status") != "suspended":
        return False
    metadata = row.get("backend_metadata") or {}
    erasure = metadata.get("erasure") if isinstance(metadata, dict) else None
    snapshot = erasure.get("registrySnapshot") if isinstance(erasure, dict) else None
    if (
        not isinstance(erasure, dict)
        or erasure.get("ownerId") != row.get("user_id")
        or not isinstance(erasure.get("attemptId"), str)
        or not isinstance(snapshot, dict)
        or snapshot.get("hushh_id") != expected["hushhId"]
        or snapshot.get("placement_epoch") != expected["placementEpoch"]
        or _attempt(snapshot).get("attemptId") != expected["attemptId"]
    ):
        return False
    tombstones = auxiliary.get("personalTombstones") or []
    return bool(
        tombstones
        and all(
            isinstance(item, dict)
            and item.get("hushh_id") == expected["hushhId"]
            and item.get("status") == "deprovision_requested"
            and item.get("external_agent_id") == snapshot.get("external_agent_id")
            for item in tombstones
        )
    )


def _removal_summary(auxiliary: dict[str, Any]) -> dict[str, Any]:
    records = auxiliary.get("removals") or []
    if not records:
        return {"state": "none", "count": 0}
    return {
        "state": "completed" if any(item.get("completed_at") for item in records) else "retained",
        "count": len(records),
        "attemptIds": sorted(str(item.get("attempt_id") or "") for item in records),
        "placementEpochs": sorted(
            item.get("placement_epoch")
            for item in records
            if type(item.get("placement_epoch")) is int
        ),
        "archiveSha256": sorted(
            _digest(item.get("archive")) for item in records if item.get("archive") is not None
        ),
    }


def owner_generation(registry: Any, owner_id: str) -> int:
    result = registry._db().execute_raw(
        "SELECT to_regclass('public.account_generations') IS NOT NULL AS installed", {}
    )
    if not result.data or result.data[0].get("installed") is not True:
        if owner_id.startswith("acct_"):
            raise OperatorRefused("account-generation binding is unavailable")
        return 0
    owner_hash = _owner_hash(owner_id)
    result = registry._db().execute_raw(
        "SELECT generation,owner_id,retired_at FROM public.account_generations "
        "WHERE owner_hash=:owner_hash",
        {"owner_hash": owner_hash},
    )
    if result.data:
        row = result.data[0]
        if row.get("owner_id") != owner_id or row.get("retired_at") is not None:
            raise OperatorRefused("account-generation binding is retired or foreign")
        generation = row.get("generation")
        if type(generation) is not int or generation < 0:
            raise OperatorRefused("account-generation binding is malformed")
        return generation
    if owner_id.startswith("acct_"):
        raise OperatorRefused("account-generation binding is missing")
    return 0


async def retained_records(
    registry,
    *,
    owner_id: str | None,
    owner_hash: str | None,
    identity_hash: str | None,
    hushh_id: str,
    attempt_id: str,
) -> dict[str, Any]:
    db = registry._db()

    def read() -> dict[str, Any]:
        installed = db.execute_raw(
            "SELECT to_regclass('public.personal_agent_deletion_tombstones') IS NOT NULL AS personal, "
            "to_regclass('public.account_deletion_tombstones') IS NOT NULL AS account, "
            "to_regclass('public.personal_agent_cloud_removals') IS NOT NULL AS removals",
            {},
        )
        if (
            not installed.data
            or installed.data[0].get("personal") is not True
            or installed.data[0].get("account") is not True
            or installed.data[0].get("removals") is not True
        ):
            raise OperatorRefused("retained removal and tombstone schema is unavailable")
        personal = db.execute_raw(
            "SELECT to_jsonb(t) AS record FROM public.personal_agent_deletion_tombstones t "
            "WHERE hushh_id=:hushh_id ORDER BY created_at,id",
            {"hushh_id": hushh_id},
        )
        removals = db.execute_raw(
            "SELECT to_jsonb(c) AS record FROM public.personal_agent_cloud_removals c "
            "WHERE attempt_id=:attempt_id OR (:owner_id IS NOT NULL AND user_id=:owner_id) "
            "ORDER BY created_at,attempt_id",
            {"attempt_id": attempt_id, "owner_id": owner_id},
        )
        account_records = []
        if owner_hash or identity_hash:
            result = db.execute_raw(
                "SELECT to_jsonb(t) AS record FROM public.account_deletion_tombstones t "
                "WHERE (:owner_hash IS NOT NULL AND user_id_hash=:owner_hash) "
                "OR (:identity_hash IS NOT NULL AND firebase_identity_hash=:identity_hash)",
                {"owner_hash": owner_hash, "identity_hash": identity_hash},
            )
            account_records = [row.get("record") for row in result.data or []]
        return {
            "personalTombstones": [row.get("record") for row in personal.data or []],
            "removals": [row.get("record") for row in removals.data or []],
            "accountTombstones": account_records,
        }

    return await asyncio.to_thread(read)
