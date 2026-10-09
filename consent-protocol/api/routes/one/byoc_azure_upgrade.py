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

    continuation = settled_role_operation(row, await ByocSetupJobRepo().get(user_id))
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
            )
        )
    return authority.AzureAuthorizeCompleteResponse(status="upgrade_started", jobId=job_id)
