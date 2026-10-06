"""The Azure hosting card's truth, and its one action: rebuild what Microsoft removed.

* ``GET  /api/one/runtime/byoc/azure/hosting`` -> ``{state, rebuildable, rebuild}``
* ``POST /api/one/runtime/byoc/azure/rebuild/begin`` -> ``{authorizationUrl}``

The sign-in returns through the shared ``authorize/complete`` route, which hands a
``rebuild`` state to :func:`start_rebuild`. The rebuild is the owner-approved setup
in adopt mode (``azure_hosting_rebuild``): it keeps the person's identity, vault and
storage and creates only the hosting space and the agent. Mounted on the
``byoc_azure`` router, so no app wiring changes.

The hosting read costs one federated token, at most two ARM reads and one job-record
read, and runs only when the owner opens their hosting card or follows a rebuild. Any
uncertainty reads as ``unknown``, which the card shows as nothing at all: it never
invents a problem.

A RUNNING REBUILD IS FOLLOWED THROUGH EVERY STATE. The plan creates the environment,
grants the observer on it, then creates the agent and grants on that. Mid-job the
observer therefore reads ``agent_removed`` (agent not built yet) and
``agent_unreadable`` (agent built, grant not applied), neither of which is
rebuildable. The rebuild's own record is reported in those states too, so the card
keeps following it to a terminal status and shows a refusal from the hand-off.

KNOWN TRADE: the settling window suppresses the card after ANY recorded job for this
group, an update included, so a genuine owner access removal within
``_SETTLING_SECONDS`` of an update stays silent for that window.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from api.middleware import require_firebase_auth
from api.middlewares.rate_limit import RateLimits, limiter

logger = logging.getLogger(__name__)

#: No prefix: mounted on the ``byoc_azure`` router, which carries ``/api/one/runtime``.
router = APIRouter(tags=["One runtime configuration"])

_ADOPTABLE_STATUSES = frozenset({"provisioned", "needs_reinit"})


class AzureRebuildProgress(BaseModel):
    status: Literal["running", "failed"]
    message: Optional[str] = None
    #: False when the owner's own survey just found the agent present: the card shows
    #: the sentence and no button, so the same check is not offered in a loop.
    retryable: bool = True


class AzureHostingResponse(BaseModel):
    state: str
    rebuildable: bool
    rebuild: Optional[AzureRebuildProgress] = None


class AzureRebuildBeginResponse(BaseModel):
    authorizationUrl: str


def _is_azure_agent(row: Optional[dict]) -> bool:
    from hushh_mcp.services.compute_backend import BACKEND_USER_AZURE  # noqa: PLC0415

    return bool(
        row
        and row.get("deployment_target") == BACKEND_USER_AZURE
        and row.get("external_agent_id")
        and row.get("status") in _ADOPTABLE_STATUSES
    )


def _spec(row: dict) -> Any:
    from hushh_mcp.services.compute_backend import (  # noqa: PLC0415
        BACKEND_USER_AZURE,
        PodSpec,
        adoption_expectations,
    )
    from hushh_mcp.services.user_cloud_service import spec_coordinates_from_row  # noqa: PLC0415

    return PodSpec(
        hushh_id=str(row.get("hushh_id") or ""),
        phone_e164_hash=str(row.get("phone_e164_hash") or ""),
        pod_pubkey="",
        billing_space_id=row.get("billing_space_id"),
        deployment_target=BACKEND_USER_AZURE,
        model_credential_mode=str(row.get("model_credential_mode") or "user_azure_mi"),
        **spec_coordinates_from_row(row),
        **adoption_expectations(row.get("backend_metadata")),
    )


async def observed_hosting_state(row: dict) -> str:
    """The standing observer's verdict on this row's hosting space; ``unknown`` on doubt."""
    from hushh_mcp.services.azure_hosting_rebuild import HOSTING_UNKNOWN, hosting_state
    from hushh_mcp.services.compute_backend import resolve_compute_backend_for_spec

    try:
        backend: Any = resolve_compute_backend_for_spec(_spec(row))
        return str(hosting_state(await backend.observe()))
    except Exception as exc:  # noqa: BLE001 - a doubtful read is never a verdict
        logger.info("azure_hosting.observe_unavailable err=%s", type(exc).__name__)
        return str(HOSTING_UNKNOWN)


def _group_ref(row: dict) -> str:
    from hushh_mcp.services.azure_setup_plan import group_id

    ref: str = group_id(
        str(row.get("user_cloud_subscription_id") or ""),
        str(row.get("user_cloud_resource_group") or ""),
    )
    return ref


#: Hussh's observer grants on a freshly built agent take minutes to apply. While a job
#: for this group was recorded this recently, two refused reads are those grants
#: settling, not a removed hosting space, so no rebuild is offered.
_SETTLING_SECONDS = 30 * 60
#: The owner's own sign-in found the agent present; the same check waits this long.
_NOT_NEEDED_QUIET_SECONDS = 24 * 3600
_NOT_NEEDED = "REBUILD_NOT_NEEDED"


def _within(job: dict, seconds: float) -> bool:
    raw = str(job.get("updated_at") or "")
    try:
        at = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return False
    at = at if at.tzinfo else at.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - at).total_seconds() < seconds


async def _group_job(user_id: str, row: dict) -> Optional[dict]:
    """The owner's setup-job record, only when it belongs to this agent's group."""
    from hushh_mcp.services import byoc_setup_job_service as jobs

    try:
        job = await jobs.ByocSetupJobRepo().get(user_id)
    except Exception:  # noqa: BLE001 - progress is optional on this card
        logger.info("azure_hosting.job_unavailable")
        return None
    return job if job and job.get("project_id") == _group_ref(row) else None


def _rebuild_failure(job: Optional[dict]) -> str:
    """The rebuild's own refusal code, or ``""``; never an update's or a setup's."""
    from hushh_mcp.services.azure_hosting_rebuild import REBUILD_CODE_PREFIX

    code = str((job or {}).get("error_code") or "")
    failed = bool(job) and (job or {}).get("status") == "failed"
    return code if failed and code.startswith(REBUILD_CODE_PREFIX) else ""


def _running_rebuild(job: Optional[dict]) -> bool:
    """A live rebuild: running, marked, and still heartbeating.

    A stale row (no advance for ``STALE_AFTER_SECONDS``) is a dead job, for example an
    instance recycled mid-rebuild. Nothing sweeps it, so it is an end state here, the
    same as the update card treats it, and ``begin`` may take it over.
    """
    from hushh_mcp.services import byoc_setup_job_service as jobs
    from hushh_mcp.services.azure_hosting_rebuild import is_rebuild_job

    if not job or job.get("status") != "running":
        return False
    return is_rebuild_job(job) and not jobs.is_stale(job)


def _followed_rebuild(job: Optional[dict]) -> Optional[AzureRebuildProgress]:
    """Outside the rebuildable states: a running rebuild, or its recent refusal.

    Never a button: ``begin`` refuses outside those states, so a refusal here is shown
    as the rebuild's last word only, for the settling window after it was written.
    """
    if _running_rebuild(job):
        return AzureRebuildProgress(status="running")
    code = _rebuild_failure(job)
    if not code or code == _NOT_NEEDED or not _within(job or {}, _SETTLING_SECONDS):
        return None
    return AzureRebuildProgress(
        status="failed", message=(job or {}).get("error_message") or None, retryable=False
    )


def _rebuild_progress(job: Optional[dict], state: str) -> Optional[AzureRebuildProgress]:
    """A running rebuild, or a rebuild's own recorded refusal; never an update's."""
    from hushh_mcp.services.azure_hosting_rebuild import HOSTING_RECLAIMED

    if not job:
        return None
    if _running_rebuild(job):
        return AzureRebuildProgress(status="running")
    code = _rebuild_failure(job)
    if not code:
        return None
    if code == _NOT_NEEDED and state == HOSTING_RECLAIMED:
        return None  # the observer now reads a 404: that older answer no longer holds
    return AzureRebuildProgress(
        status="failed",
        message=job.get("error_message") or None,
        retryable=not (code == _NOT_NEEDED and _within(job, _NOT_NEEDED_QUIET_SECONDS)),
    )


@router.get("/byoc/azure/hosting", response_model=AzureHostingResponse)
@limiter.limit(RateLimits.AGENT_CHAT)
async def azure_hosting(
    request: Request, firebase_uid: str = Depends(require_firebase_auth)
) -> AzureHostingResponse:
    """What the owner's hosting card says about their Azure agent's hosting space."""
    from api.routes.one import byoc_azure as azure
    from hushh_mcp.services.azure_hosting_rebuild import HOSTING_UNCONFIRMED, REBUILDABLE

    row = await azure._registry_row(firebase_uid)
    if row is None or not _is_azure_agent(row):
        return AzureHostingResponse(state="not_azure", rebuildable=False)
    state = await observed_hosting_state(row)
    job = await _group_job(firebase_uid, row)
    if state not in REBUILDABLE:
        return AzureHostingResponse(state=state, rebuildable=False, rebuild=_followed_rebuild(job))
    settling = (
        state == HOSTING_UNCONFIRMED
        and job is not None
        and job.get("status") == "recorded"
        and _within(job, _SETTLING_SECONDS)
    )
    if settling:
        return AzureHostingResponse(state=state, rebuildable=False)
    return AzureHostingResponse(
        state=state, rebuildable=True, rebuild=_rebuild_progress(job, state)
    )


async def _rebuildable_row(user_id: str) -> dict:
    """This owner's Azure agent, only while the observer says its hosting is gone."""
    from api.routes.one import byoc_azure as azure
    from hushh_mcp.services.azure_hosting_rebuild import REBUILDABLE

    row = await azure._registry_row(user_id)
    if row is None or not _is_azure_agent(row):
        raise azure._refuse(
            409, "NO_AZURE_AGENT", "There is no agent in your Azure subscription to rebuild."
        )
    if await observed_hosting_state(row) not in REBUILDABLE:
        raise azure._refuse(
            409,
            "REBUILD_NOT_AVAILABLE",
            "Your agent's hosting space is in place, so there is nothing to rebuild.",
        )
    return row


@router.post("/byoc/azure/rebuild/begin", response_model=AzureRebuildBeginResponse)
@limiter.limit(RateLimits.AGENT_CHAT)
async def begin_azure_rebuild(
    request: Request, firebase_uid: str = Depends(require_firebase_auth)
) -> AzureRebuildBeginResponse:
    """The Microsoft sign-in that authorizes ONE rebuild, in the agent's own directory."""
    from api.routes.one import byoc_azure as azure

    row = await _rebuildable_row(firebase_uid)
    await azure._require_image_access(await azure._source_image())
    url = await azure._authorization_url(
        firebase_uid,
        kind="rebuild",
        subscription_id=str(row.get("user_cloud_subscription_id") or ""),
        tenant_id=str(row.get("user_cloud_tenant_id") or ""),
    )
    return AzureRebuildBeginResponse(authorizationUrl=url)


async def start_rebuild(user_id: str, token: Any) -> Any:
    """``authorize/complete`` for a ``rebuild`` state: claim the job and run it."""
    from api.routes.one import byoc_azure as azure
    from hushh_mcp.services import azure_hosting_rebuild as rebuild
    from hushh_mcp.services import byoc_setup_job_service as jobs
    from hushh_mcp.services.azure_setup_job import run_azure_rebuild_job
    from hushh_mcp.services.compute_backend import resolve_compute_backend
    from hushh_mcp.services.personal_agent_provisioning_service import (
        PersonalAgentProvisioningService,
    )
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    row = await _rebuildable_row(user_id)
    if token.tenant_id != str(row.get("user_cloud_tenant_id") or "").lower():
        raise azure._refuse(409, "BAD_TENANT", "Sign in with the directory that holds your agent.")
    source = await azure._source_image()
    job_id, started = await azure._claim_job(user_id, _group_ref(row))
    repo = jobs.ByocSetupJobRepo()
    if not started and not rebuild.is_rebuild_job(await repo.get(user_id)):
        # The running job for this group is a setup or an update: never follow it as a
        # rebuild. The owner tries again once it has finished.
        raise azure._refuse(409, "SETUP_IN_PROGRESS", "A cloud setup is already running.")
    if started:
        # Written before the job is spawned, so the card's first read after the
        # Microsoft popup already sees a rebuild, not an anonymous running job.
        await repo.advance(user_id=user_id, job_id=job_id, stage=rebuild.REBUILD_STAGE)
        registry = PersonalAgentRegistryRepo()
        service = PersonalAgentProvisioningService(
            registry=registry, backend=resolve_compute_backend()
        )
        expected = {
            key: str(row.get(key) or "")
            for key in (
                "hushh_id",
                "deployment_target",
                "external_agent_id",
                "user_cloud_tenant_id",
                "user_cloud_subscription_id",
                "user_cloud_resource_group",
            )
        }

        async def publish() -> None:
            await rebuild.record_rebuilt_agent(
                user_id=user_id, expected=expected, registry=registry, jobs=repo, job_id=job_id
            )

        async def adopt() -> bool:
            return bool(await rebuild.adopt_rebuilt_agent(user_id, adopt=service.adopt_orphan))

        azure._spawn(
            run_azure_rebuild_job(
                user_id=user_id,
                job_id=job_id,
                access_token=token.access_token,
                spec=_spec(row),
                source_image=source,
                publish=publish,
                on_recorded=adopt,
            )
        )
        logger.info("azure_rebuild_job.accepted user=%s job=%s", user_id, job_id)
    return azure.AzureAuthorizeCompleteResponse(status="setup_started", jobId=job_id)


__all__ = ["router", "start_rebuild"]
