"""Synthetic original/hosted Azure worker fixtures sharing real SQL admission."""

from __future__ import annotations

import json
from contextlib import asynccontextmanager

import asyncpg

from hushh_mcp.services.azure_setup_plan import group_id
from hushh_mcp.services.byoc_setup_job_service import ByocSetupJobRepo
from tests.test_byoc_setup_job_azure_admission_postgres import (
    GROUP,
    HUSHH_ID,
    OWNER,
    PARKED,
    SUB,
    TENANT,
    _Client,
    _reserved_owner,
)


async def _prepared_worker(pg):
    pg.apply_file(PARKED / "961_azure_setup_erasure_binding.sql")
    _reserved_owner(pg)
    repo = ByocSetupJobRepo(client=_Client(pg))
    assert await repo.start(user_id=OWNER, job_id="job-1", project_id=group_id(SUB, GROUP))
    intent = {
        "version": 1,
        "jobId": "job-1",
        "hushhId": HUSHH_ID,
        "tenantId": TENANT,
        "subscriptionId": SUB,
        "resourceGroup": GROUP,
        "location": "eastus2",
        "setupNonce": "0" * 16,
    }
    assert await repo.retain_azure_setup_intent(user_id=OWNER, job_id="job-1", intent=intent)

    @asynccontextmanager
    async def connection():
        conn = await asyncpg.connect(
            host=str(pg.dir), port=pg.port, user="hushh", database="postgres"
        )
        try:
            yield conn
        finally:
            await conn.close()

    return repo, connection


async def _hosted_worker(pg, *, kind="upgrade", files=False):
    import hashlib

    from hushh_mcp.services.azure_hosted_intent import hosted_intent
    from hushh_mcp.services.azure_setup_plan import PlanInputs, resource_names
    from hushh_mcp.services.compute_backend import PodSpec

    repo, connection = await _prepared_worker(pg)
    pg.execute("UPDATE byoc_setup_jobs SET status='recorded' WHERE user_id=%s", (OWNER,))
    assert await repo.start(user_id=OWNER, job_id="hosted-1", project_id=group_id(SUB, GROUP))
    source = "us-central1-docker.pkg.dev/hushh-pda-dev/one-pod/pod@sha256:" + "d" * 64
    lease = "synthetic-lease"
    metadata = {
        "serviceUid": "incarnation-1",
        "setupNonce": "0" * 16,
        "runtime_principal_id": "6" * 36,
        "runtime_client_id": "7" * 36,
    }
    names = resource_names(PlanInputs(HUSHH_ID, TENANT, SUB, "eastus2", GROUP, "0" * 16))
    metadata["image"] = names.registry + ".azurecr.io/consent-protocol-pod@sha256:" + "b" * 64
    if kind == "upgrade":
        metadata.update(
            upgradeLease=lease,
            upgradeApproval={
                "version": 1,
                "ownerId": OWNER,
                "hushhId": HUSHH_ID,
                "podIncarnation": "incarnation-1",
                "targetImage": source,
                "operationId": "operation-1",
                "releaseId": "release-1",
                "idempotencyKey": "approval-1",
                "status": "updating",
            },
        )
    capability = _files_metadata(metadata, source) if files else None
    pg.execute(
        "UPDATE personal_agent_registry SET status='provisioned',backend='user_azure',"
        "deployment_target='user_azure',external_agent_id=%s,pod_pubkey='public-key',"
        "pod_key_id='key-1',model_credential_mode='user_azure_mi',user_cloud_authorized_at=now(),"
        "user_cloud_tenant_id=%s,user_cloud_subscription_id=%s,user_cloud_resource_group=%s,"
        "user_cloud_region='eastus2',backend_metadata=%s::jsonb WHERE user_id=%s",
        (
            group_id(SUB, GROUP) + "/providers/Microsoft.App/containerApps/ca-hussh-one-pod",
            TENANT,
            SUB,
            GROUP,
            json.dumps(metadata),
            OWNER,
        ),
    )
    row = pg.execute(
        "SELECT to_jsonb(r) FROM personal_agent_registry r WHERE user_id=%s", (OWNER,)
    )[0][0]
    spec = PodSpec(
        hushh_id=HUSHH_ID,
        phone_e164_hash="synthetic",
        pod_pubkey="public-key",
        expected_service_uid="incarnation-1",
        upgrade_operation_id="operation-1",
        upgrade_target_image=source,
        upgrade_attempt_id=hashlib.sha256(lease.encode()).hexdigest(),
        files_upgrade_plan=capability.model_dump() if capability else None,
    )
    intent = hosted_intent(row, job="hosted-1", spec=spec, source=source, kind=kind)
    return connection, intent


def _files_metadata(metadata, source):
    from hushh_mcp.services.azure_setup_plan import PlanInputs, Scopes, resource_names
    from hushh_mcp.services.pod_files.azure_capability import AzureFilesCapabilityPlan

    inputs = PlanInputs(HUSHH_ID, TENANT, SUB, "eastus2", GROUP, "0" * 16)
    names = resource_names(inputs)
    scopes = Scopes(inputs, names)
    plan = AzureFilesCapabilityPlan(
        ownerId=OWNER,
        hushhId=HUSHH_ID,
        serviceUid=metadata["serviceUid"],
        service=scopes.app,
        tenantId=TENANT,
        subscriptionId=SUB,
        resourceGroup=GROUP,
        location="eastus2",
        setupNonce=inputs.nonce,
        createdAt="2026-10-15T00:00:00Z",
        readyRevision="revision-1",
        templateDigest="c" * 64,
        targetImage=source,
        identityId=scopes.identity,
        principalId=metadata["runtime_principal_id"],
        clientId=metadata["runtime_client_id"],
        storageId=scopes.storage,
        blobUrl=f"https://{names.storage_account}.blob.core.windows.net/pod",
        keyUri=f"https://{names.key_vault}.vault.azure.net/keys/pod-log-key/v1",
        modelEndpoint=f"https://{names.openai_account}.openai.azure.com",
        modelDeployment=names.model_deployment,
    )
    metadata["upgradeApproval"].update(
        capabilityPlan=plan.model_dump(), capabilityPlanDigest=plan.digest
    )
    return plan
