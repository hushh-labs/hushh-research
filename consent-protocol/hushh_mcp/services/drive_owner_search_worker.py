"""Finite search slices hosted by the existing Drive worker deployment.

Latency: a slice that ends with work remaining continues at once. While this
drain still has budget, the worker asks the queue for the next due search
(least recently inspected first, so another owner's waiting search always
goes ahead of a repeat); after that it sends one wake through the existing
Scheduler jobs:run path instead of waiting for the next cron tick. A drain
sends at most one wake, only after progress, so chains never fan out, and an
operator's withdrawn jobRunner grant or disabled drain still stops them.
"""

import asyncio
from collections import Counter

from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService
from hushh_mcp.services.drive_telemetry import drive_logger, drive_stage
from hushh_mcp.services.drive_trusted_auto_service import DriveTrustedAutoService
from hushh_mcp.services.drive_work_wake import wake_drive_work
from hushh_mcp.services.owner_placement_guard import admit_hub_content

logger = drive_logger(__name__)

# Slices one drain may run back to back. Each slice stays at most four pages.
MAX_SLICES_PER_RUN = 6
# A slice starts in-run only with this much drain budget left; otherwise the
# chain continues through a wake.
CONTINUE_MIN_SECONDS = 25


class DriveOwnerSearchWorker:
    def __init__(self, service=None, *, trusted_auto=None):
        self.service = service or DriveOwnerSearchService()
        # A supplied fake search service keeps existing focused worker tests
        # isolated unless they explicitly inject an auto-share collaborator.
        self.trusted_auto = (
            trusted_auto
            if trusted_auto is not None
            else (DriveTrustedAutoService() if service is None else None)
        )

    @staticmethod
    def _now() -> float:
        return asyncio.get_running_loop().time()

    async def run(self, *, max_jobs=1, deadline_seconds=90, v1_only=False):
        if (
            type(max_jobs) is not int
            or not 1 <= max_jobs <= 20
            or type(deadline_seconds) is not int
            or not 1 <= deadline_seconds <= 205
            or type(v1_only) is not bool
        ):
            raise ValueError("invalid search worker bounds")
        # V1 plans only creation-marked live requests and never auto-approves
        # their files. The content evaluator prepares an exact owner decision.
        trusted_auto = None if v1_only else self.trusted_auto
        request_preparer = self.trusted_auto
        counts = Counter()
        stage = "v1" if v1_only else "suggestions"
        lane = {"v1_only": True} if v1_only else {}
        deadline = self._now() + deadline_seconds
        if v1_only and request_preparer:
            try:
                async with asyncio.timeout(20):
                    await request_preparer.continue_batches(max_jobs=min(max_jobs, 2), v1_only=True)
            except Exception:
                counts["unavailable"] += 1
        if trusted_auto and deadline - self._now() > 20:
            try:
                # A payment/restart wake can arrive with committed results
                # still waiting for approval. Drain them before the next
                # provider page can spend the whole search slice.
                async with asyncio.timeout(20):
                    with drive_stage(logger, "worker_batches"):
                        await trusted_auto.continue_batches(max_jobs=min(max_jobs, 2))
            except Exception:
                counts["unavailable"] += 1

        async def prepare_pending():
            try:
                with drive_stage(logger, "worker_prepare"):
                    started = await request_preparer.start_pending(
                        max_jobs=min(max_jobs, 2),
                        deadline_at=deadline,
                        **lane,
                    )
                counts["queued"] += started["started"]
                counts["unavailable"] += started["deferred"]
            except Exception:
                counts["unavailable"] += 1

        woke = False
        work_remains = False
        # Planning a different trusted request can take most of a slice. It
        # must not sit ahead of existing owner-approved or trusted searches.
        # Structured concurrency keeps cancellation bounded by the drain and
        # leaves each search's authority check and database lease unchanged.
        async with asyncio.TaskGroup() as tasks:
            preparation = (
                tasks.create_task(prepare_pending())
                if request_preparer and deadline - self._now() > 20
                else None
            )
            with drive_stage(logger, "worker_due"):
                jobs = await self.service.store.due(limit=max_jobs, **lane)
            if not jobs and preparation is not None:
                # New trusted requests can create their first job during planning.
                # With no older work, use the rest of this same drain to continue it.
                await preparation
                with drive_stage(logger, "worker_due"):
                    jobs = await self.service.store.due(limit=max_jobs, **lane)
            pending = list(jobs)
            slices = 0
            while pending:
                job = pending.pop(0)
                remaining = deadline - self._now()
                if remaining < 1:
                    counts["deadline"] += 1
                    break
                slices += 1
                more = False
                try:
                    outcome = await self._run_admitted_job(
                        job, remaining, trusted_auto=trusted_auto
                    )
                    if outcome == "queued":
                        # The slice has released its lease. A retry backoff
                        # (error code set) is never chained early.
                        current = await self.service.store.status(
                            user_id=job["user_id"], job_id=str(job["job_id"])
                        )
                        more = current["errorCode"] is None
                    elif outcome == "completed" and v1_only:
                        await wake_drive_work("v1")
                    counts[
                        outcome
                        if outcome
                        in {
                            "queued",
                            "completed",
                            "limited",
                            "failed",
                            "stopped",
                            "superseded",
                            "not_claimed",
                        }
                        else "unavailable"
                    ] += 1
                    if trusted_auto and deadline - self._now() > 25:
                        # A completed search must also get a continuation wake
                        # before batches run, since an outer deadline can cancel
                        # this worker between freezing and approving a batch.
                        if outcome == "completed":
                            await wake_drive_work("suggestions")
                            woke = True
                        await trusted_auto.after_search_slice(
                            user_id=job["user_id"], job_id=str(job["job_id"])
                        )
                except Exception:
                    counts["unavailable"] += 1
                work_remains = work_remains or more
                if (
                    not pending
                    and more
                    and slices < MAX_SLICES_PER_RUN
                    and deadline - self._now() >= CONTINUE_MIN_SECONDS
                ):
                    # Chain in-run. The queue returns the least recently
                    # inspected due search, so another owner's waiting search
                    # runs before this one repeats: no owner can starve others.
                    with drive_stage(logger, "worker_due"):
                        pending = list(await self.service.store.due(limit=1, **lane))
                    if pending:
                        continue
                if more and not woke:
                    # Chain across drains now, before later batch work can be
                    # cancelled by the outer deadline. One wake per drain.
                    await wake_drive_work(stage)
                    woke = True
        if trusted_auto and deadline - self._now() > 25:
            try:
                await trusted_auto.continue_batches(max_jobs=min(max_jobs, 2))
            except Exception:
                counts["unavailable"] += 1
        if work_remains and not woke:
            await wake_drive_work(stage)
        return {"schema_version": "drive.owner_search.worker.v1", "outcomes": dict(counts)}

    async def _run_admitted_job(self, job, remaining, *, trusted_auto):
        await admit_hub_content(job["user_id"], "drive_search_worker")
        authority = (
            await trusted_auto.search_authority_for_job(
                user_id=job["user_id"], job_id=str(job["job_id"])
            )
            if trusted_auto
            else None
        )
        return await self.service.run_one(
            user_id=job["user_id"],
            job_id=str(job["job_id"]),
            deadline_seconds=min(90, remaining),
            **(
                {
                    "require_current": authority,
                    "after_page": trusted_auto.after_search_page,
                }
                if authority is not None
                else {}
            ),
        )
