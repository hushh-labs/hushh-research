"""Existing Azure update composition under fresh owner authorization."""

from __future__ import annotations

from api.routes.one import byoc_azure as authority
from hushh_mcp.services import azure_entra_authorizer as entra


async def start_upgrade(
    user_id: str, token: entra.DelegatedToken
) -> authority.AzureAuthorizeCompleteResponse:
    from hushh_mcp.services.azure_setup_job import run_azure_upgrade_job
    from hushh_mcp.services.azure_setup_plan import group_id
    from hushh_mcp.services.compute_backend import resolve_compute_backend
    from hushh_mcp.services.personal_agent_provisioning_service import (
        PersonalAgentProvisioningService,
    )
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    row, target = await authority._upgrade_row(user_id)
    if token.tenant_id != str(row.get("user_cloud_tenant_id") or "").lower():
        raise authority._refuse(
            409, "BAD_TENANT", "Sign in with the directory that holds your agent."
        )
    group = group_id(str(row["user_cloud_subscription_id"]), str(row["user_cloud_resource_group"]))
    from hushh_mcp.services.byoc_setup_job_service import ByocSetupJobRepo
    from hushh_mcp.services.pod_files.azure_recovery import settled_role_operation

    previous_job = await ByocSetupJobRepo().get(user_id)
    continuation = settled_role_operation(row, previous_job)
    from hushh_mcp.services.pod_files.azure_configuration_recovery import (
        settled_configuration_operation,
    )

    configuration_job = (
        {
            key: previous_job[key]
            for key in (
                "user_id",
                "project_id",
                "job_id",
                "status",
                "stage",
                "error_code",
                "created_at",
                "updated_at",
            )
        }
        if continuation and settled_configuration_operation(row, previous_job) == continuation
        else None
    )
    job_id, started = await authority._claim_job(user_id, group)
    if started:
        service = PersonalAgentProvisioningService(
            registry=PersonalAgentRegistryRepo(), backend=resolve_compute_backend()
        )
        authority._spawn(
            run_azure_upgrade_job(
                user_id=user_id,
                job_id=job_id,
                access_token=token.access_token,
                target_image=target,
                upgrade=service.upgrade_pod,
                **({"resume_files_queue_operation": continuation} if continuation else {}),
                **({"resume_files_job": configuration_job} if configuration_job else {}),
            )
        )
    approval = (row.get("backend_metadata") or {}).get("upgradeApproval") or {}
    return authority.AzureAuthorizeCompleteResponse(
        status="upgrade_started",
        jobId=job_id,
        operationId=approval.get("operationId"),
        releaseId=approval.get("releaseId"),
    )
