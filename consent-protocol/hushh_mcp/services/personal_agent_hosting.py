"""Resolve whether a person's agent runs Shared or on an assigned pod."""

from __future__ import annotations

import logging

from hushh_mcp.services.compute_backend import is_known_pod_target, is_owner_cloud_target

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
    if deployment_target and not is_known_pod_target(deployment_target):
        return "unknown"

    status = str((row or {}).get("status") or "").strip()
    if status in {"pending", "provisioning", "connecting"}:
        return "pending"

    if is_owner_cloud_target(deployment_target):
        return "byoc"
    if deployment_target == "gcp":
        return "hussh_pods"
    if status in {"provisioned", "needs_reinit", "suspended"}:
        return "unknown"
    if row is not None and status not in {"", "unprovisioned", "reaped"}:
        return "unknown"

    if setup_job is not None and not setup_job_superseded_by_detach(row, setup_job):
        stage = str(setup_job.get("stage") or "").strip()
        # A failed job still records a chosen project and offers a retry. It is
        # not evidence that the person chose Shared.
        if stage == "attached":
            return "unknown"
        return "pending"
    return "shared"


def setup_job_superseded_by_detach(row: dict | None, setup_job: dict) -> bool:
    """An attached setup job for a placement the owner has since detached is history.

    Detaching (``personal_agent_placement_detach``) releases the slot and records the
    old placement under ``detachedPlacements``. The setup job that attached it is not a
    current choice any more; reading it as one leaves the person with no home and no
    way to pick a new one.
    """
    if str(setup_job.get("stage") or "").strip() != "attached":
        return False
    metadata = (row or {}).get("backend_metadata")
    detached = metadata.get("detachedPlacements") if isinstance(metadata, dict) else None
    if not isinstance(detached, list) or not detached or not isinstance(detached[-1], dict):
        return False
    project = str(setup_job.get("project_id") or "").strip()
    return bool(project) and project == str(detached[-1].get("user_cloud_project") or "").strip()


async def setup_job_is_detached_history(user_id: str, setup_job: dict) -> bool:
    """Read the registry and apply ``setup_job_superseded_by_detach`` to a setup job.

    Every surface reads a ``recorded`` job as "your agent lives in this project", so
    returning it after a detach names a home the person no longer has. An unreadable
    registry keeps the job as it is: this only ever hides history, never a live job.
    """
    from hushh_mcp.services import personal_agent_registry_repo as registry

    try:
        row = await registry.PersonalAgentRegistryRepo().get(user_id)
    except Exception:
        logger.warning("setup_job_detach_check.registry_unreadable user=%s", user_id)
        return False
    return setup_job_superseded_by_detach(row, setup_job)


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
