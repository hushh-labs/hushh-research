"""Synthetic original/hosted Azure worker fixtures sharing real SQL admission."""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager

import asyncpg
import pytest

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
    pg.apply_file(PARKED / "967_azure_vm_power_admission.sql")
    pg.apply_file(PARKED / "968_azure_vm_image_update_admission.sql")
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


async def vm_upgrade_worker(pg, owner, installation, *, receipt=None):
    """The real VM plan over the existing journal; no cloud/provider simulation claim."""
    import hashlib

    from hushh_mcp.services.azure_vm_host_bundle import _SOURCE
    from hushh_mcp.services.azure_vm_upgrade_plan import build_vm_image_update
    from hushh_mcp.services.compute_backend import PodSpec, adoption_expectations
    from hushh_mcp.services.user_cloud_service import spec_coordinates_from_row

    pg.apply_file(PARKED / "968_azure_vm_image_update_admission.sql")
    pg.apply_file(PARKED / "968_azure_vm_image_update_admission.sql")
    repo = ByocSetupJobRepo(client=_Client(pg))
    row = pg.execute(
        "SELECT to_jsonb(r) FROM personal_agent_registry r WHERE user_id=%s", (owner,)
    )[0][0]
    target = installation.resource_id.split("/providers/", 1)[0]
    assert await repo.start(user_id=owner, job_id="vm-upgrade-1", project_id=target)
    source = "us-central1-docker.pkg.dev/hushh-pda-dev/one-pod/pod@sha256:" + "d" * 64
    lease, operation = "synthetic-lease", "vm-update-1"
    metadata = row["backend_metadata"]
    metadata.update(
        image_digest=installation.image_digest,
        vmConfigurationSha256="c" * 64,
        vmUpdateModuleSha256=hashlib.sha256((_SOURCE / "update.py").read_bytes()).hexdigest(),
        upgradeLease=lease,
        upgradeApproval={
            "version": 1,
            "ownerId": owner,
            "hushhId": row["hushh_id"],
            "podIncarnation": installation.generation,
            "targetImage": source,
            "operationId": operation,
            "releaseId": "qualified-dev",
            "idempotencyKey": "approval-1",
            "status": "updating",
            "handoffIncarnation": installation.generation,
            "handoffRuntimeEpoch": "synthetic-before",
            "handoffCommittedCursor": {"seq": 1, "sha": "e" * 64},
            "handoffIdleRecord": {"seq": 2, "sha": "f" * 64},
            "handoffCommittedState": hashlib.sha256(
                f"{operation}|{installation.generation}|1|{'e' * 64}|active=0".encode()
            ).hexdigest(),
        },
    )
    if receipt is not None:
        from hushh_mcp.services.pod_upgrade_handoff import retained_idle_evidence

        metadata["upgradeApproval"].update(
            retained_idle_evidence(receipt, operation_id=operation, require_cursor=True)
        )
    pg.execute(
        "UPDATE personal_agent_registry SET backend_metadata=%s::jsonb WHERE user_id=%s",
        (json.dumps(metadata), owner),
    )
    row["backend_metadata"] = metadata
    spec = PodSpec(
        hushh_id=row["hushh_id"],
        phone_e164_hash="synthetic",
        pod_pubkey=row["pod_pubkey"],
        deployment_target="user_azure",
        **adoption_expectations(metadata),
        **spec_coordinates_from_row(row),
        upgrade_operation_id=operation,
        upgrade_target_image=source,
        upgrade_attempt_id=hashlib.sha256(lease.encode()).hexdigest(),
    )
    plan = build_vm_image_update(
        row, spec, idle_record=metadata["upgradeApproval"]["handoffIdleRecord"]
    )
    return plan, plan.intent(job="vm-upgrade-1"), row, spec


def retain_vm_ack(server, owner, spec, receipt):
    bound = {
        **receipt,
        "targetImage": spec.upgrade_target_image,
        "operationId": spec.upgrade_operation_id,
        "releaseId": "qualified-dev",
    }
    server.execute(
        "UPDATE personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,"
        "'{upgradeAcknowledgement}',%s::jsonb) WHERE user_id=%s",
        (json.dumps(bound), owner),
    )


def wire_vm_owner_update(monkeypatch, connection, repo, pod, transport):
    from hushh_mcp.services import azure_hosted_authority as hosted
    from hushh_mcp.services.azure_arm_client import ArmClient

    original = hosted.azure_setup_authority
    monkeypatch.setattr(
        hosted, "azure_setup_authority", lambda **kw: original(**kw, connection_factory=connection)
    )
    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_registry_repo.PersonalAgentRegistryRepo", lambda: repo
    )
    monkeypatch.setattr(
        "hushh_mcp.services.pod_upgrade_handoff.PodUpgradeHandoffClient", pod.client
    )
    monkeypatch.setattr(
        "hushh_mcp.services.user_azure_vm_backend.ArmClient",
        lambda token, **kw: ArmClient(token, session=transport, **kw),
    )
    monkeypatch.setattr(
        "hushh_mcp.services.azure_vm_image_upgrade.ArmClient",
        lambda token, **kw: ArmClient(token, session=transport, **kw),
    )
    monkeypatch.setattr(
        "hushh_mcp.services.azure_image_source.require_import_access", lambda *a: "public"
    )
    monkeypatch.setattr("hushh_mcp.services.azure_image_source.import_credentials", lambda *a: None)


@pytest.fixture
async def owner_update(
    vm_installation, cleanup_connection, lifecycle, monkeypatch, had_power_cycle
):
    from dataclasses import replace

    from hushh_mcp.services.azure_arm_client import ArmClient
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
    from hushh_mcp.services.user_azure_vm_backend import UserAzureVmBackend
    from tests.fixtures.azure_hosted_worker import vm_upgrade_worker
    from tests.test_azure_vm_upgrade_postgres import _image_transport
    from tests.test_byoc_setup_job_azure_admission_postgres import _Client

    server, owner, installed = vm_installation
    pod, transport, power, _ = lifecycle
    if had_power_cycle:
        assert (await power("deallocate"))["state"] == "sleeping"
        assert (await power("wake"))["state"] == "awake"
    receipt = await asyncio.to_thread(
        pod.client(url=pod.binding["url"], hushh_id=installed.hushh_id).prepare_and_wait,
        operation_id="vm-update-1",
        incarnation=installed.generation,
    )
    plan, intent, row, spec = await vm_upgrade_worker(server, owner, installed, receipt=receipt)
    client = _Client(server)
    repo = PersonalAgentRegistryRepo(client=client)
    try:
        writes = []
        transport.request = _image_transport(
            transport.request, transport, pod, plan, receipt, None, writes, (None, None)
        )
        wire_vm_owner_update(monkeypatch, cleanup_connection, repo, pod, transport)
        spec = replace(
            spec,
            on_upgrade_idle=lambda value: value == receipt or pytest.fail("idle changed"),
            on_upgrade_ack=lambda value: retain_vm_ack(server, owner, spec, value),
        )
        backend = UserAzureVmBackend(
            spec, observer=lambda: ArmClient("synthetic-observer", session=transport)
        )
        yield server, owner, pod, plan, intent, spec, repo, backend, writes
    finally:
        client._engine.dispose()
