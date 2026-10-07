"""Resolve where a person's agent runs: Shared, a pod, pending, or not chosen yet.

Shared is never a default (founder direction, 2026-10-06). A person whose registry
and setup record show no placement is ``unplaced`` until they record an explicit
Shared choice (``owner_hosting_choice``) that is newer than their last detach. An
unplaced person gets the tier chooser and never the hub runtime.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from hushh_mcp.services.compute_backend import is_known_pod_target, is_owner_cloud_target

logger = logging.getLogger(__name__)

#: A setup the person began but whose sign-in has not come back yet.
CONSENT_PENDING_STAGE = "consent_pending"

#: How long an untouched begin keeps a person pending. A sign-in that never came
#: back stops counting after this, so an abandoned "Connect" does not hold a Shared
#: owner off the hub, or an unplaced person off the chooser, forever.
INTENT_EXPIRES_AFTER = timedelta(hours=1)


def resolve_hosting_mode(
    *,
    row: dict | None,
    registry_read_ok: bool,
    setup_job: dict | None,
    setup_job_read_ok: bool,
    shared_choice: dict | None = None,
    shared_choice_read_ok: bool = True,
    now: Optional[datetime] = None,
) -> str:
    """Resolve placement from the owner registry, setup job and recorded tier choice.

    Missing or inconsistent evidence is never interpreted as permission to create a
    different kind of host, and the absence of a placement is ``unplaced``, never
    ``shared``: Shared needs the person's recorded choice.
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

    if setup_job is not None and abandoned_intent(setup_job, now=now):
        setup_job = None
    if setup_job is not None and not setup_job_superseded_by_detach(row, setup_job):
        stage = str(setup_job.get("stage") or "").strip()
        # A failed job still records a chosen project and offers a retry, and a
        # consent_pending job is a begun choice. Neither is evidence of Shared.
        if stage == "attached":
            return "unknown"
        return "pending"
    if not shared_choice_read_ok:
        return "unknown"
    if shared_choice_is_current(row, shared_choice):
        return "shared"
    return "unplaced"


def _instant(value: Any) -> Optional[datetime]:
    """A timestamp from a row (datetime, ISO text or epoch milliseconds), UTC-aware."""
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        parsed = datetime.fromtimestamp(float(value) / 1000.0, tz=timezone.utc)
    elif isinstance(value, str) and value.strip():
        try:
            parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def abandoned_intent(setup_job: dict, *, now: Optional[datetime] = None) -> bool:
    """True for an untouched begin (``consent_pending``) older than the expiry.

    Only an intent row qualifies: no worker, no project, still at its first stage.
    An intent whose time does not read stays pending (fail closed to pending).
    """
    if str(setup_job.get("stage") or "").strip() != CONSENT_PENDING_STAGE:
        return False
    if str(setup_job.get("status") or "").strip() != "pending":
        return False
    if str(setup_job.get("project_id") or "").strip():
        return False
    touched = _instant(setup_job.get("updated_at") or setup_job.get("created_at"))
    if touched is None:
        return False
    return (now or datetime.now(timezone.utc)) - touched > INTENT_EXPIRES_AFTER


def _whole_second(value: datetime) -> datetime:
    """``detachedAt`` is written at whole seconds; compare both sides at that precision.

    Otherwise a choice or job made earlier in the same second as a detach reads newer.
    A tie then counts as before the detach (fail closed to the chooser).
    """
    return value.replace(microsecond=0)


def _last_detach(row: dict | None) -> Optional[dict]:
    metadata = (row or {}).get("backend_metadata")
    detached = metadata.get("detachedPlacements") if isinstance(metadata, dict) else None
    if not isinstance(detached, list) or not detached or not isinstance(detached[-1], dict):
        return None
    return detached[-1]


def shared_choice_is_current(row: dict | None, choice: dict | None) -> bool:
    """True when a recorded Shared choice exists and is newer than the last detach.

    A detach releases the slot; a Shared choice made before it was a choice about a
    placement the person then left, so it does not carry over. A detach whose time
    cannot be read supersedes every choice (fail closed to the chooser).
    """
    if not isinstance(choice, dict) or str(choice.get("tier") or "") != "shared":
        return False
    chosen_at = _instant(choice.get("chosen_at"))
    if chosen_at is None:
        return False
    detach = _last_detach(row)
    if detach is None:
        return True
    detached_at = _instant(detach.get("detachedAt"))
    return detached_at is not None and _whole_second(chosen_at) > _whole_second(detached_at)


def setup_job_superseded_by_detach(row: dict | None, setup_job: dict) -> bool:
    """A setup job for a placement the owner has since detached is history.

    Detaching (``personal_agent_placement_detach``) releases the slot and records the
    old placement under ``detachedPlacements``. A job created before that detach is
    not a current choice any more; reading it as one leaves the person with no home
    and no way to pick a new one. A job without readable times falls back to the
    project match for an attached job.
    """
    detach = _last_detach(row)
    if detach is None:
        return False
    created_at = _instant(setup_job.get("created_at"))
    detached_at = _instant(detach.get("detachedAt"))
    if created_at is not None and detached_at is not None:
        return _whole_second(created_at) <= _whole_second(detached_at)
    if str(setup_job.get("stage") or "").strip() != "attached":
        return False
    project = str(setup_job.get("project_id") or "").strip()
    return bool(project) and project == str(detach.get("user_cloud_project") or "").strip()


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


async def _read_shared_choice(user_id: str) -> tuple[Optional[dict], bool]:
    from hushh_mcp.services.owner_hosting_choice import HostingChoiceRepo

    try:
        return await HostingChoiceRepo().get(user_id), True
    except Exception:
        logger.warning("personal_agent.hosting_choice_observation_unavailable")
        return None, False


async def resolve_observed_hosting_mode(
    *, user_id: str, row: dict | None, registry_read_ok: bool
) -> str:
    """Complete a registry observation with setup and recorded-choice evidence."""
    setup_job = None
    setup_job_read_ok = registry_read_ok
    if registry_read_ok and not str((row or {}).get("deployment_target") or "").strip():
        from hushh_mcp.services.byoc_setup_job_service import ByocSetupJobRepo

        try:
            setup_job = await ByocSetupJobRepo().get(user_id)
        except Exception:
            logger.warning("personal_agent.hosting_setup_observation_unavailable")
            setup_job_read_ok = False
    observed = {
        "row": row,
        "registry_read_ok": registry_read_ok,
        "setup_job": setup_job,
        "setup_job_read_ok": setup_job_read_ok,
    }
    mode = resolve_hosting_mode(**observed)
    if mode != "unplaced":
        return mode
    # Only a person with no placement needs the choice read: it can turn unplaced
    # into shared, and nothing else.
    choice, choice_read_ok = await _read_shared_choice(user_id)
    return resolve_hosting_mode(
        **observed, shared_choice=choice, shared_choice_read_ok=choice_read_ok
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


__all__ = [
    "CONSENT_PENDING_STAGE",
    "INTENT_EXPIRES_AFTER",
    "abandoned_intent",
    "get_owner_hosting_mode",
    "resolve_hosting_mode",
    "resolve_observed_hosting_mode",
    "setup_job_superseded_by_detach",
    "shared_choice_is_current",
]
