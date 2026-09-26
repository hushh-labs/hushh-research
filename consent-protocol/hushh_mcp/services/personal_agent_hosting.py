"""Resolve whether a person's agent runs Shared or on an assigned pod."""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def resolve_hosting_mode(
    *,
    row: dict | None,
    registry_read_ok: bool,
    setup_job: dict | None,
    setup_job_read_ok: bool,
) -> str:
    """Resolve placement from the owner registry and setup-job evidence.

    Shared is the default only after both reads establish that no pod is assigned
    and no setup choice remains in progress. Missing or inconsistent evidence is
    never interpreted as permission to create a different kind of host.
    """
    if not registry_read_ok or not setup_job_read_ok:
        return "unknown"

    deployment_target = str((row or {}).get("deployment_target") or "").strip()
    if deployment_target and deployment_target not in {"user_gcp", "gcp"}:
        return "unknown"

    status = str((row or {}).get("status") or "").strip()
    if status in {"pending", "provisioning", "connecting"}:
        return "pending"

    if deployment_target == "user_gcp":
        return "byoc"
    if deployment_target == "gcp":
        return "hussh_pods"
    if status in {"provisioned", "needs_reinit", "suspended"}:
        return "unknown"
    if row is not None and status not in {"", "unprovisioned", "reaped"}:
        return "unknown"

    if setup_job is not None:
        stage = str(setup_job.get("stage") or "").strip()
        # A failed job still records a chosen project and offers a retry. It is
        # not evidence that the person chose Shared.
        if stage == "attached":
            return "unknown"
        return "pending"
    return "shared"


async def resolve_observed_hosting_mode(
    *, user_id: str, row: dict | None, registry_read_ok: bool
) -> str:
    """Complete a registry observation with pending setup evidence."""
    setup_job = None
    setup_job_read_ok = registry_read_ok
    if registry_read_ok and not str((row or {}).get("deployment_target") or "").strip():
        from hushh_mcp.services.byoc_setup_job_service import ByocSetupJobRepo

        try:
            setup_job = await ByocSetupJobRepo().get(user_id)
        except Exception:
            logger.warning("personal_agent.hosting_setup_observation_unavailable")
            setup_job_read_ok = False
    return resolve_hosting_mode(
        row=row,
        registry_read_ok=registry_read_ok,
        setup_job=setup_job,
        setup_job_read_ok=setup_job_read_ok,
    )


async def get_owner_hosting_mode(user_id: str) -> str:
    """Read placement for an already authenticated owner; unavailable fails closed."""
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    try:
        row = await PersonalAgentRegistryRepo().get(user_id)
    except Exception:
        logger.warning("personal_agent.hosting_registry_observation_unavailable")
        return "unknown"
    return await resolve_observed_hosting_mode(user_id=user_id, row=row, registry_read_ok=True)


__all__ = ["get_owner_hosting_mode", "resolve_hosting_mode", "resolve_observed_hosting_mode"]
