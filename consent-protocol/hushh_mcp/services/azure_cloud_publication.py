"""Publish a proven Azure subscription onto the person's registry row.

The sibling of ``byoc_cloud_publication.record_proven_cloud``, with the same
serialization: the setup job row is locked first and must still own setup (same job,
``running``, ``proving``), then the registry row is updated only while it holds no
pod. GCP coordinates are cleared in the same write, so a row never carries two
clouds' coordinates under one target.

It never parks. An Azure agent is created during setup with its HusshID baked into
its environment, so setup requires the registry row before it starts; a row that
vanished mid-job is a refusal, not a parked cloud a GCP reader would misread.
"""

from __future__ import annotations

import asyncio
from typing import Any

from hushh_mcp.services.azure_setup_applier import AzureSetupRefused
from hushh_mcp.services.azure_setup_plan import group_id
from hushh_mcp.services.compute_backend import BACKEND_USER_AZURE

_PUBLISH = """
WITH job AS MATERIALIZED (
    SELECT user_id FROM byoc_setup_jobs
    WHERE user_id = :owner AND job_id = :job AND project_id = :group_ref
      AND status = 'running' AND stage = 'proving'
    FOR UPDATE
), attached AS (
    UPDATE personal_agent_registry r
    SET user_cloud_tenant_id = :tenant,
        user_cloud_subscription_id = :subscription,
        user_cloud_resource_group = :resource_group,
        user_cloud_region = :location,
        user_cloud_project = NULL,
        user_cloud_bootstrap_sa = NULL,
        user_cloud_authorized_at = now(),
        deployment_target = :target,
        model_credential_mode = :model_mode,
        updated_at = now()
    FROM job j
    WHERE r.user_id = j.user_id
      AND r.external_agent_id IS NULL
      AND r.status IN ('pending', 'unprovisioned', 'logical')
    RETURNING r.user_id
)
SELECT count(*) AS attached FROM attached
"""


async def record_proven_azure_cloud(
    repo: Any,
    *,
    user_id: str,
    job_id: str,
    tenant_id: str,
    subscription_id: str,
    resource_group: str,
    location: str,
    model_credential_mode: str,
) -> None:
    """Attach the proven subscription, or refuse; never park, never replace a pod."""
    result = await asyncio.to_thread(
        repo._db().execute_raw,
        _PUBLISH,
        {
            "owner": user_id,
            "job": job_id,
            "group_ref": group_id(subscription_id, resource_group),
            "tenant": tenant_id,
            "subscription": subscription_id,
            "resource_group": resource_group,
            "location": location,
            "target": BACKEND_USER_AZURE,
            "model_mode": model_credential_mode,
        },
    )
    rows = result.data or []
    if len(rows) != 1 or int(rows[0].get("attached") or 0) != 1:
        raise AzureSetupRefused(
            "Your agent was created in your subscription, but your Hussh record changed "
            "while it was being built. Nothing in Azure was removed; start Connect Azure again.",
            code="CLOUD_NOT_RECORDED",
        )


__all__ = ["record_proven_azure_cloud"]
