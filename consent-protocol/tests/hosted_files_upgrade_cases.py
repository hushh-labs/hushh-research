"""Focused tests for managed Files admission and executor claims."""

from __future__ import annotations

import copy
from types import SimpleNamespace


def _managed_release_case(monkeypatch):
    import hushh_mcp.services.hosted_gcp_placement as hosted_placement
    from hushh_mcp.services.hosted_gcp_placement import HostedPlacement
    from hushh_mcp.services.pod_files.capability_update import FilesCapabilityPlan
    from tests.test_personal_agent_upgrade_authority import (
        HUSHH_ID,
        NEW_IMAGE,
        OWNER,
        SERVICE,
        SERVICE_UID,
        _approval,
        _row,
    )

    managed_row = _row()
    managed_row.update(deployment_target="gcp", external_agent_id=SERVICE)
    plan = FilesCapabilityPlan(
        ownerId=OWNER,
        hushhId=HUSHH_ID,
        serviceUid=SERVICE_UID,
        serviceGeneration="1",
        service=SERVICE,
        project="owner-project",
        region="us-central1",
        bootstrapAccount="bootstrap@owner-project.iam.gserviceaccount.com",
        runtimeAccount="runtime@owner-project.iam.gserviceaccount.com",
        targetImage=NEW_IMAGE,
        bucket="owner-files-bucket",
        kmsKey="projects/owner-project/locations/us-central1/keyRings/files/cryptoKeys/files",
        storagePrefix="owners/ha1_owner/",
        templateDigest="d" * 64,
        modelProject="hushh-pda-dev",
    )
    approval = _approval(managed_row)
    approval.update(capabilityPlan=plan.model_dump(), capabilityPlanDigest=plan.digest)
    metadata = managed_row["backend_metadata"]
    metadata.update(
        tenancy="hussh-hosted",
        service=SERVICE,
        serviceUid=SERVICE_UID,
        project="owner-project",
        region="us-central1",
        upgradeApproval=approval,
    )
    placement = HostedPlacement(
        owner_id=OWNER,
        hushh_id=HUSHH_ID,
        project="owner-project",
        project_number="1234567890",
        region="us-central1",
        service=SERVICE,
        service_uid=SERVICE_UID,
        runtime_principal="runtime@owner-project.iam.gserviceaccount.com",
        bootstrap_sa="bootstrap@owner-project.iam.gserviceaccount.com",
    )
    monkeypatch.setattr(hosted_placement, "retained_hosted_placement", lambda _row: placement)
    return managed_row, approval


def _assert_managed_release_facts(managed_row, image):
    import pytest

    from hushh_mcp.services.personal_agent_provisioning_service import (
        PersonalAgentUpgradeNotApprovedError,
    )
    from hushh_mcp.services.personal_agent_upgrade_orchestration import _require_installed_release

    unbound = copy.deepcopy(managed_row)
    unbound["backend_metadata"].pop("tenancy")
    with pytest.raises(PersonalAgentUpgradeNotApprovedError, match="compatibility"):
        _require_installed_release(unbound, unbound["backend_metadata"], image, True, None)
    vm_managed = copy.deepcopy(managed_row)
    vm_managed["backend_metadata"]["hostKind"] = "azure_vm"
    with pytest.raises(PersonalAgentUpgradeNotApprovedError, match="compatibility"):
        _require_installed_release(vm_managed, vm_managed["backend_metadata"], image, True, None)


def _assert_legacy_azure_vm_release(image):
    from hushh_mcp.services.personal_agent_upgrade_orchestration import _require_installed_release
    from tests.test_personal_agent_upgrade_authority import _approval, _row

    azure_vm = _row(approval=_approval(_row()))
    azure_vm["deployment_target"] = "user_azure"
    azure_vm["backend_metadata"]["hostKind"] = "azure_vm"
    _require_installed_release(azure_vm, azure_vm["backend_metadata"], image, True, None)


def installed_release_admission_case(monkeypatch):
    from hushh_mcp.services.personal_agent_upgrade_orchestration import _require_installed_release
    from tests.test_personal_agent_upgrade_authority import NEW_IMAGE

    managed_row, _approval = _managed_release_case(monkeypatch)
    _require_installed_release(managed_row, managed_row["backend_metadata"], NEW_IMAGE, True, None)
    _assert_managed_release_facts(managed_row, NEW_IMAGE)
    _assert_legacy_azure_vm_release(NEW_IMAGE)


def _managed_executor_inputs():
    from hushh_mcp.services.compute_backend import PodSpec
    from hushh_mcp.services.hosted_gcp_backend import HostedGcpBackend
    from hushh_mcp.services.pod_files.capability_update import FilesCapabilityPlan
    from hushh_mcp.services.private_gcp_deployment import PrivateGcpDeployment
    from tests.test_personal_agent_upgrade_authority import (
        HUSHH_ID,
        NEW_DIGEST,
        NEW_IMAGE,
        OWNER,
        SERVICE,
        SERVICE_UID,
        _row,
    )

    deployed_image = (
        "us-central1-docker.pkg.dev/hussh-pilot-owner01/one-pod/consent-protocol-pod@" + NEW_DIGEST
    )
    deployment = PrivateGcpDeployment(
        owner=HUSHH_ID,
        hosting_mode="hussh_hosted",
        environment="dev",
        project="hussh-pilot-owner01",
        region="us-central1",
        image=deployed_image,
        hub_principal="consent-plane@hushh-pda-dev.iam.gserviceaccount.com",
        service_uid=SERVICE_UID,
    )
    backend = HostedGcpBackend(deployment=deployment)
    spec = PodSpec(
        hushh_id=HUSHH_ID,
        phone_e164_hash="phone-hash",
        pod_pubkey="public-key",
        deployment_target="gcp",
        region="us-central1",
        expected_service_uid=SERVICE_UID,
        upgrade_operation_id="files-operation-1",
        private_gcp_deployment=deployment,
    )
    plan = FilesCapabilityPlan(
        ownerId=OWNER,
        hushhId=HUSHH_ID,
        serviceUid=SERVICE_UID,
        serviceGeneration="1",
        service=SERVICE,
        project=deployment.project,
        region=deployment.region,
        bootstrapAccount="bootstrap@hussh-pilot-owner01.iam.gserviceaccount.com",
        runtimeAccount="runtime@hussh-pilot-owner01.iam.gserviceaccount.com",
        targetImage=NEW_IMAGE,
        bucket="owner-files-bucket",
        kmsKey="projects/hussh-pilot-owner01/locations/us-central1/keyRings/files/cryptoKeys/files",
        storagePrefix="owners/ha1_owner/",
        templateDigest="d" * 64,
        modelProject="hushh-pda-dev",
    )
    row = _row()
    row["deployment_target"] = "gcp"
    row["backend_metadata"]["tenancy"] = "hussh-hosted"
    return row, backend, spec, plan, deployed_image


class _RecordingExecutorRegistry:
    def __init__(self):
        self.calls = []

    async def claim_image_upgrade(self, **_kwargs):
        raise AssertionError("managed Files must claim its executor session")

    async def begin_hosted_files_executor(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(lease="managed-files-lease")


def _managed_executor_admission(row, backend, spec, plan):
    from hushh_mcp.services.personal_agent_upgrade_orchestration import UpgradeAdmission
    from tests.test_personal_agent_upgrade_authority import HUSHH_ID, NEW_IMAGE, OWNER

    return UpgradeAdmission(
        user_id=OWNER,
        current_image=NEW_IMAGE,
        resume_files_queue_operation=None,
        resume_files_job=None,
        row=row,
        metadata={"tenancy": "hussh-hosted"},
        hushh_id=HUSHH_ID,
        held_lease=None,
        files_capability=plan,
        browser_capability=None,
        spec=spec,
        backend=backend,
    )


async def managed_files_fresh_executor_claim_case():
    from hushh_mcp.services.personal_agent_upgrade_claim import _claim_upgrade_lease
    from tests.test_personal_agent_upgrade_authority import NEW_IMAGE

    row, backend, spec, plan, deployed_image = _managed_executor_inputs()
    registry = _RecordingExecutorRegistry()
    admission = _managed_executor_admission(row, backend, spec, plan)
    lease, executor, binding = await _claim_upgrade_lease(
        SimpleNamespace(_registry=registry), admission, row=row, spec=spec, files_executor=None
    )
    assert lease == "managed-files-lease"
    assert executor.lease == lease and binding is not None
    assert len(registry.calls) == 1
    assert registry.calls[0]["target_image"] == NEW_IMAGE
    assert registry.calls[0]["plan"] == plan.model_dump()
    assert registry.calls[0]["deployed_image"] == deployed_image
    assert registry.calls[0]["deployed_image"] != NEW_IMAGE
