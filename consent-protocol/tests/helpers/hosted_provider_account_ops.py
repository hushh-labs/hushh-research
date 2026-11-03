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


def _completed_image_successor(row, *, with_files_plan=False, same_image_files=False):
    """Build one fully qualified image-only successor for operator regressions."""
    import hashlib
    import json
    from copy import deepcopy
    from pathlib import Path

    from hushh_mcp.managed_ai_config import load_profile, profile_hash
    from hushh_mcp.services.personal_agent_upgrade_policy import upgrade_release_id
    from hushh_mcp.services.pod_release import image_digest
    from hushh_mcp.services.private_gcp_deployment import HOSTING_ENV, PrivateGcpDeployment

    successor = deepcopy(row)
    hushh_id = successor["hushh_id"]
    placement = PLACEMENTS[hushh_id]
    metadata = successor["backend_metadata"]
    attempt = metadata["provisionAttempt"]
    admission = attempt["hostedAdmission"]
    assignment = admission["assignment"]
    project, region = placement["projectId"], "us-central1"
    original_image = attempt["evidence"]["host_requested"]["creationAcknowledgement"][
        "initialImage"
    ]
    target_digest = "sha256:" + "d" * 64
    target_image = f"{region}-docker.pkg.dev/{project}/one-pod/consent-protocol-pod@{target_digest}"
    operation_id = "operator-successor-operation"
    executor_lease = "operator-files-executor-lease"
    attempt_id = (
        hashlib.sha256(executor_lease.encode()).hexdigest() if with_files_plan else "e" * 64
    )

    profile = load_profile("dev")
    profile_digest = profile_hash(profile)
    hub_principal = "consent-plane@hushh-pda-dev.iam.gserviceaccount.com"
    bootstrap_account = f"bootstrap-hushh-pod@{project}.iam.gserviceaccount.com"
    admission.update(
        version=1,
        policyId="7b7f221d-e7d5-4a1f-a82d-5d32c17e9410",
        modelBinding={
            "provider": "gemini",
            "project": profile["project"],
            "model": profile["text_model"],
            "profileHash": profile_digest,
        },
    )
    assignment["bootstrapContract"] = {
        "plan": {
            "federation": {
                "impersonation": {
                    "granted_to": hub_principal,
                    "bootstrap_service_account": bootstrap_account,
                }
            }
        }
    }
    creation = attempt["evidence"]["host_requested"]["creationAcknowledgement"]
    creation.update(backend="gcp", project=project, region=region)

    release = json.loads(
        (Path(__file__).parents[1] / "fixtures" / "pod_release.v1.json").read_text()
    )
    release["image"] = target_image
    release["sourceRevision"] = "f" * 40
    prior_update_image = (
        f"{region}-docker.pkg.dev/{project}/one-pod/consent-protocol-pod@sha256:" + "c" * 64
    )
    predecessor_image = target_image if same_image_files else prior_update_image
    supported_predecessor = predecessor_image if with_files_plan else original_image
    release["descriptor"]["supportedUpgradeDigests"] = (
        [] if same_image_files else [image_digest(supported_predecessor)]
    )
    approval = {
        "version": 1,
        "status": "succeeded",
        "operationState": "succeeded",
        "presentationPhase": "verified",
        "providerAcknowledgedAt": "2026-11-02T00:00:00+00:00",
        "operationId": operation_id,
        "idempotencyKey": "operator-successor-idempotency-key",
        "ownerId": successor["user_id"],
        "hushhId": hushh_id,
        "podIncarnation": placement["serviceUid"],
        "targetImage": target_image,
        "releaseMetadata": release,
    }
    approval["releaseId"] = upgrade_release_id(successor, target_image)
    metadata.update(
        image=target_image,
        source_image=target_image,
        image_digest=target_digest,
        installedRelease=release,
        upgradeApproval=approval,
        upgradeAcknowledgement={
            "version": 1,
            "outcome": "ready",
            "operationId": operation_id,
            "releaseId": approval["releaseId"],
            "podIncarnation": placement["serviceUid"],
            "service": metadata["service"],
            "serviceUid": placement["serviceUid"],
            "attemptId": attempt_id,
            "targetImage": target_image,
            "sourceImage": target_image,
            "deployedImage": target_image,
            "image": target_image,
            "targetDigest": target_digest,
            "sourceDigest": target_digest,
            "generation": 2,
        },
    )
    deployment = PrivateGcpDeployment(
        owner=hushh_id,
        hosting_mode="hussh_hosted",
        environment="dev",
        project=project,
        region=region,
        image=target_image,
        hub_principal=hub_principal,
        service_uid=placement["serviceUid"],
        inference_project=profile["project"],
        inference_model=profile["text_model"],
        inference_profile_hash=profile_digest,
        project_number=placement["projectNumber"],
    )
    files_plan = None
    if with_files_plan:
        from hushh_mcp.services.pod_files.capability_update import FilesCapabilityPlan

        plan = FilesCapabilityPlan(
            ownerId=successor["user_id"],
            hushhId=hushh_id,
            serviceUid=placement["serviceUid"],
            serviceGeneration="1",
            service=metadata["service"],
            project=project,
            region=region,
            bootstrapAccount=bootstrap_account,
            runtimeAccount=metadata["runtime_service_account"],
            targetImage=target_image,
            bucket=deployment.bucket,
            kmsKey=deployment.kms_key,
            storagePrefix=f"owners/{hushh_id}/",
            templateDigest="b" * 64,
            modelProject=profile["project"],
        )
        files_plan = plan
        approval["capabilityPlan"] = plan.model_dump()
        approval["capabilityPlanDigest"] = plan.digest
        approval["releaseId"] = upgrade_release_id(
            successor, target_image, capability_digest=plan.digest
        )
        metadata["upgradeAcknowledgement"]["releaseId"] = approval["releaseId"]
        metadata["upgradeAcknowledgement"]["predecessor"] = {
            "version": 1,
            "service": metadata["service"],
            "serviceUid": placement["serviceUid"],
            "generation": 1,
            "resourceVersion": "16",
            "revision": f"{metadata['service']}-00001-old",
            "image": predecessor_image,
        }

    service = _service(successor)
    service["metadata"].update(generation=2, resourceVersion="17")
    template = service["spec"]["template"]
    template["metadata"] = {"annotations": {"hussh/restart-nonce": attempt_id}}
    template_spec = template["spec"]
    template_spec["containers"][0].update(
        image=target_image,
        env=[
            {"name": HOSTING_ENV, "value": deployment.encoded()},
            {"name": "HUSSH_ID", "value": hushh_id},
            {"name": "HUSHH_DEPLOY_ENV", "value": "dev"},
            {"name": "GOOGLE_CLOUD_PROJECT", "value": project},
            {"name": "HUSSH_POD_KMS_KEY", "value": deployment.kms_key},
            {"name": "POD_STORAGE_GCS_BUCKET", "value": deployment.bucket},
            {"name": "HUSSH_POD_USER_ADC_ENABLED", "value": "false"},
            {"name": "HUSSH_POD_WRITER_PROTOCOL", "value": "1"},
            {"name": "HUSSH_POD_WRITER_OPERATION", "value": "successor-fixture"},
        ],
    )
    service["status"] = {
        "observedGeneration": 2,
        "latestCreatedRevisionName": f"{metadata['service']}-00002-abc",
        "latestReadyRevisionName": f"{metadata['service']}-00002-abc",
        "conditions": [{"type": "Ready", "status": "True"}],
    }
    if files_plan is not None:
        from hushh_mcp.services.pod_files.capability_checkpoint import FilesUpgradeCheckpoint

        original_inventory = {
            "tenantRef": f"{project}/{region}",
            "plannedResources": [],
            "resourceIds": [],
            "plannedBindings": [],
            "resourceObservations": [],
            "bindingObservations": [],
        }
        checkpoint = FilesUpgradeCheckpoint(
            plan=files_plan,
            operation_id=operation_id,
            attempt_id=attempt_id,
            original_inventory=original_inventory,
        )
        completed = []
        for call in checkpoint.calls:
            step = call["step"]
            intent, _ = checkpoint.prepare("intent", step, completed)
            checkpoint.acknowledge(intent)
            completed.append({"step": step, "status": 200, "ok": True})
            observed, final_inventory = checkpoint.prepare("observed", step, completed)
            checkpoint.acknowledge(observed)

        predecessor = metadata["upgradeAcknowledgement"]["predecessor"]
        execution_id = "operator-files-execution"
        intent_identity = {
            "executionId": execution_id,
            "lease": executor_lease,
            "operationId": operation_id,
            "attemptId": attempt_id,
            "targetImage": target_image,
            "sourceImage": target_image,
            "sourceDigest": target_digest,
            "deployedImage": target_image,
            "incarnation": placement["serviceUid"],
        }
        revision = service["status"]["latestReadyRevisionName"]
        metadata.update(
            filesUpgradeCheckpoint=observed,
            substrateReceipt=final_inventory,
            filesCapability={"planDigest": files_plan.digest, "status": "enabled"},
            hostedFilesExecutor={
                "version": 1,
                "executionId": execution_id,
                "ownerId": successor["user_id"],
                "hushhId": hushh_id,
                "lease": executor_lease,
                "operationId": operation_id,
                "releaseId": approval["releaseId"],
                "planDigest": files_plan.digest,
                "plan": files_plan.model_dump(),
                "incarnation": placement["serviceUid"],
                "targetImage": target_image,
                "sourceImage": target_image,
                "sourceDigest": target_digest,
                "deployedImage": target_image,
                "phase": "exited",
                "backendPid": 123,
                "backendStart": "2026-11-02T00:00:00+00:00",
                "startedAt": "2026-11-02T00:00:00+00:00",
                "exitedAt": "2026-11-02T00:00:01+00:00",
                "replacementIntent": {**intent_identity, "predecessor": predecessor},
                "providerSettlement": {
                    **intent_identity,
                    "releaseId": approval["releaseId"],
                    "planDigest": files_plan.digest,
                    "targetDigest": target_digest,
                    "image": target_image,
                    "service": files_plan.service,
                    "serviceUid": placement["serviceUid"],
                    "outcome": "ready",
                    "ready": True,
                    "generation": 2,
                    "observedGeneration": 2,
                    "revision": revision,
                    "predecessor": predecessor,
                },
            },
        )
        env = {item["name"]: item["value"] for item in template_spec["containers"][0]["env"]}
        env.update(
            {
                **files_plan.environment,
                "POD_STORAGE_BACKEND": "commit_log",
                "POD_STORAGE_GCS_PREFIX": files_plan.storagePrefix,
            }
        )
        template_spec["containers"][0]["env"] = [
            {"name": name, "value": value} for name, value in sorted(env.items())
        ]
        metadata["upgradeAcknowledgement"]["predecessor"] = predecessor
    return successor, service


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
    row = _pilot_row(hushh_id)
    row["user_id"] = "synthetic-owner"
    attempt = row["backend_metadata"]["provisionAttempt"]
    attempt["ownerId"] = "synthetic-owner"
    attempt["intent"]["user_id"] = "synthetic-owner"
    return replace(
        snapshot,
        records={
            hushh_id: {
                "registryRow": {**row, "status": status},
                "authorityRow": row,
                "ownerId": "synthetic-owner",
                "services": [_service(row)],
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
