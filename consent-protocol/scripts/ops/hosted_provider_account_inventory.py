from __future__ import annotations

import asyncio
from typing import Any

from hushh_mcp.services.account_generation_service import AccountGenerationService
from hushh_mcp.services.hosted_provider_account_transition import PLACEMENTS
from hushh_mcp.services.pod_fleet_claims import expand_retained_claims
from scripts.ops.hosted_provider_account_evidence import (
    _current_erasure_tombstone_pair,
    _removal_summary,
    _tombstone_summary,
)
from scripts.ops.hosted_provider_account_identity import (
    MANIFEST_SCHEMA,
    OLD_BILLING_ACCOUNT,
    REGION,
    REVIEWED_FOLDER_ID,
    TARGET_BILLING_ACCOUNT,
    InventorySnapshot,
    _attempt,
    _authority_row,
    _creation_identity,
    _digest,
    _lifecycle_phase,
    _owner_hash,
    _read_native_project_identity,
    _registry_evidence,
    _retained_service_name,
    _service_matches,
    _service_summary,
    canonical_manifest_sha256,
)
from scripts.ops.hosted_provider_account_inventory_folder import (
    InventoryState,
    read_folder_inventory,
)
from scripts.ops.pod_reconcile import hosted_provider_transition_service_candidates

"""Inventory joins for the two reviewed owner placements."""


async def read_registry_claims(state: InventoryState) -> None:
    try:
        state.fleet_rows = await state.runtime.registry.fetch_fleet_inventory()
        state.claims = expand_retained_claims(state.fleet_rows)
    except Exception as exc:  # noqa: BLE001 - unreadable registry is not absence
        state.unresolved.append(f"fleet_registry_unreadable:{type(exc).__name__}")
        return
    invalid = sum(
        isinstance(claim, dict) and claim.get("claim_source") == "invalid_retained"
        for claim in state.claims
    )
    if invalid:
        state.unresolved.append(f"fleet_registry_invalid_retained:{invalid}")


async def read_reviewed_placements(state: InventoryState) -> None:
    for hushh_id, expected in sorted(PLACEMENTS.items()):
        await read_reviewed_placement(state, hushh_id, expected)


async def read_reviewed_placement(
    state: InventoryState, hushh_id: str, expected: dict[str, Any]
) -> None:
    entry = _empty_entry(hushh_id, expected)
    row = await _read_row(state, hushh_id, entry)
    authority = _authority_row(row)
    attempt = _attempt(authority)
    owner = str((row or {}).get("user_id") or "")
    _set_registry_state(state, hushh_id, entry, row, attempt)
    owner_hash = _owner_hash(owner) if owner else None
    entry["ownerHash"] = owner_hash
    identity_hash, generation, identity_error = await _owner_generation(
        state, hushh_id, owner, entry
    )
    auxiliary = await _read_auxiliary(
        state, hushh_id, owner, owner_hash, identity_hash, expected, row, entry
    )
    project = await _read_project(state, hushh_id, expected, entry)
    services, candidates = await _read_services(
        state, hushh_id, expected, row, authority, attempt, project, entry
    )
    _finish_reviewed_placement(
        state,
        hushh_id,
        expected,
        row,
        authority,
        attempt,
        owner,
        owner_hash,
        identity_hash,
        generation,
        identity_error,
        auxiliary,
        project,
        services,
        candidates,
        entry,
    )


def _empty_entry(hushh_id: str, expected: dict[str, Any]) -> dict[str, Any]:
    return {
        "hushhId": hushh_id,
        "projectId": expected["projectId"],
        "projectNumber": expected["projectNumber"],
        "placementEpoch": expected["placementEpoch"],
        "attemptId": expected["attemptId"],
        "operationId": expected["operationId"],
        "ownerHash": None,
        "ownerGeneration": None,
        "registryState": "unavailable",
        "identityState": "unresolved",
        "nativeProjectState": "unreadable",
        "nativeServiceState": "unreadable",
        "lifecycleState": "unresolved",
        "serviceCandidates": [],
        "tombstoneState": "unreadable",
        "removalState": "unreadable",
    }


async def _read_row(
    state: InventoryState, hushh_id: str, entry: dict[str, Any]
) -> dict[str, Any] | None:
    try:
        row = await state.runtime.registry.get_by_hushh_id(hushh_id)
        if row is not None and not isinstance(row, dict):
            raise TypeError("registry row malformed")
        return row
    except Exception as exc:  # noqa: BLE001 - unreadable registry is not absence
        state.unresolved.append(f"{hushh_id}:registry_unreadable:{type(exc).__name__}")
        return None


def _set_registry_state(
    state: InventoryState,
    hushh_id: str,
    entry: dict[str, Any],
    row: dict[str, Any] | None,
    attempt: dict[str, Any],
) -> None:
    if row is None:
        entry["registryState"] = "absent"
        return
    entry["registryState"] = str(row.get("status") or "unknown")
    entry["lifecycleState"] = str(row.get("status") or "unknown")
    entry["attemptPhase"] = str(attempt.get("phase") or "unknown")
    entry["erasurePhase"] = _lifecycle_phase(row, attempt)


async def _owner_generation(
    state: InventoryState,
    hushh_id: str,
    owner: str,
    entry: dict[str, Any],
) -> tuple[str | None, int | None, str | None]:
    if not owner:
        return None, None, None
    try:
        identity = await asyncio.to_thread(
            AccountGenerationService.firebase_identity_for_owner, owner
        )
        if not isinstance(identity, str) or not identity:
            raise ValueError("owner identity mapping missing")
        generation = await asyncio.to_thread(state.runtime._owner_generation, owner)
        entry["ownerGeneration"] = generation
        return _owner_hash(identity), generation, None
    except Exception as exc:  # noqa: BLE001 - owner map is a required join
        reason = type(exc).__name__
        state.unresolved.append(f"{hushh_id}:owner_generation_unresolved:{reason}")
        return None, None, reason


async def _read_auxiliary(
    state: InventoryState,
    hushh_id: str,
    owner: str,
    owner_hash: str | None,
    identity_hash: str | None,
    expected: dict[str, Any],
    row: dict[str, Any] | None,
    entry: dict[str, Any],
) -> dict[str, Any]:
    try:
        auxiliary = await state.runtime._retained_records(
            owner_id=owner or None,
            owner_hash=owner_hash,
            identity_hash=identity_hash,
            hushh_id=hushh_id,
            attempt_id=expected["attemptId"],
        )
        auxiliary["currentErasureTombstonePair"] = _current_erasure_tombstone_pair(
            row, auxiliary, expected
        )
        entry["tombstoneState"] = _tombstone_summary(auxiliary)
        entry["removalState"] = _removal_summary(auxiliary)
        return auxiliary
    except Exception as exc:  # noqa: BLE001 - denial never becomes empty
        state.unresolved.append(f"{hushh_id}:retained_archive_unreadable:{type(exc).__name__}")
        return {}


async def _read_project(
    state: InventoryState,
    hushh_id: str,
    expected: dict[str, Any],
    entry: dict[str, Any],
) -> dict[str, Any] | None:
    try:
        reader = state.runtime.project_reader_factory(
            project=expected["projectId"], number=expected["projectNumber"]
        )
        identity = await asyncio.to_thread(_read_native_project_identity, reader, expected)
        state.project_identities[expected["projectId"]] = identity
    except Exception as exc:  # noqa: BLE001 - unreadable is never absence
        if getattr(exc, "http_status", None) == 404:
            entry["nativeProjectState"] = "absent"
        else:
            state.unresolved.append(f"{hushh_id}:native_project_unreadable:{type(exc).__name__}")
        return None
    lifecycle = identity.get("lifecycleState")
    if lifecycle == "DELETE_REQUESTED":
        entry["nativeProjectState"] = "pending_delete"
    elif lifecycle != "ACTIVE":
        entry["nativeProjectState"] = "non_active"
        state.unresolved.append(f"{hushh_id}:project_not_active")
    else:
        entry["nativeProjectState"] = "active"
    return identity


async def _read_services(
    state: InventoryState,
    hushh_id: str,
    expected: dict[str, Any],
    row: dict[str, Any] | None,
    authority: dict[str, Any] | None,
    attempt: dict[str, Any],
    project: dict[str, Any] | None,
    entry: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if project is None or entry["nativeProjectState"] not in {"active", "pending_delete"}:
        return [], []
    try:
        client = state.runtime.run_client_factory(project=expected["projectId"], region=REGION)
        services = await asyncio.to_thread(client.list_services)
        state.services_by_project[expected["projectId"]] = services
        candidates = hosted_provider_transition_service_candidates(
            services,
            project_id=expected["projectId"],
            project_number=expected["projectNumber"],
            service_name=_retained_service_name(authority, expected),
            attempt_id=expected["attemptId"],
        )
        matching = [
            candidate
            for candidate in candidates
            if _service_matches(candidate.get("service"), row=authority, expected=expected)
        ]
        _set_service_entry(state, hushh_id, row, candidates, matching, entry)
        return services, candidates
    except Exception as exc:  # noqa: BLE001 - list failures are not absence
        entry["nativeServiceState"] = "unreadable"
        state.unresolved.append(f"{hushh_id}:native_service_unreadable:{type(exc).__name__}")
        return [], []


def _set_service_entry(
    state: InventoryState,
    hushh_id: str,
    row: dict[str, Any] | None,
    candidates: list[dict[str, Any]],
    matching: list[dict[str, Any]],
    entry: dict[str, Any],
) -> None:
    entry["nativeServiceState"] = (
        "verified"
        if len(matching) == 1 and len(candidates) == 1
        else "absent"
        if not candidates
        else "ambiguous"
    )
    entry["serviceCandidates"] = [_service_summary(item) for item in candidates]
    if candidates and (len(matching) != 1 or len(candidates) != 1):
        state.unresolved.append(f"{hushh_id}:native_service_identity_mismatch")
    if not candidates and str((row or {}).get("status") or "") in {"provisioned", "connecting"}:
        state.unresolved.append(f"{hushh_id}:retained_service_absent")


def _finish_reviewed_placement(
    state: InventoryState,
    hushh_id: str,
    expected: dict[str, Any],
    row: dict[str, Any] | None,
    authority: dict[str, Any] | None,
    attempt: dict[str, Any],
    owner: str,
    owner_hash: str | None,
    identity_hash: str | None,
    generation: int | None,
    identity_error: str | None,
    auxiliary: dict[str, Any],
    project: dict[str, Any] | None,
    services: list[dict[str, Any]],
    candidates: list[dict[str, Any]],
    entry: dict[str, Any],
) -> None:
    from scripts.ops.hosted_provider_account_identity import _json_value
    from scripts.ops.hosted_provider_account_retained import _retained_identity_matches

    ok, reason = _retained_identity_matches(
        raw_row=row,
        authority_row=authority,
        expected=expected,
        project_identity=project,
        service_candidates=candidates,
        claims=state.claims,
        auxiliary=auxiliary,
        owner_identity_error=identity_error,
    )
    entry["identityState"] = "verified" if ok else "unresolved"
    if not ok:
        state.unresolved.append(f"{hushh_id}:{reason or 'retained_identity_unresolved'}")
    _finalize_entry(entry, expected, attempt, authority, project, row, auxiliary, _json_value)
    state.placements[hushh_id] = entry
    state.records[hushh_id] = _record(
        row,
        authority,
        owner,
        identity_hash,
        generation,
        project,
        services,
        candidates,
        auxiliary,
        hushh_id,
        state.claims,
    )


def _finalize_entry(
    entry: dict[str, Any],
    expected: dict[str, Any],
    attempt: dict[str, Any],
    authority: dict[str, Any] | None,
    project: dict[str, Any] | None,
    row: dict[str, Any] | None,
    auxiliary: dict[str, Any],
    json_value: Any,
) -> None:
    transition = attempt.get("providerAccountTransition")
    transition = transition if isinstance(transition, dict) else None
    entry["transitionPhase"] = transition.get("phase") if transition else "none"
    entry["transitionGeneration"] = transition.get("generation", 0) if transition else 0
    entry["projectParent"] = json_value((project or {}).get("parent"))
    entry["projectLabels"] = json_value((project or {}).get("labels"))
    entry["creationIdentitySha256"] = _digest(_creation_identity(authority))
    entry["registryEvidenceSha256"] = _digest(_registry_evidence(row))
    entry["removalEvidenceSha256"] = _digest(auxiliary.get("removals", []))
    entry["tombstoneEvidenceSha256"] = _digest(
        {
            "personal": auxiliary.get("personalTombstones", []),
            "account": auxiliary.get("accountTombstones", []),
        }
    )


def _record(
    row: dict[str, Any] | None,
    authority: dict[str, Any] | None,
    owner: str,
    identity_hash: str | None,
    generation: int | None,
    project: dict[str, Any] | None,
    services: list[dict[str, Any]],
    candidates: list[dict[str, Any]],
    auxiliary: dict[str, Any],
    hushh_id: str,
    claims: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "registryRow": row,
        "authorityRow": authority,
        "ownerId": owner,
        "resolvedIdentityHash": identity_hash,
        "ownerGeneration": generation,
        "nativeProject": project,
        "services": services,
        "candidates": candidates,
        "auxiliary": auxiliary,
        "claims": [
            claim
            for claim in claims
            if isinstance(claim, dict) and claim.get("hushh_id") == hushh_id
        ],
    }


"""Read-only inventory assembly for the hosted provider-account operator."""


async def build_inventory(runtime: Any) -> InventorySnapshot:
    state = InventoryState(runtime=runtime)
    await read_registry_claims(state)
    await read_reviewed_placements(state)
    await read_folder_inventory(state)
    return snapshot(state)


def snapshot(state: InventoryState) -> InventorySnapshot:
    unresolved = list(dict.fromkeys(state.unresolved))
    manifest = {
        "schema": MANIFEST_SCHEMA,
        "environment": "dev",
        "region": REGION,
        "oldBillingAccount": OLD_BILLING_ACCOUNT,
        "targetBillingAccount": TARGET_BILLING_ACCOUNT,
        "placements": [state.placements[key] for key in sorted(state.placements)],
        "reviewedFolderId": REVIEWED_FOLDER_ID,
        "discoveredProjects": state.discovered_projects,
        "discoveredHostedCandidates": state.discovered_candidates,
        "unresolved": unresolved,
    }
    return InventorySnapshot(
        manifest=manifest,
        sha256=canonical_manifest_sha256(manifest),
        placements=state.placements,
        unresolved=tuple(unresolved),
        records=state.records,
    )
