"""Finish an owner-cloud setup by attaching the agent's home it just recorded.

An Azure setup builds the person's agent in their own subscription under their own
Microsoft sign-in, then records the cloud. Until 2026-10-05 nothing attached it:
the row sat at ``reserved`` until someone pressed Build my agent on another
screen, and the founder's first live run stopped there. Google setup stopped at
``recorded`` the same way until 2026-10-06. Both clouds now end in one place,
``finish_recorded_setup``: the setup was the owner's act, so the hub completes it
the moment the cloud is recorded, the same way phone verification continues into
``provision`` server-side.

Attach only when ready: the reservation must be the proven one-click setup
(``ai_connection_gate.owner_cloud_ready_to_attach``), the model-access rule must
admit the person's own cloud, and the phone must be verified. Anything short of
that is recorded on the setup job as a typed ``attach_blocked`` reason, which the
setup status shows; nothing is created. When the phone is verified later,
``resume_attach_after_phone`` continues from the recorded job.

From there the rest is the pod's own beats: the hub pulls its key, the attach
finishes, and public-by-construction ingress is verified for owner-direct chat
(``pod_external_ingress_admission``). Never raises: a refusal leaves the recorded
cloud as it was.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable, Coroutine
from datetime import datetime, timezone
from typing import Any, Optional

logger = logging.getLogger(__name__)

ATTACH_BLOCKED_STAGE = "attach_blocked"
ATTACH_STARTED_STAGE = "attach_started"

#: Typed reasons an automatic attach stopped. The setup status shows them.
BLOCKED_PHONE = "PHONE_NOT_VERIFIED"
BLOCKED_AGENT_RECORD = "AGENT_RECORD_REQUIRED"
BLOCKED_NOT_READY = "SETUP_NOT_READY"
BLOCKED_MODEL_ACCESS = "MODEL_ACCESS_UNAVAILABLE"
BLOCKED_REGISTRY = "AGENT_RECORD_UNAVAILABLE"
BLOCKED_FAILED = "ATTACH_FAILED"

#: In-flight post-phone resumes, one per person. A strong reference keeps a task
#: alive until it finishes (the event loop holds only a weak one).
_AFTER_PHONE_TASKS: dict[str, asyncio.Task[Any]] = {}

#: Registry statuses meaning an attach already happened; nothing more to do here.
_ALREADY_ATTACHED = ("provisioning", "connecting", "provisioned")

_NOTE = """
UPDATE byoc_setup_jobs
SET stages = coalesce(stages, '[]'::jsonb) || CAST(:entry AS jsonb), updated_at = now()
WHERE user_id = :owner AND (:job = '' OR job_id = :job) AND status IN ('recorded', 'running')
RETURNING job_id
"""


async def _verified_phone(user_id: str, identities: Any) -> str:
    if identities is None:
        from hushh_mcp.services.actor_identity_service import (  # noqa: PLC0415
            ActorIdentityService,
        )

        identities = ActorIdentityService()
    identity = (await identities.get_many([user_id])).get(user_id) or {}
    if identity.get("phone_verified") is not True:
        return ""
    return str(identity.get("phone_number") or "").strip()


def _default_service() -> Any:
    from hushh_mcp.services.compute_backend import resolve_compute_backend  # noqa: PLC0415
    from hushh_mcp.services.personal_agent_provisioning_service import (  # noqa: PLC0415
        PersonalAgentProvisioningService,
    )
    from hushh_mcp.services.personal_agent_registry_repo import (  # noqa: PLC0415
        PersonalAgentRegistryRepo,
    )

    # The same backend resolution as the owner's provision route, so both paths
    # attach through the same adapter (a bare service would be an inert backend).
    return PersonalAgentProvisioningService(
        registry=PersonalAgentRegistryRepo(), backend=resolve_compute_backend()
    )


def _default_registry() -> Any:
    from hushh_mcp.services.personal_agent_registry_repo import (  # noqa: PLC0415
        PersonalAgentRegistryRepo,
    )

    return PersonalAgentRegistryRepo()


def _default_jobs() -> Any:
    from hushh_mcp.services.byoc_setup_job_service import ByocSetupJobRepo  # noqa: PLC0415

    return ByocSetupJobRepo()


async def _attach(user_id: str, identities: Any, service: Any) -> tuple[Optional[str], str]:
    """(new status, "") when attached, else (None, typed reason)."""
    try:
        phone = await _verified_phone(user_id, identities)
        if not phone:
            logger.info("owner_cloud_attach.skipped reason=phone_not_verified")
            return None, BLOCKED_PHONE
        result = await (service or _default_service()).provision(user_id=user_id, phone_e164=phone)
    except Exception as exc:  # noqa: BLE001 - setup stays recorded; the owner can retry
        logger.warning("owner_cloud_attach.failed err=%s", type(exc).__name__)
        return None, BLOCKED_FAILED
    status = str((result or {}).get("status") or "") or None
    logger.info("owner_cloud_attach.attached status=%s", status)
    return status, ""


async def attach_after_setup(
    user_id: str, *, identities: Any = None, service: Any = None
) -> Optional[str]:
    """Attach the person's freshly set-up agent. The new status, or None when not attached."""
    status, _reason = await _attach(user_id, identities, service)
    return status


class _JobAsRecorded:
    """Present the calling job as recorded: an Azure job attaches before it finishes.

    Only the job's own worker passes its job id (in process, never a request field),
    so the job being ``running`` there means it is completing, not in progress.
    """

    def __init__(self, jobs: Any, job_id: str) -> None:
        self._jobs = jobs
        self._job_id = job_id

    async def get(self, user_id: str) -> Optional[dict]:
        job = await self._jobs.get(user_id)
        if job and self._job_id and job.get("job_id") == self._job_id:
            if job.get("status") == "running":
                return {**job, "status": "recorded"}
        return job


async def attach_blocker(
    user_id: str, row: Optional[dict], *, job_id: str = "", registry: Any, setup_jobs: Any
) -> Optional[str]:
    """The typed reason this owner cloud may not be attached yet, or None when ready."""
    from hushh_mcp.services.ai_connection_gate import (  # noqa: PLC0415
        _MANAGED_PROVIDER,
        _pod_can_serve,
        owner_cloud_ready_to_attach,
    )

    if not row:
        return BLOCKED_AGENT_RECORD
    ready, _cloud = await owner_cloud_ready_to_attach(
        user_id, row, registry, _JobAsRecorded(setup_jobs, job_id)
    )
    if not ready:
        return BLOCKED_NOT_READY
    # The person's own cloud runs their own model access (Vertex in their project,
    # Azure OpenAI in their subscription); a target without a declared rule refuses.
    if not _pod_can_serve(
        _MANAGED_PROVIDER, deployment_target=row.get("deployment_target")
    ).can_serve:
        return BLOCKED_MODEL_ACCESS
    return None


async def note_attach(
    user_id: str, *, job_id: str = "", code: str = "", client: Any = None
) -> bool:
    """Append the attach outcome to the setup job: blocked with ``code``, else started."""
    entry: dict[str, str] = {
        "stage": ATTACH_BLOCKED_STAGE if code else ATTACH_STARTED_STAGE,
        "at": datetime.now(timezone.utc).isoformat(),
    }
    if code:
        entry["code"] = code
    try:
        if client is None:
            from db.db_client import get_db  # noqa: PLC0415

            client = get_db()
        response = await asyncio.to_thread(
            client.execute_raw,
            _NOTE,
            {"owner": user_id, "job": job_id, "entry": json.dumps([entry])},
        )
    except Exception as exc:  # noqa: BLE001 - the outcome is also in the logs
        logger.warning("owner_cloud_attach.note_failed err=%s", type(exc).__name__)
        return False
    return bool(response.data)


async def finish_recorded_setup(
    user_id: str,
    *,
    job_id: str = "",
    identities: Any = None,
    service: Any = None,
    registry: Any = None,
    setup_jobs: Any = None,
    note: Any = None,
) -> Optional[str]:
    """Mark the cloud step done, then attach the recorded home when it is ready.

    Used by both clouds' setup jobs (``on_recorded``) and by phone verification. The
    new registry status, or None when nothing was attached (the reason is noted).
    """
    from hushh_mcp.services.owner_hosting_choice import write_cloud_setup_marker  # noqa: PLC0415

    record = note or note_attach
    try:
        await write_cloud_setup_marker(user_id)
        repo = registry or _default_registry()
        try:
            row = await repo.get(user_id)
        except Exception:  # noqa: BLE001 - an unread record attaches nothing
            await record(user_id, job_id=job_id, code=BLOCKED_REGISTRY)
            return None
        if row and str(row.get("status") or "") in _ALREADY_ATTACHED:
            return None
        blocker = await attach_blocker(
            user_id, row, job_id=job_id, registry=repo, setup_jobs=setup_jobs or _default_jobs()
        )
        status, reason = (None, blocker) if blocker else await _attach(user_id, identities, service)
        await record(user_id, job_id=job_id, code=reason)
        logger.info("owner_cloud_attach.finished attached=%s reason=%s", bool(status), reason)
        return status
    except Exception as exc:  # noqa: BLE001 - a recorded setup is never undone here
        logger.warning("owner_cloud_attach.finish_failed err=%s", type(exc).__name__)
        return None


async def resume_attach_after_phone(
    user_id: str,
    phone_e164: str,
    *,
    setup_jobs: Any = None,
    registry: Any = None,
    service: Any = None,
    finish: Any = None,
) -> Optional[str]:
    """Continue a recorded owner-cloud setup once the phone that owns it is verified.

    A Google setup finished before the phone parks its cloud (no agent record can
    exist yet), and an attach that stopped on the phone waits. Nothing happens
    unless a recorded setup job exists; a parked cloud is put on the new record
    first (``register_pending`` attaches it). Never raises.
    """
    from hushh_mcp.services.byoc_setup_job_service import PARKED_STAGE  # noqa: PLC0415
    from hushh_mcp.services.compute_backend import is_owner_cloud_target  # noqa: PLC0415

    if not str(phone_e164 or "").strip():
        return None
    try:
        job = await (setup_jobs or _default_jobs()).get(user_id)
        if not job or job.get("status") != "recorded":
            return None
        repo = registry or _default_registry()
        row = await repo.get(user_id)
        provisioner = service or _default_service()
        if not row and job.get("stage") == PARKED_STAGE:
            await provisioner.register_pending(user_id=user_id, phone_e164=phone_e164)
            row = await repo.get(user_id)
        if not row or row.get("status") != "pending":
            return None
        if not is_owner_cloud_target(row.get("deployment_target")):
            return None
        return await (finish or finish_recorded_setup)(user_id, registry=repo, service=provisioner)
    except Exception as exc:  # noqa: BLE001 - phone verification must complete regardless
        logger.warning("owner_cloud_attach.resume_failed err=%s", type(exc).__name__)
        return None


def run_after_phone(
    user_id: str, work: Callable[..., Coroutine[Any, Any, Any]], *args: Any
) -> bool:
    """Run ``work(user_id, *args)`` in the background, never inside the phone request.

    The resume can reach ``provision``, which for an own cloud is a deploy that
    takes minutes; awaiting it in the phone-verify request would time the request
    out while the attach is half done. One in-flight resume per person: a second
    verification while one runs is a no-op (the work is idempotent). Never raises.
    """
    key = str(user_id or "").strip()
    running = _AFTER_PHONE_TASKS.get(key)
    if not key or (running is not None and not running.done()):
        return False
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return False
    coro = work(key, *args)
    try:
        task = loop.create_task(coro)
    except Exception as exc:  # noqa: BLE001 - scheduling must never break phone verify
        coro.close()
        logger.warning("owner_cloud_attach.resume_unscheduled err=%s", type(exc).__name__)
        return False
    _AFTER_PHONE_TASKS[key] = task

    def _done(finished: asyncio.Task[Any]) -> None:
        if _AFTER_PHONE_TASKS.get(key) is finished:
            _AFTER_PHONE_TASKS.pop(key, None)
        if not finished.cancelled() and finished.exception() is not None:
            exc = finished.exception()
            logger.warning("owner_cloud_attach.resume_task_failed err=%s", type(exc).__name__)

    task.add_done_callback(_done)
    return True


async def _finish_job(user_id: str, job_id: str) -> Optional[str]:
    return await finish_recorded_setup(user_id, job_id=job_id)


async def retry_recorded_attach(user_id: str, *, setup_jobs: Any = None) -> bool:
    """The owner's Retry: run the attach of their recorded setup again, in the background.

    The automatic attach can stop (a blocker, a worker restart that dropped the
    post-phone resume). Only a ``recorded`` job that is still the person's current
    choice is retried; it shares the one-per-person slot with the post-phone resume,
    so a Retry while one runs is a no-op. True when an attach was started. Never raises.
    """
    from hushh_mcp.services.personal_agent_hosting import (  # noqa: PLC0415
        setup_job_is_detached_history,
    )

    try:
        job = await (setup_jobs or _default_jobs()).get(user_id)
        if not job or job.get("status") != "recorded":
            return False
        if await setup_job_is_detached_history(user_id, job):
            return False
    except Exception as exc:  # noqa: BLE001 - an unread job retries nothing
        logger.warning("owner_cloud_attach.retry_unread err=%s", type(exc).__name__)
        return False
    return run_after_phone(user_id, _finish_job, str(job.get("job_id") or ""))


__all__ = [
    "attach_after_setup",
    "attach_blocker",
    "finish_recorded_setup",
    "note_attach",
    "resume_attach_after_phone",
    "retry_recorded_attach",
    "run_after_phone",
]
