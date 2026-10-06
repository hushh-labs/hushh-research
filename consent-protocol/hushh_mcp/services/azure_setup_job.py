"""Connect Azure and the JIT agent update, as observable background jobs.

Reuses the GCP setup job's record, not its chain: the same ``byoc_setup_jobs`` row,
the same atomic single-job claim (``ByocSetupJobRepo.start``), the same heartbeat,
stage records, ``JobSuperseded`` exit and typed refusals; the stages are the Azure
ones (``AZURE_JOB_STAGES``). ``project_id`` holds the resource group's ARM id, the
Azure equivalent of "which place".

TOKEN CUSTODY: the person's delegated token lives in this task's memory for the job's
lifetime and is never written to the jobs table, logged or persisted.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable, Optional

from hushh_mcp.services.azure_agent_setup import AzureSetupResult, run_agent_setup
from hushh_mcp.services.azure_agent_upgrade import REVISION_FAILED_MESSAGE
from hushh_mcp.services.azure_arm_client import ArmError
from hushh_mcp.services.azure_cloud_publication import record_proven_azure_cloud
from hushh_mcp.services.azure_entra_authorizer import AzureAuthorizeError
from hushh_mcp.services.azure_federation import AzureFederationError
from hushh_mcp.services.azure_setup_applier import AzureSetupRefused
from hushh_mcp.services.byoc_setup_job_service import ByocSetupJobRepo, JobSuperseded
from hushh_mcp.services.compute_backend import PodSpec

logger = logging.getLogger(__name__)

_HEARTBEAT_SECONDS = 15
_TYPED = (AzureSetupRefused, AzureFederationError, AzureAuthorizeError)

#: ARM refusals in the person's words. Azure's own code rides along for support.
_ARM_REFUSALS: dict[str, tuple[str, str]] = {
    "forbidden": (
        "AZURE_PERMISSION_DENIED",
        "Your Microsoft account needs Owner on this subscription to set up your agent.",
    ),
    "unauthorized": ("AZURE_SIGN_IN_EXPIRED", "Your Microsoft sign-in expired; start again."),
    "throttled": ("AZURE_BUSY", "Azure is busy right now. Try again in a few minutes."),
    "conflict": (
        "AZURE_CONFLICT",
        "Something in your subscription is in the way of this setup. Nothing was removed.",
    ),
}
_ARM_DEFAULT = (
    "AZURE_REFUSED",
    "Azure refused a setup step. Everything already created is kept; try again.",
)


def arm_refusal(exc: ArmError) -> tuple[str, str]:
    code, message = _ARM_REFUSALS.get(exc.kind, _ARM_DEFAULT)
    if exc.code == "RequestDisallowedByPolicy":
        code, message = "AZURE_POLICY_REFUSED", "An Azure policy on this subscription refused it."
    return code, f"{message} ({exc.code or exc.kind})"


#: Setup or update stopped on something unnamed. The exception's class name belongs
#: in the log line (``err=``), never in front of a person.
SETUP_UNEXPECTED = (
    "Something unexpected stopped the setup. Everything already created is kept; try again."
)

#: The update stopped on something unnamed. The page's heading already says the update
#: did not finish, so this is only the next step. It claims nothing about which version
#: runs: an unnamed failure after the replacement was submitted has not observed that.
UPDATE_UNEXPECTED = "Something unexpected interrupted it. Try the update again in a moment."

#: A retry that reconciled the previous attempt and found its revision failed.
UPGRADE_FAILED = "UPGRADE_FAILED"


async def _finish_failed(jobs: Any, *, user_id: str, job_id: str, code: str, message: str) -> None:
    try:
        await jobs.finish(
            user_id=user_id, job_id=job_id, status="failed", error_code=code, error_message=message
        )
    except JobSuperseded:
        pass


def _start_heartbeat(jobs: Any, *, user_id: str, job_id: str) -> Optional[asyncio.Task]:
    touch = getattr(jobs, "touch", None)
    if not callable(touch):
        return None

    async def pulse() -> None:
        while True:
            await asyncio.sleep(_HEARTBEAT_SECONDS)
            try:
                if not await touch(user_id=user_id, job_id=job_id):
                    return
            except Exception as exc:  # noqa: BLE001 - a heartbeat failure must not end the job
                logger.warning("azure_setup_job.heartbeat_failed err=%s", type(exc).__name__)

    return asyncio.create_task(pulse())


async def _guarded(
    jobs: Any,
    *,
    user_id: str,
    job_id: str,
    work: Callable[[], Awaitable[None]],
    unexpected: str = SETUP_UNEXPECTED,
) -> None:
    """Run ``work``; every failure becomes a typed record, never a silent death."""
    heartbeat = _start_heartbeat(jobs, user_id=user_id, job_id=job_id)
    try:
        await work()
        await jobs.finish(user_id=user_id, job_id=job_id, status="recorded")
    except JobSuperseded:
        logger.info("azure_setup_job.superseded user=%s job=%s", user_id, job_id)
    except _TYPED as exc:
        await _finish_failed(jobs, user_id=user_id, job_id=job_id, code=exc.code, message=str(exc))
    except ArmError as exc:
        code, message = arm_refusal(exc)
        await _finish_failed(jobs, user_id=user_id, job_id=job_id, code=code, message=message)
    except Exception as exc:  # noqa: BLE001 - the record must never die silently
        logger.exception(
            "azure_setup_job.unexpected user=%s job=%s err=%s",
            user_id,
            job_id,
            type(exc).__name__,
        )
        code = str(getattr(exc, "code", "") or "UNEXPECTED")
        await _finish_failed(jobs, user_id=user_id, job_id=job_id, code=code, message=unexpected)
    finally:
        if heartbeat is not None:
            heartbeat.cancel()


def _stage_writer(jobs: Any, *, user_id: str, job_id: str) -> Callable[[str], None]:
    """A synchronous ``advance`` for the applier's worker thread."""
    loop = asyncio.get_running_loop()

    def advance(stage: str) -> None:
        asyncio.run_coroutine_threadsafe(
            jobs.advance(user_id=user_id, job_id=job_id, stage=stage), loop
        ).result(timeout=30)

    return advance


async def run_azure_setup_job(
    *,
    user_id: str,
    job_id: str,
    access_token: str,
    tenant_id: str,
    subscription_id: str,
    location: str,
    spec: PodSpec,
    source_image: str,
    repo: Optional[ByocSetupJobRepo] = None,
    setup: Callable[..., AzureSetupResult] = run_agent_setup,
    publish: Callable[..., Awaitable[None]] = record_proven_azure_cloud,
    on_recorded: Optional[Callable[[], Awaitable[None]]] = None,
    note_offer: Optional[Callable[..., Awaitable[Any]]] = None,
) -> None:
    """``note_offer`` (``azure_subscription_offer``) records a free trial; best effort."""
    jobs = repo or ByocSetupJobRepo()

    async def work() -> None:
        if note_offer is not None:
            await note_offer(
                jobs,
                user_id=user_id,
                job_id=job_id,
                access_token=access_token,
                subscription_id=subscription_id,
            )
        advance = _stage_writer(jobs, user_id=user_id, job_id=job_id)
        result = await asyncio.to_thread(
            setup,
            access_token=access_token,
            tenant_id=tenant_id,
            subscription_id=subscription_id,
            location=location,
            spec=spec,
            source_image=source_image,
            advance=advance,
        )
        await publish(
            jobs,
            user_id=user_id,
            job_id=job_id,
            tenant_id=result.tenant_id,
            subscription_id=result.subscription_id,
            resource_group=result.resource_group,
            location=result.location,
            model_credential_mode=result.model_credential_mode,
        )
        if on_recorded is not None:
            await on_recorded()
        logger.info(
            "azure_setup_job.recorded user=%s job=%s model=%s",
            user_id,
            job_id,
            result.model_outcome,
        )

    await _guarded(jobs, user_id=user_id, job_id=job_id, work=work)


async def run_azure_upgrade_job(
    *,
    user_id: str,
    job_id: str,
    access_token: str,
    target_image: str,
    upgrade: Callable[..., Awaitable[dict]],
    repo: Optional[ByocSetupJobRepo] = None,
) -> None:
    """The approved update under the person's JIT token, through the orchestrator."""
    from hushh_mcp.services.user_azure_backend import jit_person_authority  # noqa: PLC0415

    jobs = repo or ByocSetupJobRepo()

    async def work() -> None:
        await jobs.advance(user_id=user_id, job_id=job_id, stage="importing_image")
        with jit_person_authority(access_token):
            outcome = await upgrade(user_id=user_id, current_image=target_image)
        _refuse_unfinished(outcome or {})
        await jobs.advance(user_id=user_id, job_id=job_id, stage="proving")

    await _guarded(jobs, user_id=user_id, job_id=job_id, work=work, unexpected=UPDATE_UNEXPECTED)


#: The rebuild stopped on something unnamed; nothing in it can delete custody.
REBUILD_UNEXPECTED = (
    "Something unexpected stopped the rebuild. Your memory and keys are untouched; try again."
)


class _RebuildRecord:
    """The setup-job record with every rebuild failure code under ``REBUILD_``.

    The hosting card reads one record for setup, update and rebuild; the prefix is how
    it shows a rebuild's own sentence and never an update's.
    """

    def __init__(self, jobs: Any) -> None:
        self._jobs = jobs

    def __getattr__(self, name: str) -> Any:
        return getattr(self._jobs, name)

    async def finish(self, *, error_code: Optional[str] = None, **fields: Any) -> None:
        from hushh_mcp.services.azure_hosting_rebuild import REBUILD_CODE_PREFIX  # noqa: PLC0415

        if error_code and not error_code.startswith(REBUILD_CODE_PREFIX):
            error_code = REBUILD_CODE_PREFIX + error_code
        await self._jobs.finish(error_code=error_code, **fields)


async def run_azure_rebuild_job(
    *,
    user_id: str,
    job_id: str,
    access_token: str,
    spec: PodSpec,
    source_image: str,
    publish: Callable[[], Awaitable[None]],
    on_recorded: Optional[Callable[[], Awaitable[Any]]] = None,
    repo: Optional[ByocSetupJobRepo] = None,
    setup: Callable[..., AzureSetupResult] = run_agent_setup,
) -> None:
    """Rebuild after Azure removed the hosting space: setup in adopt mode, then adopt.

    ``setup`` runs with ``adopt=True`` (``azure_hosting_rebuild``): it surveys first,
    keeps the identity, vault and storage, and creates only the environment and agent.
    ``publish`` hands the row to adoption; ``on_recorded`` adopts it.
    """
    jobs = _RebuildRecord(repo or ByocSetupJobRepo())

    async def work() -> None:
        advance = _stage_writer(jobs, user_id=user_id, job_id=job_id)
        await asyncio.to_thread(
            setup,
            access_token=access_token,
            tenant_id=str(spec.user_cloud_tenant_id or ""),
            subscription_id=str(spec.user_cloud_subscription_id or ""),
            location=str(spec.user_cloud_region or ""),
            spec=spec,
            source_image=source_image,
            advance=advance,
            adopt=True,
        )
        await publish()
        if on_recorded is not None:
            await on_recorded()
        logger.info("azure_rebuild_job.recorded user=%s job=%s", user_id, job_id)

    await _guarded(jobs, user_id=user_id, job_id=job_id, work=work, unexpected=REBUILD_UNEXPECTED)


def _refuse_unfinished(outcome: dict) -> None:
    """Raise for an orchestrator outcome that must not read as a finished update.

    A retry while the previous attempt's lease is held reconciles that attempt instead
    of updating; when the platform said its revision failed, the outcome is reconciled
    but not upgraded, which must never read as a finished update.
    """
    skipped = str(outcome.get("skipped") or "")
    if skipped:
        raise AzureSetupRefused(
            "The update did not run this time; try again shortly.",
            code=f"UPGRADE_{skipped.upper()}",
        )
    if outcome.get("reconciled") and not outcome.get("upgraded"):
        raise AzureSetupRefused(REVISION_FAILED_MESSAGE, code=UPGRADE_FAILED)


__all__ = [
    "REBUILD_UNEXPECTED",
    "SETUP_UNEXPECTED",
    "UPDATE_UNEXPECTED",
    "UPGRADE_FAILED",
    "arm_refusal",
    "run_azure_rebuild_job",
    "run_azure_setup_job",
    "run_azure_upgrade_job",
]
