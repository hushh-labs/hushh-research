from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from hushh_mcp.services.hosted_provider_account_transition import PLACEMENTS
from scripts.ops.hosted_provider_account_evidence import (
    _claim_attempt_id,
    _claim_is_hosted,
    _claim_is_owner_owned,
    _claim_project,
    _claim_service,
    _claim_summary,
    _retained_hosted_service_expectation,
    _retained_hosted_service_matches,
)
from scripts.ops.hosted_provider_account_identity import (
    REGION,
    REVIEWED_FOLDER_ID,
    OperatorRefused,
    _json_value,
    _read_native_project_identity,
    _service_summary,
)
from scripts.ops.pod_reconcile import hosted_provider_transition_service_candidates

"""Shared state for the read-only hosted billing inventory adapters."""


@dataclass
class InventoryState:
    runtime: Any
    unresolved: list[str] = field(default_factory=list)
    records: dict[str, dict[str, Any]] = field(default_factory=dict)
    placements: dict[str, dict[str, Any]] = field(default_factory=dict)
    project_identities: dict[str, dict[str, Any]] = field(default_factory=dict)
    services_by_project: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    retained_owner_rows: dict[str, dict[str, Any] | None] = field(default_factory=dict)
    fleet_rows: list[dict[str, Any]] = field(default_factory=list)
    claims: list[dict[str, Any]] = field(default_factory=list)
    discovered_projects: list[dict[str, Any]] = field(default_factory=list)
    discovered_candidates: list[dict[str, Any]] = field(default_factory=list)


"""Folder-wide discovery and retained-claim joins for operator inventory."""


async def read_folder_inventory(state: InventoryState) -> None:
    try:
        projects = await asyncio.to_thread(state.runtime.project_discovery)
        normalized = _validate_folder_projects(projects)
        for listed in normalized:
            await read_folder_project(state, listed)
        _check_reviewed_projects(state, normalized)
        state.discovered_projects.sort(key=lambda item: item["projectId"])
        state.discovered_candidates.sort(key=lambda item: item["projectId"])
    except Exception as exc:  # noqa: BLE001 - incomplete listing is not absence
        state.unresolved.append(f"reviewed_project_folder_unreadable:{type(exc).__name__}")
        state.discovered_projects = []
        state.discovered_candidates = []


def _validate_folder_projects(projects: Any) -> list[dict[str, Any]]:
    if not isinstance(projects, list) or any(not isinstance(item, dict) for item in projects):
        raise OperatorRefused("reviewed project folder inventory is malformed")
    for item in projects:
        parent = item.get("parent")
        if (
            not isinstance(item.get("projectId"), str)
            or not item["projectId"]
            or not isinstance(item.get("projectNumber"), (str, int))
            or not isinstance(parent, dict)
            or parent != {"type": "folder", "id": REVIEWED_FOLDER_ID}
        ):
            raise OperatorRefused("reviewed project folder member is malformed")
    return projects


async def read_folder_project(state: InventoryState, listed: dict[str, Any]) -> None:
    project_id, number, parent, labels = _listed_identity(listed)
    claims = [claim for claim in state.claims if _claim_project(claim) == project_id]
    markers = _project_markers(project_id, labels, claims)
    identity, native_state = await _read_project_identity(state, listed, markers)
    summary = _project_summary(project_id, number, parent, labels, listed, identity, native_state)
    state.discovered_projects.append(summary)
    if not markers["candidate"]:
        return
    if _read_owner_owned(state, summary, claims, markers):
        return
    services, service_state = await _read_project_services(state, project_id, native_state)
    candidates = _candidate_services(services, project_id, number, claims, service_state, state)
    hosted_claims = [claim for claim in claims if _claim_is_hosted(claim)]
    reviewed = project_id in {placement["projectId"] for placement in PLACEMENTS.values()}
    verified = await _verify_retained_hosted_claims(
        state, project_id, number, hosted_claims, candidates, services, service_state, reviewed
    )
    classification = _classify_candidate(native_state, hosted_claims, reviewed, verified)
    if native_state == "active" and not hosted_claims and not reviewed:
        state.unresolved.append(f"project:{project_id}:unclassified_active_hosted_candidate")
    if native_state == "active" and (markers["hosted"] or markers["prefix"]) and not candidates:
        state.unresolved.append(f"project:{project_id}:hosted_candidate_service_missing")
    state.discovered_candidates.append(
        _candidate_summary(summary, classification, claims, service_state, candidates)
    )


def _listed_identity(
    listed: dict[str, Any],
) -> tuple[str, str, dict[str, Any], dict[str, str]]:
    project_id = listed["projectId"]
    number = str(listed["projectNumber"])
    parent = listed["parent"]
    labels = listed.get("labels")
    return project_id, number, parent, labels if isinstance(labels, dict) else {}


def _project_markers(
    project_id: str, labels: dict[str, Any], claims: list[dict[str, Any]]
) -> dict[str, bool]:
    label_map = {str(key): str(value) for key, value in labels.items()}
    prefix = project_id.startswith("hussh-hp-")
    explicit_hosted = (
        label_map.get("tenancy") == "hussh-hosted"
        or label_map.get("hussh-tenancy") == "hussh-hosted"
        or "hussh-provision-attempt" in label_map
    )
    owner = label_map.get("tenancy") == "user-owned" or any(
        _claim_is_owner_owned(claim) for claim in claims
    )
    hosted = explicit_hosted or any(_claim_is_hosted(claim) for claim in claims)
    return {
        "prefix": prefix,
        "explicitHosted": explicit_hosted,
        "owner": owner,
        "hosted": hosted,
        "candidate": prefix or hosted or owner,
        "conflict": explicit_hosted and owner,
    }


async def _read_project_identity(
    state: InventoryState, listed: dict[str, Any], markers: dict[str, bool]
) -> tuple[dict[str, Any] | None, str]:
    project_id = listed["projectId"]
    number = str(listed["projectNumber"])
    current = state.project_identities.get(project_id)
    native_state = "unreadable"
    if (
        current is None
        and markers["candidate"]
        and not (markers["owner"] and not markers["hosted"])
    ):
        try:
            reader = state.runtime.project_reader_factory(project=project_id, number=number)
            current = await asyncio.to_thread(
                _read_native_project_identity,
                reader,
                {"projectId": project_id, "projectNumber": number},
            )
            state.project_identities[project_id] = current
        except Exception as exc:  # noqa: BLE001 - unreadable is never absence
            if getattr(exc, "http_status", None) == 404:
                native_state = "absent"
            else:
                state.unresolved.append(
                    f"project:{project_id}:native_project_unreadable:{type(exc).__name__}"
                )
    if current is not None:
        native_state = _native_state(current.get("lifecycleState"))
        _verify_listed_readback(state, listed, current)
    if markers["conflict"]:
        state.unresolved.append(f"project:{project_id}:owner_hosted_evidence_conflict")
    return current, native_state


def _native_state(lifecycle: Any) -> str:
    return (
        "pending_delete"
        if lifecycle == "DELETE_REQUESTED"
        else "active"
        if lifecycle == "ACTIVE"
        else "non_active"
    )


def _verify_listed_readback(
    state: InventoryState, listed: dict[str, Any], current: dict[str, Any]
) -> None:
    labels = listed.get("labels") if isinstance(listed.get("labels"), dict) else {}
    if (
        current.get("parent") != listed.get("parent")
        or str(current.get("projectNumber")) != str(listed.get("projectNumber"))
        or current.get("labels") != {str(k): str(v) for k, v in labels.items()}
        or current.get("lifecycleState") != listed.get("lifecycleState")
    ):
        state.unresolved.append(f"project:{listed['projectId']}:project_list_readback_changed")


def _project_summary(
    project_id: str,
    number: str,
    parent: dict[str, Any],
    labels: dict[str, Any],
    listed: dict[str, Any],
    identity: dict[str, Any] | None,
    native_state: str,
) -> dict[str, Any]:
    native_labels = (identity or {}).get("labels") or labels
    return {
        "projectId": project_id,
        "projectNumber": number,
        "parent": _json_value(parent),
        "labels": {
            key: value
            for key, value in sorted(native_labels.items())
            if key.startswith("hussh-") or key in {"app", "environment"}
        },
        "lifecycleState": (identity or listed).get("lifecycleState"),
        "nativeProjectState": native_state,
        "reviewedPlacement": project_id in {item["projectId"] for item in PLACEMENTS.values()},
        "candidateDiscoveryOnly": True,
    }


def _read_owner_owned(
    state: InventoryState,
    summary: dict[str, Any],
    claims: list[dict[str, Any]],
    markers: dict[str, bool],
) -> bool:
    if not (markers["owner"] and not markers["hosted"]):
        return False
    known = markers["owner"]
    if not known and summary["nativeProjectState"] == "active":
        state.unresolved.append(f"project:{summary['projectId']}:owner_candidate_claim_unresolved")
    state.discovered_candidates.append(
        {
            **summary,
            "classification": "owner_owned_preserved" if known else "unclassified_owner_candidate",
            "claims": [_claim_summary(claim) for claim in claims],
            "serviceInventoryState": "not_read_for_owner_owned_project",
            "serviceCandidates": [],
            "candidateCount": 0,
            "authorizedForMutation": False,
        }
    )
    return True


async def _read_project_services(
    state: InventoryState, project_id: str, native_state: str
) -> tuple[list[dict[str, Any]], str]:
    services = state.services_by_project.get(project_id)
    if services is not None:
        return services, "readable"
    if native_state not in {"active", "pending_delete"}:
        return [], "not_active"
    try:
        client = state.runtime.run_client_factory(project=project_id, region=REGION)
        return await asyncio.to_thread(client.list_services), "readable"
    except Exception as exc:  # noqa: BLE001 - denied is unresolved
        state.unresolved.append(
            f"project:{project_id}:service_inventory_unreadable:{type(exc).__name__}"
        )
        return [], "unreadable"


def _candidate_services(
    services: list[dict[str, Any]],
    project_id: str,
    number: str,
    claims: list[dict[str, Any]],
    service_state: str,
    state: InventoryState,
) -> list[dict[str, Any]]:
    if service_state != "readable":
        return []
    try:
        candidates: dict[tuple[str, str], dict[str, Any]] = {}
        selectors = [("unmatched-reviewed-project-candidate", "unmatched-reviewed-project-attempt")]
        selectors.extend(
            (name, attempt)
            for claim in claims
            if (name := _claim_service(claim)) and (attempt := _claim_attempt_id(claim))
        )
        for service_name, attempt_id in selectors:
            _add_candidates(candidates, services, project_id, number, service_name, attempt_id)
        return list(candidates.values())
    except Exception as exc:  # noqa: BLE001 - malformed service list
        state.unresolved.append(
            f"project:{project_id}:service_candidates_unreadable:{type(exc).__name__}"
        )
        return []


def _add_candidates(
    collected: dict[tuple[str, str], dict[str, Any]],
    services: list[dict[str, Any]],
    project_id: str,
    number: str,
    name: str,
    attempt_id: str,
) -> None:
    for candidate in hosted_provider_transition_service_candidates(
        services,
        project_id=project_id,
        project_number=number,
        service_name=name,
        attempt_id=attempt_id,
    ):
        metadata = (candidate.get("service") or {}).get("metadata") or {}
        key = (str(metadata.get("name") or ""), str(metadata.get("uid") or ""))
        if key in collected:
            collected[key]["candidateSources"] = sorted(
                set(collected[key].get("candidateSources", []))
                | set(candidate.get("candidateSources", []))
            )
        else:
            collected[key] = candidate


async def _verify_retained_hosted_claims(
    state: InventoryState,
    project_id: str,
    number: str,
    claims: list[dict[str, Any]],
    candidates: list[dict[str, Any]],
    services: list[dict[str, Any]],
    service_state: str,
    reviewed: bool,
) -> bool:
    if not claims or reviewed:
        return False
    verified = service_state == "readable"
    matched: set[int] = set()
    for claim in claims:
        candidate = await _verify_one_hosted_claim(
            state, project_id, number, claim, services, matched
        )
        verified = verified and candidate
    if {id(item.get("service")) for item in candidates} - matched:
        verified = False
        state.unresolved.append(f"project:{project_id}:unmatched_hosted_service_candidate")
    return verified


async def _verify_one_hosted_claim(
    state: InventoryState,
    project_id: str,
    number: str,
    claim: dict[str, Any],
    services: list[dict[str, Any]],
    matched: set[int],
) -> bool:
    hushh_id = claim.get("hushh_id") if isinstance(claim, dict) else None
    if not isinstance(hushh_id, str) or not hushh_id:
        state.unresolved.append(f"project:{project_id}:retained_hosted_claim_owner_missing")
        return False
    owner = await _owner_row(state, hushh_id)
    if owner is None:
        state.unresolved.append(f"project:{project_id}:retained_hosted_claim_owner_unresolved")
        return False
    expected = _retained_hosted_service_expectation(
        claim, owner_id=owner["user_id"], project_id=project_id, project_number=number
    )
    if expected is None:
        state.unresolved.append(f"project:{project_id}:retained_hosted_claim_identity_incomplete")
        return False
    matches = _matching_claim_services(services, project_id, number, expected)
    if len(matches) != 1:
        state.unresolved.append(
            f"project:{project_id}:retained_hosted_service_match_count_"
            f"{expected['attemptId']}:{len(matches)}"
        )
        return False
    service_id = id(matches[0].get("service"))
    if service_id in matched:
        state.unresolved.append(f"project:{project_id}:retained_hosted_service_reused")
        return False
    matched.add(service_id)
    return True


async def _owner_row(state: InventoryState, hushh_id: str) -> dict[str, Any] | None:
    if hushh_id not in state.retained_owner_rows:
        try:
            row = await state.runtime.registry.get_by_hushh_id(hushh_id)
            state.retained_owner_rows[hushh_id] = (
                row
                if isinstance(row, dict)
                and row.get("hushh_id") == hushh_id
                and isinstance(row.get("user_id"), str)
                and row.get("user_id")
                else None
            )
        except Exception:  # noqa: BLE001 - owner resolution is fail-closed
            state.retained_owner_rows[hushh_id] = None
    return state.retained_owner_rows[hushh_id]


def _matching_claim_services(
    services: list[dict[str, Any]],
    project_id: str,
    number: str,
    expected: dict[str, Any],
) -> list[dict[str, Any]]:
    candidates = hosted_provider_transition_service_candidates(
        services,
        project_id=project_id,
        project_number=number,
        service_name=expected["service"],
        attempt_id=expected["attemptId"],
    )
    return [
        candidate
        for candidate in candidates
        if _retained_hosted_service_matches(candidate.get("service"), expected)
    ]


def _classify_candidate(
    native_state: str, claims: list[dict[str, Any]], reviewed: bool, verified: bool
) -> str:
    if reviewed:
        return "reviewed_two_placement"
    if claims:
        return "registry_retained_hosted" if verified else "unresolved_registry_retained_hosted"
    return "unclassified_active_hosted_candidate"


def _candidate_summary(
    project: dict[str, Any],
    classification: str,
    claims: list[dict[str, Any]],
    service_state: str,
    candidates: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        **project,
        "classification": classification,
        "claims": [_claim_summary(claim) for claim in claims],
        "serviceInventoryState": service_state,
        "serviceCandidates": [_service_summary(item) for item in candidates],
        "candidateCount": len(candidates),
        "authorizedForMutation": False,
    }


def _check_reviewed_projects(state: InventoryState, projects: list[dict[str, Any]]) -> None:
    expected = {placement["projectId"] for placement in PLACEMENTS.values()}
    actual = {project["projectId"] for project in projects}
    if not expected.issubset(actual):
        state.unresolved.append("reviewed_project_folder_missing_pilot_project")
