"""Real SQL protects an interrupted managed Files operation during erasure."""

import asyncio
import hashlib
import json
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.hosted_cleanup_authority import cleanup_deployment
from hushh_mcp.services.hosted_gcp_backend import HostedGcpBackend
from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
from hushh_mcp.services.pod_files.capability_checkpoint import FilesUpgradeCheckpoint
from hushh_mcp.services.pod_files.capability_update import plan_from_observation
from hushh_mcp.services.pod_files.provisioning import queue_creation_observation
from hushh_mcp.services.pod_update_identity import release_identity


def _files_upgrade_approval(fixture, plan, target):
    return {
        "version": 1,
        "ownerId": fixture.owner,
        "hushhId": plan.hushhId,
        "podIncarnation": plan.serviceUid,
        "targetImage": target,
        "releaseId": release_identity(
            plan.hushhId, plan.serviceUid, target, capability_digest=plan.digest
        ),
        "operationId": "approved-files-operation",
        "idempotencyKey": "synthetic-owner-approval",
        "status": "approved",
        "capabilityPlan": plan.model_dump(),
        "capabilityPlanDigest": plan.digest,
    }


async def _claim_files(fixture, client):
    repo = PersonalAgentRegistryRepo(client)
    row = await repo.get(fixture.owner)
    deployment, _, _ = cleanup_deployment(row)
    spec = PodSpec(
        hushh_id=row["hushh_id"],
        phone_e164_hash="synthetic",
        pod_pubkey="synthetic",
        deployment_target="gcp",
        region=fixture.region,
        expected_service_uid="incarnation",
        provision_attempt_id=fixture.provision["attemptId"],
    )
    backend = HostedGcpBackend(deployment=deployment)
    service = backend.render_deploy_config(spec)
    service["metadata"].update(uid="incarnation", generation=1)
    target = (
        "gcr.io/hushh-pda-dev/consent-protocol-pod@"
        + fixture.provision["hostedAdmission"]["imageDigest"]
    )
    plan = plan_from_observation(row, target, service)
    assert (plan.project, plan.bootstrapAccount) == (fixture.project, fixture.bootstrap["email"])
    approval = _files_upgrade_approval(fixture, plan, target)
    assert await repo.record_upgrade_approval(user_id=fixture.owner, approval=approval)
    row = await repo.get(fixture.owner)
    lease = await repo.claim_image_upgrade(user_id=fixture.owner, target_image=target, observed=row)
    assert lease
    row = await repo.get(fixture.owner)
    assert await repo.hosted_upgrade_current(owner_id=fixture.owner, lease=lease, observed=row)
    return SimpleNamespace(
        repo=repo, row=row, lease=lease, spec=spec, plan=plan, approval=approval, target=target
    )


async def _claim_dedicated_files(fixture, client, *, defect: str | None = None):
    repo = PersonalAgentRegistryRepo(client)
    row = await repo.get(fixture.owner)
    deployment, _, _ = cleanup_deployment(row)
    spec = PodSpec(
        hushh_id=row["hushh_id"],
        phone_e164_hash="synthetic",
        pod_pubkey="synthetic",
        deployment_target="gcp",
        region=fixture.region,
        expected_service_uid="incarnation",
        provision_attempt_id=fixture.provision["attemptId"],
    )
    backend = HostedGcpBackend(deployment=deployment)
    service = backend.render_deploy_config(spec)
    service["metadata"].update(uid="incarnation", generation=1)
    target = (
        "gcr.io/hushh-pda-dev/consent-protocol-pod@"
        + fixture.provision["hostedAdmission"]["imageDigest"]
    )
    deployed_image = backend._user_pod_image_ref(spec, target.rsplit("@", 1)[-1])
    assert deployed_image != target
    plan = plan_from_observation(row, target, service)
    approval = _files_upgrade_approval(fixture, plan, target)
    assert await repo.record_upgrade_approval(user_id=fixture.owner, approval=approval)
    row = await repo.get(fixture.owner)
    if defect == "account_generation":
        row["user_cloud_authorized_at"] = datetime.now(timezone.utc)
    elif defect == "observed_host_tuple":
        row["backend_metadata"] = {**row["backend_metadata"], "serviceUid": "other-incarnation"}
    executor = await repo.begin_hosted_files_executor(
        user_id=fixture.owner,
        observed=row,
        target_image=(
            "gcr.io/hushh-pda-dev/consent-protocol-pod@sha256:" + "e" * 64
            if defect == "target"
            else target
        ),
        operation_id=("wrong-operation" if defect == "operation" else approval["operationId"]),
        plan=plan.model_dump(),
        incarnation=("other-incarnation" if defect == "incarnation" else plan.serviceUid),
        deployed_image=(
            deployed_image.replace(f"/{fixture.project}/", "/other-project/")
            if defect == "deployed_image"
            else deployed_image
        ),
    )
    row = await repo.get(fixture.owner)
    assert row["backend_metadata"]["upgradeLease"] == executor.lease
    return SimpleNamespace(
        repo=repo,
        row=row,
        lease=executor.lease,
        executor=executor,
        spec=spec,
        plan=plan,
        approval=approval,
        target=target,
        deployed_image=deployed_image,
        predecessor={
            "version": 1,
            "service": plan.service,
            "serviceUid": plan.serviceUid,
            "generation": 1,
            "resourceVersion": "synthetic-rv-1",
            "revision": plan.service + "-previous",
            "image": "gcr.io/hushh-pda-dev/consent-protocol-pod@sha256:" + "c" * 64,
            "nonce": None,
        },
    )


def _provider_settlement(state):
    attempt_id = hashlib.sha256(state.lease.encode()).hexdigest()
    return {
        "version": 1,
        "outcome": "ready",
        "ownerId": state.plan.ownerId,
        "hushhId": state.plan.hushhId,
        "executionId": state.executor.execution_id,
        "lease": state.lease,
        "operationId": state.approval["operationId"],
        "releaseId": state.approval["releaseId"],
        "planDigest": state.plan.digest,
        "attemptId": attempt_id,
        "targetImage": state.target,
        "targetDigest": state.target.rsplit("@", 1)[-1],
        "sourceImage": state.target,
        "sourceDigest": state.target.rsplit("@", 1)[-1],
        "deployedImage": state.deployed_image,
        "incarnation": state.plan.serviceUid,
        "service": state.plan.service,
        "serviceUid": state.plan.serviceUid,
        "generation": 2,
        "observedGeneration": 2,
        "revision": state.plan.service + "-settled",
        "image": state.deployed_image,
        "nonce": attempt_id,
        "ready": True,
        "predecessor": state.predecessor,
    }


def _provider_failure_settlement(state):
    receipt = _provider_settlement(state)
    attempt_id = receipt["attemptId"]
    service_resource = (
        f"projects/{state.plan.project}/locations/{state.plan.region}/services/{state.plan.service}"
    )
    predecessor_revision = f"{service_resource}/revisions/{state.predecessor['revision']}"
    return {
        **receipt,
        "outcome": "failed",
        "generation": 2,
        "observedGeneration": state.predecessor["generation"],
        "revision": f"{service_resource}/revisions/{state.plan.service}-failed",
        "revisionUid": "synthetic-failed-revision-uid",
        "revisionGeneration": 2,
        "latestReadyRevision": predecessor_revision,
        "terminalCondition": {
            "type": "Ready",
            "state": "CONDITION_FAILED",
            "reason": "REVISION_FAILED",
        },
        "revisionCondition": {
            "type": "Ready",
            "state": "CONDITION_FAILED",
            "reason": "REVISION_FAILED",
        },
        "reconciling": False,
        "revisionReconciling": False,
        "trafficStatuses": [{"revision": predecessor_revision, "percent": 100}],
        "ready": False,
        "nonce": attempt_id,
    }


def _hosted_files_rollback_sources(pg):
    return pg.execute(
        "SELECT p.oid::regprocedure::text,pg_get_functiondef(p.oid),p.proacl::text "
        "FROM pg_proc p WHERE p.oid=ANY(ARRAY["
        "to_regprocedure('public.guard_project_grant_registry_admission()'),"
        "to_regprocedure('public.guard_personal_agent_erasure_registry()'),"
        "to_regprocedure('public.valid_erasure_substrate_inventory(jsonb,jsonb)'),"
        "to_regprocedure('public.personal_agent_erasure_complete(text)'),"
        "to_regprocedure('public.personal_agent_erasure_archive(jsonb,jsonb)')]) ORDER BY 1"
    )


async def _assert_unqualified_work_refused(fixture, state, monkeypatch):
    from hushh_mcp.services import user_gcp_bootstrap
    from hushh_mcp.services.hosted_upgrade_authority import bind_managed_upgrade
    from hushh_mcp.services.pod_files.capability_bootstrap import apply_upgrade_configuration
    from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired

    spec = replace(
        state.spec,
        upgrade_operation_id=state.approval["operationId"],
        upgrade_target_image=state.target,
        upgrade_attempt_id=hashlib.sha256(state.lease.encode()).hexdigest(),
        files_upgrade_plan=state.plan.model_dump(),
        on_files_upgrade_checkpoint=lambda *_: None,
    )
    bound = await bind_managed_upgrade(spec, state.row, registry=state.repo, lease=state.lease)
    await asyncio.to_thread(bound.hosted_admission_guard)  # Observation remains admitted.
    monkeypatch.setattr(
        user_gcp_bootstrap,
        "mint_bootstrap_token",
        lambda **_: pytest.fail("Unqualified Files work minted a credential"),
    )
    from hushh_mcp.services.hosted_tier_guard import HostedTierNotPermittedError

    with pytest.raises(HostedTierNotPermittedError, match="dedicated retained executor"):
        await HostedGcpBackend(
            deployment=bound.private_gcp_deployment, authority=bound.hosted_admission_guard
        ).upgrade(bound)
    with pytest.raises(ProvisionReconciliationRequired, match="recovery schema"):
        await asyncio.to_thread(
            apply_upgrade_configuration,
            state.plan,
            None,
            bound,
            {},
            {},
            bootstrap_sa=state.plan.bootstrapAccount,
            service_name=state.plan.service,
        )


def _completed_step(step, plan, fixture):
    result = {"step": step, "status": 200, "ok": True}
    if step == "files_worker_account":
        worker = plan.environment["POD_FILES_WORKER_SERVICE_ACCOUNT"]
        result["resourceObservation"] = {
            "type": "service_account",
            "id": worker,
            "disposition": "created",
            "identity": {
                "name": f"projects/{fixture.project}/serviceAccounts/{worker}",
                "email": worker,
                "projectId": fixture.project,
                "uniqueId": "987654321",
            },
        }
    if step in {"iam_files_task_identity", "iam_files_queue_admin"}:
        number = fixture.provision["hostedAdmission"]["assignment"]["projectNumber"]
        member = (
            f"service-{number}@gcp-sa-cloudtasks.iam.gserviceaccount.com"
            if step == "iam_files_task_identity"
            else plan.bootstrapAccount
        )
        role = (
            "roles/cloudtasks.serviceAgent"
            if step == "iam_files_task_identity"
            else "roles/cloudtasks.queueAdmin"
        )
        result["bindingObservations"] = [
            {
                "step": step,
                "policyResource": f"https://cloudresourcemanager.googleapis.com/v1/projects/{fixture.project}:getIamPolicy",
                "role": role,
                "member": "serviceAccount:" + member,
                "disposition": "added",
                "beforeEtag": "before",
                "afterEtag": "after",
            }
        ]
    return result


async def _advance_to_queue(fixture, state):
    checkpoint = FilesUpgradeCheckpoint(
        plan=state.plan,
        operation_id=state.approval["operationId"],
        attempt_id=hashlib.sha256(state.lease.encode()).hexdigest(),
        original_inventory=state.row["backend_metadata"]["substrateReceipt"],
    )
    row, completed = state.row, []
    for call in checkpoint.calls:
        step = call["step"]
        intent, inventory = checkpoint.prepare("intent", step, completed)
        assert await state.repo.record_image_upgrade(
            user_id=fixture.owner,
            observed=row,
            expected_lease=state.lease,
            previous_metadata=row["backend_metadata"],
            retain_lease=True,
            backend_metadata={
                **row["backend_metadata"],
                "filesUpgradeCheckpoint": intent,
                "substrateReceipt": inventory,
            },
        )
        checkpoint.acknowledge(intent)
        row = await state.repo.get(fixture.owner)
        if step == "files_queue":
            return row, intent, completed, call
        completed.append(_completed_step(step, state.plan, fixture))
        observed, inventory = checkpoint.prepare("observed", step, completed)
        assert await state.repo.record_image_upgrade(
            user_id=fixture.owner,
            observed=row,
            expected_lease=state.lease,
            previous_metadata=row["backend_metadata"],
            retain_lease=True,
            backend_metadata={
                **row["backend_metadata"],
                "filesUpgradeCheckpoint": observed,
                "substrateReceipt": inventory,
            },
        )
        checkpoint.acknowledge(observed)
        row = await state.repo.get(fixture.owner)
    pytest.fail("Expected queue intent was not reached")


async def _assert_late_evidence(pg, fixture, state, row, intent, completed, call):
    queue = call["body"]
    resource = {
        "type": "cloud_tasks_queue",
        "id": queue["name"].rsplit("/", 1)[-1],
        "disposition": "created",
        "identity": queue_creation_observation(queue, queue["name"]),
    }
    late = {
        **intent,
        "phase": "observed",
        "completed": [
            *completed,
            {
                "step": "files_queue",
                "status": 200,
                "ok": True,
                "resourceObservation": resource,
            },
        ],
    }
    assert pg.execute(
        "SELECT reserve_personal_agent_erasure(%s,%s)", (fixture.owner, fixture.erase)
    )[0][0]
    frozen = fixture.reservation()["registrySnapshot"]
    assert not await state.repo.hosted_upgrade_current(
        owner_id=fixture.owner, lease=state.lease, observed=row
    )
    assert not await state.repo.record_image_upgrade(
        user_id=fixture.owner,
        observed=row,
        expected_lease=state.lease,
        previous_metadata=row["backend_metadata"],
        backend_metadata=row["backend_metadata"],
        retain_lease=True,
    )
    foreign = deepcopy(late)
    foreign["completed"][-1]["resourceObservation"]["identity"]["name"] += "-foreign"
    retain = state.repo.retain_erasure_files_upgrade_observation
    assert not await retain(user_id=fixture.owner, lease=state.lease, observation=foreign)
    assert not await retain(user_id=fixture.owner, lease="wrong-lease", observation=late)
    assert not await retain(user_id="foreign-owner", lease=state.lease, observation=late)
    assert await retain(
        user_id=fixture.owner, lease=state.lease, observation=late, join_on_cancel=True
    )
    assert await retain(
        user_id=fixture.owner, lease=state.lease, observation=late, join_on_cancel=True
    )
    assert fixture.reservation()["registrySnapshot"] == frozen
    assert not pg.execute(
        "SELECT valid_erasure_memory_binding(%s::jsonb,%s::jsonb)",
        (json.dumps(fixture.reservation()), json.dumps(fixture.memory_binding())),
    )[0][0]
    assert not pg.execute("SELECT personal_agent_erasure_complete(%s)", (fixture.owner,))[0][0]
    effective = pg.execute(
        "SELECT effective_erasure_substrate_inventory(%s::jsonb)",
        (json.dumps(fixture.reservation()),),
    )[0][0]
    worker = state.plan.environment["POD_FILES_WORKER_SERVICE_ACCOUNT"]
    assert resource in effective["resourceObservations"]
    assert any(
        item["type"] == "service_account" and item["id"] == worker
        for item in effective["resourceObservations"]
    )
    assert any(item["step"] == "iam_files_queue_admin" for item in effective["bindingObservations"])


__all__ = [
    "_claim_files",
    "_claim_dedicated_files",
    "_provider_settlement",
    "_provider_failure_settlement",
    "_hosted_files_rollback_sources",
    "_assert_unqualified_work_refused",
    "_completed_step",
    "_advance_to_queue",
    "_assert_late_evidence",
]
