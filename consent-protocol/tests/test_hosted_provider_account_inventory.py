from __future__ import annotations

from copy import deepcopy

import pytest

from hushh_mcp.services.hosted_provider_account_transition import PLACEMENTS
from scripts.ops.hosted_provider_account_identity import (
    REVIEWED_FOLDER_ID,
    OperatorRefused,
    _owner_hash,
    canonical_manifest_sha256,
    execute_action,
    require_reviewed_placement,
)
from tests.helpers.hosted_provider_account_ops import (
    _additional_hosted_row,
    _listed_project,
    _pilot_row,
    _project_identity,
    _ProjectReader,
    _ready_runtime,
    _RunClient,
    _service,
)

PLACEMENTS_PROJECTS = {placement["projectId"] for placement in PLACEMENTS.values()}


@pytest.mark.asyncio
async def test_real_inventory_adapter_joins_registry_generation_native_services_and_folder(
    monkeypatch,
):
    runtime = _ready_runtime(monkeypatch)

    snapshot = await runtime.inventory()

    assert snapshot.unresolved == ()
    assert len(snapshot.manifest["discoveredProjects"]) == 2
    assert len(snapshot.manifest["discoveredHostedCandidates"]) == 2
    assert all(
        item["classification"] == "reviewed_two_placement"
        for item in snapshot.manifest["discoveredHostedCandidates"]
    )
    assert all(item["identityState"] == "verified" for item in snapshot.placements.values())
    serialized = str(snapshot.manifest)
    assert "legacy-owner-" not in serialized
    assert snapshot.sha256 == canonical_manifest_sha256(snapshot.manifest)

    target_hushh_id = next(iter(PLACEMENTS))
    target_project = PLACEMENTS[target_hushh_id]["projectId"]
    wrong_path_service = _service(_pilot_row(target_hushh_id))
    wrong_path_service["spec"]["template"]["spec"]["containers"][0]["image"] = (
        "us-central1-docker.pkg.dev/hushh-pda-dev/one-pod/consent-protocol-pod@"
        "sha256:639958a5d5a9adf12c5a93839afaa3a8a1a86421896291b746b4e8c257ffc8a1"
    )
    correct_services = {
        placement["projectId"]: [_service(_pilot_row(hushh_id))]
        for hushh_id, placement in PLACEMENTS.items()
    }
    runtime.run_client_factory = lambda project, region: _RunClient(
        [wrong_path_service] if project == target_project else correct_services[project]
    )
    wrong_path_snapshot = await runtime.inventory()

    assert any(
        f"{target_hushh_id}:native_service_identity_mismatch" in reason
        for reason in wrong_path_snapshot.unresolved
    )


@pytest.mark.asyncio
async def test_native_project_number_mismatch_blocks_inventory_and_dispatch(monkeypatch):
    hushh_id = next(iter(PLACEMENTS))
    project_id = PLACEMENTS[hushh_id]["projectId"]
    wrong_identity = _project_identity(_pilot_row(hushh_id))
    wrong_identity["projectNumber"] = "999999999999"
    runtime = _ready_runtime(monkeypatch, project_overrides={project_id: wrong_identity})
    dispatched = []

    async def perform(*args, **kwargs):
        dispatched.append((args, kwargs))

    runtime.perform = perform
    snapshot = await runtime.inventory()

    assert snapshot.unresolved
    assert snapshot.placements[hushh_id]["nativeProjectState"] == "unreadable"
    with pytest.raises(OperatorRefused, match="inventory contains unresolved evidence"):
        await execute_action(
            runtime,
            action="resume",
            hushh_id=hushh_id,
            environment="dev",
            apply=True,
            manifest_sha256="0" * 64,
        )
    assert dispatched == []


@pytest.mark.asyncio
async def test_retained_identity_uses_authoritative_top_level_backend_fields(monkeypatch):
    hushh_id = next(iter(PLACEMENTS))
    rows = [_pilot_row(owner) for owner in PLACEMENTS]
    row = next(item for item in rows if item["hushh_id"] == hushh_id)
    row["backend"] = "user_gcp"
    row["deployment_target"] = "user_gcp"
    row["backend_metadata"]["backend"] = "gcp"
    row["backend_metadata"]["deployment_target"] = "gcp"
    runtime = _ready_runtime(monkeypatch, rows=rows)

    snapshot = await runtime.inventory()

    assert f"{hushh_id}:retained_creation_identity_mismatch" in snapshot.unresolved
    assert snapshot.placements[hushh_id]["identityState"] == "unresolved"


def _non_reviewed_retained_service_fixture(monkeypatch):
    rows = [_pilot_row(hushh_id) for hushh_id in PLACEMENTS]
    retained = _additional_hosted_row()
    discovery = [*[_listed_project(row) for row in rows], _listed_project(retained)]
    runtime = _ready_runtime(monkeypatch, rows=rows, discovery=discovery)
    runtime.registry.rows = [*runtime.registry.rows, retained]
    fetch_fleet_inventory = runtime.registry.fetch_fleet_inventory

    async def fleet_rows_without_owner_columns():
        return [
            {key: value for key, value in row.items() if key != "user_id"}
            for row in await fetch_fleet_inventory()
        ]

    runtime.registry.fetch_fleet_inventory = fleet_rows_without_owner_columns
    project_id = retained["backend_metadata"]["project"]
    metadata = retained["backend_metadata"]
    attempt = metadata["provisionAttempt"]
    expected_service = _service_for_retained_claim(retained)
    services_by_project = {row["backend_metadata"]["project"]: [_service(row)] for row in rows}
    services_by_project[project_id] = [expected_service]
    identities = {
        row["backend_metadata"]["project"]: _project_identity(row) for row in [*rows, retained]
    }
    runtime.project_reader_factory = lambda project, number: _ProjectReader(identities[project])
    runtime.run_client_factory = lambda project, region: _RunClient(
        services_by_project.get(project, [])
    )
    return runtime, project_id, metadata, attempt, services_by_project, expected_service


def _service_for_retained_claim(row):
    metadata = row["backend_metadata"]
    attempt = metadata["provisionAttempt"]
    image = attempt["evidence"]["host_requested"]["creationAcknowledgement"]["initialImage"]
    return {
        "metadata": {
            "name": metadata["service"],
            "namespace": str(attempt["hostedAdmission"]["assignment"]["projectNumber"]),
            "uid": metadata["serviceUid"],
            "labels": {
                "app": "hussh-one-pod",
                "hussh-tenancy": "hussh-hosted",
                "hussh-provision-attempt": attempt["attemptId"],
            },
        },
        "spec": {
            "template": {
                "spec": {
                    "serviceAccountName": metadata["runtime_service_account"],
                    "containers": [{"image": image}],
                }
            }
        },
    }


@pytest.mark.asyncio
async def test_non_reviewed_hosted_claim_requires_exact_native_service_identity(monkeypatch):
    runtime, project_id, metadata, attempt, services_by_project, expected_service = (
        _non_reviewed_retained_service_fixture(monkeypatch)
    )
    matching = await runtime.inventory()
    assert matching.unresolved == ()
    candidate = next(
        item
        for item in matching.manifest["discoveredHostedCandidates"]
        if item["projectId"] == project_id
    )
    assert candidate["classification"] == "registry_retained_hosted"

    stale_service = deepcopy(expected_service)
    stale_service["spec"]["template"]["spec"]["serviceAccountName"] = (
        "wrong-runtime@hussh-hp-retained-inventory.iam.gserviceaccount.com"
    )
    services_by_project[project_id] = [stale_service]
    mismatched = await runtime.inventory()
    assert any(
        f"project:{project_id}:retained_hosted_service_match_count_" in reason
        for reason in mismatched.unresolved
    )
    candidate = next(
        item
        for item in mismatched.manifest["discoveredHostedCandidates"]
        if item["projectId"] == project_id
    )
    assert candidate["classification"] == "unresolved_registry_retained_hosted"

    wrong_path_service = deepcopy(expected_service)
    wrong_path_service["spec"]["template"]["spec"]["serviceAccountName"] = metadata[
        "runtime_service_account"
    ]
    wrong_path_service["spec"]["template"]["spec"]["containers"][0]["image"] = (
        "us-central1-docker.pkg.dev/hushh-pda-dev/one-pod/consent-protocol-pod@"
        f"{attempt['hostedAdmission']['imageDigest']}"
    )
    services_by_project[project_id] = [wrong_path_service]
    wrong_image = await runtime.inventory()
    assert any(
        f"project:{project_id}:retained_hosted_service_match_count_" in reason
        for reason in wrong_image.unresolved
    )


@pytest.mark.asyncio
async def test_invalid_retained_claim_sentinel_blocks_global_inventory(monkeypatch):
    rows = [_pilot_row(hushh_id) for hushh_id in PLACEMENTS]
    rows[0]["backend_metadata"]["detachedPlacements"] = "malformed"
    runtime = _ready_runtime(monkeypatch, rows=rows)

    snapshot = await runtime.inventory()

    assert any(
        reason.startswith("fleet_registry_invalid_retained:") for reason in snapshot.unresolved
    )


@pytest.mark.asyncio
async def test_folder_candidate_without_registry_claim_is_unresolved(monkeypatch):
    rows = [_pilot_row(hushh_id) for hushh_id in PLACEMENTS]
    outside_project = "hussh-hp-unreviewed-pilot"
    outside = {
        "projectId": outside_project,
        "projectNumber": "777777777777",
        "parent": {"type": "folder", "id": REVIEWED_FOLDER_ID},
        "labels": {"tenancy": "hussh-hosted"},
        "lifecycleState": "ACTIVE",
    }
    owner_project = {
        "projectId": "owner-controlled-project",
        "projectNumber": "888888888888",
        "parent": {"type": "folder", "id": REVIEWED_FOLDER_ID},
        "labels": {"tenancy": "user-owned"},
        "lifecycleState": "ACTIVE",
    }
    runtime = _ready_runtime(
        monkeypatch,
        discovery=[*[_listed_project(row) for row in rows], outside, owner_project],
    )
    runtime.project_reader_factory = lambda project, number: _ProjectReader(
        _project_identity(
            next(row for row in rows if row["backend_metadata"]["project"] == project)
        )
        if project != outside_project
        else outside
    )
    runtime.run_client_factory = lambda project, region: _RunClient(
        [_service(next(row for row in rows if row["backend_metadata"]["project"] == project))]
        if project in PLACEMENTS_PROJECTS
        else []
    )

    snapshot = await runtime.inventory()

    assert any("unclassified_active_hosted_candidate" in reason for reason in snapshot.unresolved)
    assert not any("owner_candidate_claim_unresolved" in reason for reason in snapshot.unresolved)
    discovered = next(
        item
        for item in snapshot.manifest["discoveredHostedCandidates"]
        if item["projectId"] == outside_project
    )
    assert discovered["authorizedForMutation"] is False
    owner_discovered = next(
        item
        for item in snapshot.manifest["discoveredHostedCandidates"]
        if item["projectId"] == owner_project["projectId"]
    )
    assert owner_discovered["classification"] == "owner_owned_preserved"
    assert owner_discovered["authorizedForMutation"] is False


@pytest.mark.asyncio
async def test_delete_requested_retirement_resumes_with_absent_service_and_exact_erasure_pair(
    monkeypatch,
):
    from copy import deepcopy

    hushh_id = next(iter(PLACEMENTS))
    active = _pilot_row(hushh_id)
    erasure_attempt = "5c177d95-4a4f-4cda-b168-69468fd7e6f0"
    snapshot = deepcopy(active)
    pending_identity = deepcopy(_project_identity(snapshot))
    pending_identity["lifecycleState"] = "DELETE_REQUESTED"
    deletion = {
        "ownerId": snapshot["user_id"],
        "attemptId": erasure_attempt,
        "project": PLACEMENTS[hushh_id]["projectId"],
        "projectNumber": PLACEMENTS[hushh_id]["projectNumber"],
        "status": "retirement_pending_provider_purge",
        "projectIdentity": pending_identity,
    }
    erasure = {
        "ownerId": snapshot["user_id"],
        "attemptId": erasure_attempt,
        "phase": "retirement",
        "registrySnapshot": snapshot,
        "managedProjectRetirement": {"deletion": deletion},
    }
    suspended = deepcopy(snapshot)
    suspended["status"] = "suspended"
    suspended["backend_metadata"] = {**snapshot["backend_metadata"], "erasure": erasure}
    other = _pilot_row(next(item for item in PLACEMENTS if item != hushh_id))
    pending_tombstone = {
        "hushh_id": hushh_id,
        "status": "deprovision_requested",
        "external_agent_id": snapshot["external_agent_id"],
    }
    auxiliary = {
        _owner_hash(snapshot["user_id"]): {"accountTombstones": []},
        snapshot["user_id"]: {"removals": []},
        hushh_id: {"personalTombstones": [pending_tombstone]},
    }
    listed = [_listed_project(suspended), _listed_project(other)]
    listed[0]["lifecycleState"] = "DELETE_REQUESTED"
    runtime = _ready_runtime(
        monkeypatch,
        rows=[suspended, other],
        discovery=listed,
        project_overrides={PLACEMENTS[hushh_id]["projectId"]: pending_identity},
        auxiliary=auxiliary,
    )
    runtime.run_client_factory = lambda project, region: _RunClient(
        [] if project == PLACEMENTS[hushh_id]["projectId"] else [_service(other)]
    )

    inventory = await runtime.inventory()
    placement = inventory.placements[hushh_id]

    assert inventory.unresolved == ()
    assert placement["nativeProjectState"] == "pending_delete"
    assert placement["nativeServiceState"] == "absent"
    assert placement["tombstoneState"]["state"] == "current_erasure"
    assert require_reviewed_placement(inventory, hushh_id=hushh_id) is placement
