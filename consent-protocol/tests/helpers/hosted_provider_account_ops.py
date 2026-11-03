from __future__ import annotations

from copy import deepcopy
from dataclasses import replace
from types import SimpleNamespace

from hushh_mcp.services.hosted_provider_account_transition import PLACEMENTS
from scripts.ops.hosted_provider_account_identity import (
    EXPECTED_OPERATOR,
    MANIFEST_SCHEMA,
    REVIEWED_FOLDER_ID,
    InventorySnapshot,
    _owner_hash,
    canonical_manifest_sha256,
)
from scripts.ops.hosted_provider_account_ops import HostedProviderAccountRuntime


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
    identity = _pilot_project_identity(hushh_id, placement)
    attempt = _pilot_attempt(hushh_id, owner_id, placement, identity, _service_name(hushh_id))
    project_id = placement["projectId"]
    service = _service_name(hushh_id)
    metadata = {
        "tenancy": "hussh-hosted",
        "project": project_id,
        "region": "us-central1",
        "service": service,
        "serviceUid": placement["serviceUid"],
        "runtime_service_account": placement["runtimePrincipal"],
        "provisionAttempt": attempt,
    }
    return {
        "user_id": owner_id,
        "hushh_id": hushh_id,
        "external_agent_id": service,
        "status": "provisioned",
        "placement_epoch": placement["placementEpoch"],
        "backend": "gcp",
        "deployment_target": "gcp",
        "backend_metadata": metadata,
    }


def _pilot_project_identity(hushh_id, placement):
    return {
        "projectId": placement["projectId"],
        "projectNumber": placement["projectNumber"],
        "lifecycleState": "ACTIVE",
        "parent": {"type": "folder", "id": REVIEWED_FOLDER_ID},
        "labels": {
            "created-by": "hussh-one",
            "tenancy": "hussh-hosted",
            "hussh-provision-attempt": placement["attemptId"],
            "hussh-environment": "dev",
        },
    }


def _pilot_creation_receipts(project_id, identity):
    steps = (
        "create_project",
        "link_billing",
        "authorize_project",
        "inference_vertex",
        "inference_quota",
    )
    receipts = []
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
        receipts.append(receipt)
    return receipts


def _pilot_attempt(hushh_id, owner_id, placement, identity, service):
    project_id = placement["projectId"]
    attempt_id = placement["attemptId"]
    completed = _pilot_creation_receipts(project_id, identity)
    return {
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
                    "service": service,
                    "serviceUid": placement["serviceUid"],
                    "initialImage": (
                        f"us-central1-docker.pkg.dev/{project_id}/one-pod/consent-protocol-pod@"
                        "sha256:639958a5d5a9adf12c5a93839afaa3a8a1a86421896291b746b4e8c257ffc8a1"
                    ),
                }
            },
        },
    }


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
    from scripts.ops.hosted_provider_account_identity import _authority_row

    row = _authority_row(row) or row
    attempt = row["backend_metadata"]["provisionAttempt"]
    return attempt["evidence"]["reserved"]["hostedPreparation"]["completed"][0][
        "resourceObservation"
    ]["identity"]


def _service(row):
    from hushh_mcp.services.hosted_provider_account_transition import IMAGE_DIGEST
    from scripts.ops.hosted_provider_account_identity import _authority_row

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
