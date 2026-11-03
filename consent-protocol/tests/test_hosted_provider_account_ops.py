from __future__ import annotations

from copy import deepcopy
from dataclasses import replace
from types import SimpleNamespace

import pytest

from hushh_mcp.services.hosted_provider_account_transition import PLACEMENTS
from scripts.ops.hosted_provider_account_ops import (
    EXPECTED_OPERATOR,
    MANIFEST_SCHEMA,
    REVIEWED_FOLDER_ID,
    HostedProviderAccountRuntime,
    InventorySnapshot,
    NamedGcloudOperatorCredentials,
    OperatorRefused,
    _current_erasure_tombstone_pair,
    _owner_hash,
    canonical_manifest_sha256,
    execute_action,
)


def _snapshot(*, hushh_id=None, project_id=None, identity_state="verified"):
    selected = hushh_id or next(iter(PLACEMENTS))
    placement = PLACEMENTS[selected]
    entry = {
        "hushhId": selected,
        "projectId": project_id or placement["projectId"],
        "identityState": identity_state,
        "lifecycleState": "provisioned",
        "ownerGeneration": 0,
        "attemptId": placement["attemptId"],
    }
    manifest = {"schema": MANIFEST_SCHEMA, "placements": [entry]}
    return InventorySnapshot(
        manifest=manifest,
        sha256=canonical_manifest_sha256(manifest),
        placements={selected: entry},
        unresolved=("native/registry identity unresolved",) if identity_state != "verified" else (),
    )


class _Runtime:
    def __init__(self, *snapshots):
        self.snapshots = list(snapshots)
        self.inventory_calls = 0
        self.actions = []

    async def inventory(self):
        snapshot = self.snapshots[min(self.inventory_calls, len(self.snapshots) - 1)]
        self.inventory_calls += 1
        return snapshot

    async def perform(self, action, placement, *, reviewed_sha256, inventory_snapshot):
        self.actions.append((action, deepcopy(placement)))
        assert reviewed_sha256
        assert inventory_snapshot.sha256 == reviewed_sha256
        return {"status": "synthetic-complete"}


@pytest.mark.asyncio
async def test_mutating_action_defaults_to_report_only_without_lifecycle_call():
    snapshot = _snapshot()
    runtime = _Runtime(snapshot)

    result = await execute_action(
        runtime,
        action="associate-account",
        hushh_id=next(iter(PLACEMENTS)),
        environment=None,
        apply=False,
        manifest_sha256=None,
    )

    assert result["reportOnly"] is True
    assert result["manifestSha256"] == snapshot.sha256
    assert runtime.inventory_calls == 1
    assert runtime.actions == []


@pytest.mark.asyncio
async def test_apply_requires_explicit_dev_and_exact_reviewed_manifest_before_dispatch():
    snapshot = _snapshot()
    runtime = _Runtime(snapshot)
    hushh_id = next(iter(PLACEMENTS))

    with pytest.raises(OperatorRefused, match="--environment dev"):
        await execute_action(
            runtime,
            action="resume",
            hushh_id=hushh_id,
            environment="uat",
            apply=True,
            manifest_sha256=snapshot.sha256,
        )
    assert runtime.actions == []

    stale_runtime = _Runtime(snapshot)
    with pytest.raises(OperatorRefused, match="reviewed manifest SHA is stale"):
        await execute_action(
            stale_runtime,
            action="resume",
            hushh_id=hushh_id,
            environment="dev",
            apply=True,
            manifest_sha256="0" * 64,
        )
    assert stale_runtime.actions == []


@pytest.mark.asyncio
async def test_apply_reinventory_blocks_identity_drift_and_protected_projects():
    hushh_id = next(iter(PLACEMENTS))
    reviewed = _snapshot(hushh_id=hushh_id)
    changed = _snapshot(hushh_id=hushh_id, identity_state="unresolved")
    runtime = _Runtime(reviewed, changed)

    with pytest.raises(OperatorRefused, match="fresh inventory contains unresolved"):
        await execute_action(
            runtime,
            action="remove",
            hushh_id=hushh_id,
            environment="dev",
            apply=True,
            manifest_sha256=reviewed.sha256,
        )
    assert runtime.actions == []

    protected = _snapshot(hushh_id=hushh_id, project_id="hushh-pda-dev")
    with pytest.raises(OperatorRefused, match="protected project"):
        await execute_action(
            _Runtime(protected),
            action="remove",
            hushh_id=hushh_id,
            environment=None,
            apply=False,
            manifest_sha256=None,
        )


@pytest.mark.asyncio
async def test_reviewed_synthetic_removal_routes_once_after_fresh_manifest_match():
    hushh_id = next(iter(PLACEMENTS))
    reviewed = _snapshot(hushh_id=hushh_id)
    runtime = _Runtime(reviewed, reviewed)

    result = await execute_action(
        runtime,
        action="remove",
        hushh_id=hushh_id,
        environment="dev",
        apply=True,
        manifest_sha256=reviewed.sha256,
    )

    assert result["result"] == {"status": "synthetic-complete"}
    assert runtime.inventory_calls == 2
    assert len(runtime.actions) == 1
    assert runtime.actions[0][0] == "remove"


def test_canonical_manifest_digest_ignores_mapping_insertion_order():
    left = {"schema": MANIFEST_SCHEMA, "placements": [{"projectId": "project-a", "owner": 1}]}
    right = {"placements": [{"owner": 1, "projectId": "project-a"}], "schema": MANIFEST_SCHEMA}
    assert canonical_manifest_sha256(left) == canonical_manifest_sha256(right)


class _FakeDb:
    def __init__(self, auxiliary=None):
        self.auxiliary = auxiliary or {}

    def execute_raw(self, sql, params=None):
        params = params or {}
        if "to_regclass('public.account_generations')" in sql:
            return SimpleNamespace(data=[{"installed": True}])
        if "SELECT generation,owner_id,retired_at" in sql:
            return SimpleNamespace(data=[])
        if "to_regclass('public.personal_agent_deletion_tombstones')" in sql:
            return SimpleNamespace(data=[{"personal": True, "account": True, "removals": True}])
        if "personal_agent_deletion_tombstones t" in sql:
            return SimpleNamespace(
                data=[
                    {"record": item}
                    for item in self.auxiliary.get(params.get("hushh_id"), {}).get(
                        "personalTombstones", []
                    )
                ]
            )
        if "personal_agent_cloud_removals c" in sql:
            return SimpleNamespace(
                data=[
                    {"record": item}
                    for item in self.auxiliary.get(params.get("owner_id"), {}).get("removals", [])
                ]
            )
        if "account_deletion_tombstones t" in sql:
            return SimpleNamespace(
                data=[
                    {"record": item}
                    for item in self.auxiliary.get(params.get("owner_hash"), {}).get(
                        "accountTombstones", []
                    )
                ]
            )
        raise AssertionError(f"unexpected query shape: {sql[:80]}")


class _FakeRegistry:
    def __init__(self, rows, auxiliary=None):
        self.rows = rows
        self.database = _FakeDb(auxiliary)

    def _db(self):
        return self.database

    async def get_by_hushh_id(self, hushh_id):
        return next((row for row in self.rows if row["hushh_id"] == hushh_id), None)

    async def fetch_fleet_inventory(self):
        return [{**deepcopy(row), "claim_source": "primary"} for row in self.rows]


def _pilot_row(hushh_id):
    from hushh_mcp.services.gcp_backend import _service_name

    placement = PLACEMENTS[hushh_id]
    owner_id = f"legacy-owner-{hushh_id[-4:]}"
    attempt_id = placement["attemptId"]
    project_id = placement["projectId"]
    parent = {"type": "folder", "id": REVIEWED_FOLDER_ID}
    project_labels = {
        "created-by": "hussh-one",
        "tenancy": "hussh-hosted",
        "hussh-provision-attempt": attempt_id,
        "hussh-environment": "dev",
    }
    identity = {
        "projectId": project_id,
        "projectNumber": placement["projectNumber"],
        "lifecycleState": "ACTIVE",
        "parent": parent,
        "labels": project_labels,
    }
    steps = [
        "create_project",
        "link_billing",
        "authorize_project",
        "inference_vertex",
        "inference_quota",
    ]
    completed = []
    for step in steps:
        receipt = {"step": step, "status": 200, "ok": True}
        if step == "create_project":
            receipt["resourceObservation"] = {"identity": identity}
        if step == "link_billing":
            receipt["billingObservation"] = {
                "projectId": project_id,
                "billingAccountName": "billingAccounts/014D7F-FD970D-D2459E",
                "billingEnabled": True,
            }
        completed.append(receipt)
    attempt = {
        "ownerId": owner_id,
        "attemptId": attempt_id,
        "phase": "provisioned",
        "intent": {"user_id": owner_id, "hushh_id": hushh_id},
        "hostedAdmission": {
            "environment": "dev",
            "sourceRevision": "a" * 40,
            "imageDigest": "sha256:639958a5d5a9adf12c5a93839afaa3a8a1a86421896291b746b4e8c257ffc8a1",
            "assignment": {
                "hushhId": hushh_id,
                "ownerHash": _owner_hash(owner_id),
                "project": project_id,
                "projectNumber": placement["projectNumber"],
                "region": "us-central1",
                "preparationContract": {
                    "billingAccount": "billingAccounts/014D7F-FD970D-D2459E",
                    "operatorPrincipal": EXPECTED_OPERATOR,
                },
            },
        },
        "evidence": {
            "reserved": {
                "projectObservation": {
                    "projectId": project_id,
                    "projectNumber": placement["projectNumber"],
                    "lifecycleState": "ACTIVE",
                },
                "hostedPreparation": {"phase": "observed", "completed": completed},
            },
            "host_requested": {
                "creationAcknowledgement": {
                    "service": _service_name(hushh_id),
                    "serviceUid": placement["serviceUid"],
                    "initialImage": (
                        f"us-central1-docker.pkg.dev/{project_id}/one-pod/consent-protocol-pod@"
                        "sha256:639958a5d5a9adf12c5a93839afaa3a8a1a86421896291b746b4e8c257ffc8a1"
                    ),
                }
            },
        },
    }
    metadata = {
        "tenancy": "hussh-hosted",
        "project": project_id,
        "region": "us-central1",
        "service": _service_name(hushh_id),
        "serviceUid": placement["serviceUid"],
        "runtime_service_account": placement["runtimePrincipal"],
        "provisionAttempt": attempt,
    }
    row = {
        "user_id": owner_id,
        "hushh_id": hushh_id,
        "external_agent_id": _service_name(hushh_id),
        "status": "provisioned",
        "placement_epoch": placement["placementEpoch"],
        "backend": "gcp",
        "deployment_target": "gcp",
        "backend_metadata": metadata,
    }
    return row


def _additional_hosted_row():
    from hushh_mcp.services.gcp_backend import _service_name
    from hushh_mcp.services.user_gcp_backend import pod_service_account_id

    row = deepcopy(_pilot_row(next(iter(PLACEMENTS))))
    hushh_id = "ha1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    project_id = "hussh-hp-retained-inventory"
    project_number = "667788990011"
    service_uid = "retained-service-uid-001"
    metadata = row["backend_metadata"]
    attempt = metadata["provisionAttempt"]
    attempt_id = "7c5140de-a5a7-4d0c-a624-623688c7b443"
    service = _service_name(hushh_id)
    row["hushh_id"] = hushh_id
    row["external_agent_id"] = service
    attempt["intent"]["hushh_id"] = hushh_id
    attempt["attemptId"] = attempt_id
    admission = attempt["hostedAdmission"]
    admission["assignment"]["hushhId"] = hushh_id
    admission["assignment"]["project"] = project_id
    admission["assignment"]["projectNumber"] = project_number
    observation = attempt["evidence"]["reserved"]["projectObservation"]
    observation.update(projectId=project_id, projectNumber=project_number)
    metadata.update(
        project=project_id,
        service=service,
        serviceUid=service_uid,
        runtime_service_account=(
            f"{pod_service_account_id(row['hushh_id'])}@{project_id}.iam.gserviceaccount.com"
        ),
    )
    identity = _project_identity(row)
    identity.update(
        projectId=project_id,
        projectNumber=project_number,
        labels={
            **identity["labels"],
            "hussh-provision-attempt": attempt_id,
        },
    )
    acknowledgement = attempt["evidence"]["host_requested"]["creationAcknowledgement"]
    acknowledgement.update(
        backend="gcp",
        project=project_id,
        region="us-central1",
        service=service,
        serviceUid=service_uid,
    )
    acknowledgement["initialImage"] = (
        f"us-central1-docker.pkg.dev/{project_id}/one-pod/consent-protocol-pod@"
        f"{admission['imageDigest']}"
    )
    return row


def _project_identity(row):
    from scripts.ops.hosted_provider_account_ops import _authority_row

    row = _authority_row(row) or row
    attempt = row["backend_metadata"]["provisionAttempt"]
    return attempt["evidence"]["reserved"]["hostedPreparation"]["completed"][0][
        "resourceObservation"
    ]["identity"]


def _service(row):
    from hushh_mcp.services.hosted_provider_account_transition import IMAGE_DIGEST
    from scripts.ops.hosted_provider_account_ops import _authority_row

    row = _authority_row(row) or row
    metadata = row["backend_metadata"]
    attempt = metadata["provisionAttempt"]
    placement = PLACEMENTS[row["hushh_id"]]
    return {
        "metadata": {
            "name": metadata["service"],
            "namespace": placement["projectNumber"],
            "uid": placement["serviceUid"],
            "labels": {
                "app": "hussh-one-pod",
                "hussh-tenancy": "hussh-hosted",
                "hussh-provision-attempt": attempt["attemptId"],
            },
        },
        "spec": {
            "template": {
                "spec": {
                    "serviceAccountName": placement["runtimePrincipal"],
                    "containers": [
                        {
                            "image": (
                                f"us-central1-docker.pkg.dev/{placement['projectId']}/one-pod/"
                                f"consent-protocol-pod@{IMAGE_DIGEST}"
                            )
                        }
                    ],
                }
            }
        },
    }


class _Response:
    status_code = 200

    def __init__(self, value):
        self.value = value

    def json(self):
        return deepcopy(self.value)


class _ProjectReader:
    def __init__(self, value):
        self.value = value

    def response(self, _url, _params):
        return _Response(self.value)

    @staticmethod
    def body(response):
        return response.json()


class _RunClient:
    def __init__(self, services):
        self.services = services

    def list_services(self):
        return deepcopy(self.services)


def _listed_project(row):
    identity = _project_identity(row)
    return {
        key: identity[key]
        for key in ("projectId", "projectNumber", "parent", "labels", "lifecycleState")
    }


def _ready_runtime(
    monkeypatch,
    *,
    rows=None,
    discovery=None,
    project_overrides=None,
    auxiliary=None,
):
    from hushh_mcp.services.account_generation_service import AccountGenerationService

    rows = rows or [_pilot_row(hushh_id) for hushh_id in PLACEMENTS]
    monkeypatch.setattr(
        AccountGenerationService,
        "firebase_identity_for_owner",
        staticmethod(lambda owner: "firebase-identity-" + owner),
    )
    row_by_project = {row["backend_metadata"]["project"]: row for row in rows}
    identities = {project: _project_identity(row) for project, row in row_by_project.items()}
    identities.update(project_overrides or {})
    services = {project: [_service(row)] for project, row in row_by_project.items()}
    listed = discovery or [_listed_project(row) for row in rows]
    return HostedProviderAccountRuntime(
        credentials=SimpleNamespace(valid=True),
        operator_credentials=SimpleNamespace(valid=True),
        session=object(),
        registry=_FakeRegistry(rows, auxiliary=auxiliary),
        project_reader_factory=lambda project, number: _ProjectReader(identities[project]),
        run_client_factory=lambda project, region: _RunClient(services.get(project, [])),
        project_discovery=lambda: deepcopy(listed),
    )


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
async def test_non_reviewed_hosted_claim_requires_exact_native_service_identity(monkeypatch):
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
    project_number = "667788990011"
    metadata = retained["backend_metadata"]
    attempt = metadata["provisionAttempt"]
    expected_service = {
        "metadata": {
            "name": metadata["service"],
            "namespace": project_number,
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
                    "containers": [
                        {
                            "image": attempt["evidence"]["host_requested"][
                                "creationAcknowledgement"
                            ]["initialImage"]
                        }
                    ],
                }
            }
        },
    }
    services_by_project = {row["backend_metadata"]["project"]: [_service(row)] for row in rows}
    services_by_project[project_id] = [expected_service]
    identities_by_project = {
        row["backend_metadata"]["project"]: _project_identity(row) for row in [*rows, retained]
    }
    runtime.project_reader_factory = lambda project, number: _ProjectReader(
        identities_by_project[project]
    )
    runtime.run_client_factory = lambda project, region: _RunClient(
        services_by_project.get(project, [])
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

    from scripts.ops.hosted_provider_account_ops import require_reviewed_placement

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


def test_personal_deprovision_tombstone_requires_exact_current_erasure_pair():
    from copy import deepcopy

    hushh_id = next(iter(PLACEMENTS))
    row = _pilot_row(hushh_id)
    erasure_attempt = "5c177d95-4a4f-4cda-b168-69468fd7e6f0"
    snapshot = deepcopy(row)
    row["status"] = "suspended"
    row["backend_metadata"] = {
        **snapshot["backend_metadata"],
        "erasure": {
            "ownerId": row["user_id"],
            "attemptId": erasure_attempt,
            "registrySnapshot": snapshot,
        },
    }
    tombstone = {
        "hushh_id": hushh_id,
        "status": "deprovision_requested",
        "external_agent_id": snapshot["external_agent_id"],
    }
    auxiliary = {"personalTombstones": [tombstone]}

    assert _current_erasure_tombstone_pair(row, auxiliary, PLACEMENTS[hushh_id])
    foreign = {**tombstone, "external_agent_id": "foreign-service"}
    assert not _current_erasure_tombstone_pair(
        row, {"personalTombstones": [foreign]}, PLACEMENTS[hushh_id]
    )


def _runtime_snapshot_for_action(hushh_id, *, transition_phase="none", status="provisioned"):
    snapshot = _snapshot(hushh_id=hushh_id)
    placement = snapshot.placements[hushh_id]
    placement.update(
        {
            "nativeProjectState": "active",
            "nativeServiceState": "verified",
            "transitionPhase": transition_phase,
            "lifecycleState": status,
            "tombstoneState": {"state": "none"},
        }
    )
    return replace(
        snapshot,
        records={
            hushh_id: {
                "registryRow": {"user_id": "synthetic-owner", "status": status},
                "ownerId": "synthetic-owner",
            }
        },
    )


class _FakeTransition:
    def __init__(self):
        self.calls = []

    async def start(self, *, owner_id):
        self.calls.append(("start", owner_id))
        return {"phase": "unknown", "generation": 2}

    async def resume(self, *, owner_id):
        self.calls.append(("resume", owner_id))
        return {"phase": "unknown", "generation": 3}


@pytest.mark.asyncio
async def test_billing_dispatch_refuses_if_named_operator_identity_is_unavailable():
    hushh_id = next(iter(PLACEMENTS))
    snapshot = _runtime_snapshot_for_action(hushh_id)
    transition = _FakeTransition()
    runtime = HostedProviderAccountRuntime(
        credentials=object(),
        operator_credentials=None,
        session=object(),
        registry=object(),
        operator_verifier=lambda **_: (_ for _ in ()).throw(RuntimeError("not named")),
        transition_factory=lambda: transition,
    )

    async def inventory():
        return snapshot

    runtime.inventory = inventory
    with pytest.raises(OperatorRefused, match="operator credentials must verify as"):
        await runtime.perform(
            "associate-account", snapshot.placements[hushh_id], reviewed_sha256=snapshot.sha256
        )
    assert transition.calls == []


@pytest.mark.asyncio
async def test_billing_start_and_resume_delegate_only_after_reviewed_actor_gate():
    hushh_id = next(iter(PLACEMENTS))
    snapshot = _runtime_snapshot_for_action(hushh_id)
    transition = _FakeTransition()
    verified = SimpleNamespace(
        principal=EXPECTED_OPERATOR,
        email=EXPECTED_OPERATOR.removeprefix("user:"),
        email_verified=True,
        token=None,
    )
    runtime = HostedProviderAccountRuntime(
        credentials=object(),
        operator_credentials=object(),
        session=object(),
        registry=object(),
        operator_verifier=lambda **_: verified,
        transition_factory=lambda: transition,
    )

    async def inventory():
        return snapshot

    runtime.inventory = inventory
    started = await runtime.perform(
        "associate-account", snapshot.placements[hushh_id], reviewed_sha256=snapshot.sha256
    )
    assert started == {"phase": "unknown", "generation": 2}
    assert transition.calls == [("start", "synthetic-owner")]

    snapshot = _runtime_snapshot_for_action(hushh_id, transition_phase="unknown")

    async def resume_inventory():
        return snapshot

    runtime.inventory = resume_inventory
    resumed = await runtime.perform(
        "resume", snapshot.placements[hushh_id], reviewed_sha256=snapshot.sha256
    )
    assert resumed == {"phase": "unknown", "generation": 3}
    assert transition.calls[-1] == ("resume", "synthetic-owner")


@pytest.mark.parametrize(
    ("service_state", "service_present"),
    [("absent", False), ("ambiguous", True)],
    ids=("lost-ack-service-missing", "lost-ack-service-mismatched"),
)
@pytest.mark.asyncio
async def test_lost_ack_resume_refuses_without_entering_existing_creation_recovery(
    service_state, service_present
):
    from types import SimpleNamespace

    from scripts.ops.hosted_provider_account_ops import _creation_recovery_ready

    hushh_id = next(iter(PLACEMENTS))
    row = _pilot_row(hushh_id)
    row["status"] = "provisioning"
    attempt = row["backend_metadata"]["provisionAttempt"]
    attempt["phase"] = "host_requested"
    attempt["evidence"]["host_requested"].pop("creationAcknowledgement")
    assert _creation_recovery_ready(row)

    snapshot = _runtime_snapshot_for_action(hushh_id, status="provisioning")
    snapshot.placements[hushh_id]["nativeServiceState"] = service_state
    services = []
    if service_present:
        mismatched = _service(row)
        mismatched["metadata"]["uid"] = "different-service-incarnation"
        services.append(mismatched)
    record = snapshot.records[hushh_id]
    record.update(
        registryRow=row,
        authorityRow=row,
        ownerId=row["user_id"],
        services=services,
    )
    snapshot = replace(snapshot, records={hushh_id: record})
    runtime = HostedProviderAccountRuntime(
        credentials=object(),
        session=object(),
        registry=SimpleNamespace(),
    )
    recovery_calls = []

    async def existing_recovery(**kwargs):
        recovery_calls.append(kwargs)

    runtime._resume_existing_creation = existing_recovery

    with pytest.raises(
        OperatorRefused, match="provider transition requires the exact active native service"
    ):
        await runtime.perform(
            "resume",
            snapshot.placements[hushh_id],
            reviewed_sha256=snapshot.sha256,
            inventory_snapshot=snapshot,
        )

    assert recovery_calls == []


@pytest.mark.asyncio
async def test_remove_delegates_to_existing_erasure_reservation(monkeypatch):
    from copy import deepcopy

    from hushh_mcp.services import personal_agent_provisioning_service

    hushh_id = next(iter(PLACEMENTS))
    base = _pilot_row(hushh_id)
    erasure_attempt = "5c177d95-4a4f-4cda-b168-69468fd7e6f0"
    snapshot_row = deepcopy(base)
    erasure = {
        "ownerId": base["user_id"],
        "attemptId": erasure_attempt,
        "phase": "reserved",
        "registrySnapshot": snapshot_row,
    }
    row = deepcopy(base)
    row["status"] = "suspended"
    row["backend_metadata"] = {**base["backend_metadata"], "erasure": erasure}
    inventory = _runtime_snapshot_for_action(hushh_id, status="suspended")
    inventory.records[hushh_id] = {"registryRow": row, "ownerId": base["user_id"]}
    calls = []

    class _Provisioner:
        def __init__(self, *, registry, managed_erasure):
            assert managed_erasure is not None

        async def deprovision(self, *, user_id, expected_erasure_attempt):
            calls.append((user_id, expected_erasure_attempt))
            return {"status": "unprovisioned", "rowDeleteDeferred": True}

    monkeypatch.setattr(
        personal_agent_provisioning_service, "PersonalAgentProvisioningService", _Provisioner
    )
    verified = SimpleNamespace(
        principal=EXPECTED_OPERATOR,
        email=EXPECTED_OPERATOR.removeprefix("user:"),
        email_verified=True,
        token=None,
    )
    runtime = HostedProviderAccountRuntime(
        credentials=object(),
        operator_credentials=object(),
        session=object(),
        registry=object(),
        operator_verifier=lambda **_: verified,
    )

    async def current_inventory():
        return inventory

    runtime.inventory = current_inventory
    result = await runtime.perform(
        "remove", inventory.placements[hushh_id], reviewed_sha256=inventory.sha256
    )

    assert result == {"status": "unprovisioned", "rowDeleteDeferred": True}
    assert calls == [(base["user_id"], erasure_attempt)]


def test_named_gcloud_operator_token_is_captured_in_memory(monkeypatch, tmp_path):
    import subprocess

    executable = tmp_path / "gcloud"
    executable.write_text("placeholder")
    executable.chmod(0o755)
    monkeypatch.setenv("HUSHH_GCLOUD_EXECUTABLE", str(executable))
    calls = []

    def fake_run(args, **kwargs):
        calls.append((args, kwargs))
        return subprocess.CompletedProcess(args, 0, stdout="ya29.fake.operator.token\n", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    credentials = NamedGcloudOperatorCredentials()

    credentials.refresh()

    assert credentials.valid is True
    assert credentials.token == "ya29.fake.operator.token"
    assert calls[0][0] == [
        str(executable.resolve()),
        "auth",
        "print-access-token",
        f"--account={EXPECTED_OPERATOR.removeprefix('user:')}",
    ]
    assert calls[0][1]["shell"] is False
    assert calls[0][1]["capture_output"] is True


PLACEMENTS_PROJECTS = {placement["projectId"] for placement in PLACEMENTS.values()}
