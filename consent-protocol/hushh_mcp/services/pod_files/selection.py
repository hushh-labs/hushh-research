"""Owner-selected Files setup, separate from rollout and model-analysis consent."""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any


def selected_for_row(row: dict[str, Any]) -> bool:
    value = (row.get("backend_metadata") or {}).get("filesSetup") or {}
    return bool(
        value.get("version") == 1
        and value.get("enabled") is True
        and value.get("project") == row.get("user_cloud_project")
        and value.get("bootstrapAccount") == row.get("user_cloud_bootstrap_sa")
        and row.get("user_cloud_authorized_at")
    )


async def require_setup_admission(user_id: str) -> None:
    from db.db_client import get_db
    from hushh_mcp.services.byoc_oauth_authorizer import ByocAuthorizeError
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    if os.getenv("HUSSH_POD_FILES_ENABLED", "").lower() not in {"1", "true", "yes", "on"}:
        raise ByocAuthorizeError(
            "Files setup is not available on this release.",
            status_code=409,
            code="FILES_SETUP_UNAVAILABLE",
        )
    # A flag cannot enable resources whose deletion/recovery contract is absent.
    try:
        result = await asyncio.to_thread(
            get_db().execute_raw,
            """SELECT EXISTS (
                SELECT 1 FROM pg_trigger t
                WHERE t.tgrelid=to_regclass('public.personal_agent_registry')
                  AND t.tgname='zz_personal_agent_erasure_registry'
                  AND t.tgenabled IN ('O','A') AND t.tgtype=27
                  AND t.tgnargs=0 AND t.tgqual IS NULL
                  AND t.tgfoid=to_regprocedure('public.guard_personal_agent_erasure_registry()')
                  AND position('valid_erasure_files_append' in pg_get_functiondef(t.tgfoid))>0
                  AND to_regprocedure('public.retain_erasure_files_receipt(text,text,jsonb,text,text,jsonb)') IS NOT NULL
            ) AS ready""",
            {},
        )
        ready = bool(result.data and result.data[0].get("ready") is True)
    except Exception:
        ready = False
    if not ready:
        raise ByocAuthorizeError(
            "Files setup is waiting for the recovery contract on this environment.",
            status_code=503,
            code="FILES_RECOVERY_CONTRACT_UNAVAILABLE",
        )
    row = await PersonalAgentRegistryRepo().get(user_id)
    if row and (
        row.get("external_agent_id")
        or row.get("status") not in {"pending", "unprovisioned", "logical"}
    ):
        raise ByocAuthorizeError(
            "Your existing pod is preserved. Adding Files requires an approved capability update.",
            status_code=409,
            code="POD_ASSIGNMENT_PRESERVED",
        )


async def publish_selection(
    *, user_id: str, job_id: str, project: str, bootstrap_sa: str, db: Any = None
) -> bool:
    """Atomically publish the current setup choice; parked jobs retry on attachment."""
    from db.db_client import get_db
    from hushh_mcp.services.byoc_setup_job_service import JobSuperseded

    client = db if db is not None else get_db()
    selection = {
        "version": 1,
        "enabled": True,
        "project": project,
        "bootstrapAccount": bootstrap_sa,
        "setupJobId": job_id,
    }
    response = await asyncio.to_thread(
        client.execute_raw,
        """
        UPDATE personal_agent_registry AS r
        SET backend_metadata = jsonb_set(coalesce(r.backend_metadata, '{}'::jsonb),
            '{filesSetup}', CAST(:selection AS jsonb), true)
        FROM byoc_setup_jobs AS j
        WHERE r.user_id = :owner AND j.user_id = r.user_id
          AND j.job_id = :job AND j.project_id = :project
          AND j.status IN ('running', 'recorded')
          AND j.stage IN ('proving', 'awaiting_agent_record', 'attached')
          AND j.stages @> CAST(:selected AS jsonb)
          AND r.user_cloud_project = :project
          AND r.user_cloud_bootstrap_sa = :bootstrap
          AND r.user_cloud_authorized_at IS NOT NULL
          AND r.external_agent_id IS NULL
          AND r.status IN ('pending', 'unprovisioned', 'logical')
        RETURNING r.user_id
        """,
        {
            "owner": user_id,
            "job": job_id,
            "project": project,
            "bootstrap": bootstrap_sa,
            "selection": json.dumps(selection),
            "selected": json.dumps([{"stage": "files_selection", "enabled": True, "version": 1}]),
        },
    )
    if response.data:
        return True
    # Absent registry is expected before phone verification, but a refused
    # publication on an existing row must not be presented as successful setup.
    response = await asyncio.to_thread(
        client.execute_raw,
        "SELECT user_id FROM personal_agent_registry WHERE user_id = :owner",
        {"owner": user_id},
    )
    if response.data:
        raise JobSuperseded("Files selection no longer owns this setup")
    return False
