from __future__ import annotations

from typing import Any

from scripts.ops.hosted_provider_account_evidence import _current_erasure_tombstone_pair
from scripts.ops.hosted_provider_account_identity import (
    OLD_BILLING_ACCOUNT,
    REGION,
    _attempt,
    _creation_identity,
    _owner_hash,
    _service_matches,
)


def _retained_identity_matches(
    *,
    raw_row: dict[str, Any] | None,
    authority_row: dict[str, Any] | None,
    expected: dict[str, Any],
    project_identity: dict[str, Any] | None,
    service_candidates: list[dict[str, Any]],
    claims: list[dict[str, Any]],
    auxiliary: dict[str, Any],
    owner_identity_error: str | None,
) -> tuple[bool, str | None]:
    owner, valid_erasure, reason = _owner_erasure_state(
        raw_row, authority_row, expected, owner_identity_error
    )
    if reason:
        return False, reason
    if not _retained_claims_clear(raw_row, expected, claims, auxiliary):
        return False, _retained_claims_failure(raw_row, expected, claims, auxiliary)
    if not _retained_creation_matches(authority_row, owner, expected):
        return False, "retained_creation_identity_mismatch"
    if project_identity is None:
        return False, "native_project_identity_unavailable"
    identity = _creation_identity(authority_row)
    project_reason = _native_project_failure(project_identity, identity, expected, valid_erasure)
    if project_reason:
        return False, project_reason
    if not _native_service_matches(
        raw_row, authority_row, expected, project_identity, service_candidates, valid_erasure
    ):
        return False, _native_service_failure(
            project_identity, raw_row, expected, service_candidates, valid_erasure
        )
    return True, None


def _owner_erasure_state(
    raw_row: dict[str, Any] | None,
    authority_row: dict[str, Any] | None,
    expected: dict[str, Any],
    owner_identity_error: str | None,
) -> tuple[str | None, bool, str | None]:
    if not isinstance(raw_row, dict) or not isinstance(authority_row, dict):
        return None, False, "registry_owner_missing"
    owner = raw_row.get("user_id")
    if not isinstance(owner, str) or not owner or owner_identity_error:
        return None, False, "owner_generation_unresolved"
    erasure = (raw_row.get("backend_metadata") or {}).get("erasure")
    snapshot = erasure.get("registrySnapshot") if isinstance(erasure, dict) else None
    valid = bool(
        raw_row.get("status") == "suspended"
        and isinstance(erasure, dict)
        and erasure.get("ownerId") == owner
        and isinstance(erasure.get("attemptId"), str)
        and isinstance(snapshot, dict)
        and snapshot.get("user_id") == owner
        and snapshot.get("hushh_id") == expected["hushhId"]
        and snapshot.get("placement_epoch") == expected["placementEpoch"]
        and _attempt(snapshot).get("attemptId") == expected["attemptId"]
    )
    return owner, valid, None


def _retained_claims_clear(
    row: dict[str, Any],
    expected: dict[str, Any],
    claims: list[dict[str, Any]],
    auxiliary: dict[str, Any],
) -> bool:
    active_accounts = [
        item
        for item in auxiliary.get("accountTombstones", [])
        if isinstance(item, dict) and item.get("cleanup_status") != "completed"
    ]
    personal = auxiliary.get("personalTombstones", [])
    current_pair = _current_erasure_tombstone_pair(row, auxiliary, expected)
    removals = [
        item
        for item in auxiliary.get("removals", [])
        if isinstance(item, dict)
        and item.get("attempt_id") == expected["attemptId"]
        and item.get("placement_epoch") == expected["placementEpoch"]
    ]
    primary = [
        claim
        for claim in claims
        if isinstance(claim, dict)
        and claim.get("hushh_id") == expected["hushhId"]
        and claim.get("claim_source") == "primary"
    ]
    return not (
        active_accounts
        or (personal and not current_pair)
        or any(item.get("completed_at") is not None for item in removals)
        or len(primary) != 1
    )


def _retained_claims_failure(
    row: dict[str, Any],
    expected: dict[str, Any],
    claims: list[dict[str, Any]],
    auxiliary: dict[str, Any],
) -> str:
    if any(
        isinstance(item, dict) and item.get("cleanup_status") != "completed"
        for item in auxiliary.get("accountTombstones", [])
    ):
        return "owner_tombstone_retained"
    if auxiliary.get("personalTombstones") and not _current_erasure_tombstone_pair(
        row, auxiliary, expected
    ):
        return "owner_tombstone_not_bound_to_current_erasure"
    if any(
        isinstance(item, dict)
        and item.get("attempt_id") == expected["attemptId"]
        and item.get("placement_epoch") == expected["placementEpoch"]
        and item.get("completed_at") is not None
        for item in auxiliary.get("removals", [])
    ):
        return "current_placement_removal_archive_retained"
    return "fleet_registry_claim_missing_or_ambiguous"


def _retained_creation_matches(row: dict[str, Any], owner: str, expected: dict[str, Any]) -> bool:
    attempt = _attempt(row)
    metadata = row.get("backend_metadata") or {}
    admission = attempt.get("hostedAdmission")
    assignment = admission.get("assignment") if isinstance(admission, dict) else None
    evidence = attempt.get("evidence") if isinstance(attempt.get("evidence"), dict) else {}
    reserved = evidence.get("reserved") if isinstance(evidence.get("reserved"), dict) else {}
    observation = reserved.get("projectObservation")
    prep = reserved.get("hostedPreparation")
    completed = prep.get("completed") if isinstance(prep, dict) else None
    contract = assignment.get("preparationContract") if isinstance(assignment, dict) else None
    identity = _creation_identity(row)
    steps = (
        [item.get("step") for item in completed if isinstance(item, dict)]
        if isinstance(completed, list)
        else []
    )
    return bool(
        _attempt_envelope_matches(attempt, row, owner, expected)
        and row.get("deployment_target") == "gcp"
        and row.get("backend") == "gcp"
        and metadata.get("tenancy", "hussh-hosted") == "hussh-hosted"
        and metadata.get("project") == expected["projectId"]
        and metadata.get("region") == REGION
        and metadata.get("runtime_service_account") == expected["runtimePrincipal"]
        and metadata.get("serviceUid", expected["serviceUid"]) == expected["serviceUid"]
        and _admission_assignment_matches(admission, assignment, contract, owner, expected)
        and contract.get("billingAccount") == OLD_BILLING_ACCOUNT
        and steps
        == [
            "create_project",
            "link_billing",
            "authorize_project",
            "inference_vertex",
            "inference_quota",
        ]
        and _project_observation_matches(observation, identity, expected)
    )


def _attempt_envelope_matches(
    attempt: dict[str, Any], row: dict[str, Any], owner: str, expected: dict[str, Any]
) -> bool:
    intent = attempt.get("intent")
    return bool(
        attempt.get("ownerId") == owner
        and attempt.get("attemptId") == expected["attemptId"]
        and isinstance(intent, dict)
        and intent.get("user_id") == owner
        and intent.get("hushh_id") == expected["hushhId"]
        and row.get("hushh_id") == expected["hushhId"]
        and row.get("placement_epoch") == expected["placementEpoch"]
    )


def _admission_assignment_matches(
    admission: Any,
    assignment: Any,
    contract: Any,
    owner: str,
    expected: dict[str, Any],
) -> bool:
    return bool(
        isinstance(admission, dict)
        and admission.get("environment") == "dev"
        and admission.get("imageDigest")
        == "sha256:639958a5d5a9adf12c5a93839afaa3a8a1a86421896291b746b4e8c257ffc8a1"
        and isinstance(assignment, dict)
        and assignment.get("project") == expected["projectId"]
        and assignment.get("projectNumber") in {None, expected["projectNumber"]}
        and assignment.get("hushhId") == expected["hushhId"]
        and assignment.get("ownerHash") == _owner_hash(owner)
        and isinstance(contract, dict)
    )


def _project_observation_matches(observation: Any, identity: Any, expected: dict[str, Any]) -> bool:
    return bool(
        isinstance(observation, dict)
        and observation.get("projectId") == expected["projectId"]
        and observation.get("projectNumber") == expected["projectNumber"]
        and isinstance(identity, dict)
        and identity.get("projectId") == expected["projectId"]
        and identity.get("projectNumber") == expected["projectNumber"]
        and identity.get("lifecycleState") == "ACTIVE"
        and isinstance(identity.get("parent"), dict)
        and isinstance(identity.get("labels"), dict)
    )


def _native_project_failure(
    project: dict[str, Any], identity: dict[str, Any], expected: dict[str, Any], valid_erasure: bool
) -> str | None:
    if (
        project.get("projectId") != expected["projectId"]
        or str(project.get("projectNumber")) != expected["projectNumber"]
        or project.get("parent") != identity.get("parent")
        or project.get("labels") != identity.get("labels")
        or project.get("lifecycleState") not in {"ACTIVE", "DELETE_REQUESTED"}
    ):
        return "native_project_identity_mismatch"
    if project.get("lifecycleState") == "DELETE_REQUESTED" and not valid_erasure:
        return "project_delete_requested_without_erasure"
    return None


def _native_service_matches(
    raw_row: dict[str, Any],
    authority: dict[str, Any],
    expected: dict[str, Any],
    project: dict[str, Any],
    candidates: list[dict[str, Any]],
    valid_erasure: bool,
) -> bool:
    if candidates:
        matches = [
            item
            for item in candidates
            if _service_matches(item.get("service"), row=authority, expected=expected)
        ]
        return len(matches) == 1 and len(candidates) == 1
    return bool(
        valid_erasure
        and project.get("lifecycleState") == "DELETE_REQUESTED"
        and _retirement_pending_proven(raw_row, expected)
    )


def _native_service_failure(
    project: dict[str, Any],
    row: dict[str, Any],
    expected: dict[str, Any],
    candidates: list[dict[str, Any]],
    valid_erasure: bool,
) -> str:
    if candidates:
        return "native_service_identity_mismatch"
    if (
        valid_erasure
        and project.get("lifecycleState") == "DELETE_REQUESTED"
        and not _retirement_pending_proven(row, expected)
    ):
        return "native_service_missing_without_retirement_receipt"
    return "native_service_missing_without_retirement_receipt"


def _retirement_pending_proven(row: dict[str, Any], expected: dict[str, Any]) -> bool:
    erasure = (row.get("backend_metadata") or {}).get("erasure") or {}
    retirement = erasure.get("managedProjectRetirement")
    if not isinstance(retirement, dict):
        return False
    deletion = retirement.get("deletion")
    if not isinstance(deletion, dict):
        return False
    project_identity = deletion.get("projectIdentity")
    return bool(
        deletion.get("ownerId") == row.get("user_id")
        and deletion.get("attemptId") == erasure.get("attemptId")
        and deletion.get("project") == expected["projectId"]
        and deletion.get("projectNumber") == expected["projectNumber"]
        and deletion.get("status") == "retirement_pending_provider_purge"
        and isinstance(project_identity, dict)
        and project_identity.get("projectId") == expected["projectId"]
        and str(project_identity.get("projectNumber")) == expected["projectNumber"]
        and project_identity.get("lifecycleState") == "DELETE_REQUESTED"
    )
