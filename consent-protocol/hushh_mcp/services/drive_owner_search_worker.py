"""Finite search slices hosted by the existing Drive worker deployment."""

import asyncio
from collections import Counter

from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService
from hushh_mcp.services.drive_trusted_auto_service import DriveTrustedAutoService
from hushh_mcp.services.drive_work_wake import wake_drive_work


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

    async def run(self, *, max_jobs=1, deadline_seconds=90):
        if (
            type(max_jobs) is not int
            or not 1 <= max_jobs <= 20
            or type(deadline_seconds) is not int
            or not 1 <= deadline_seconds <= 205
        ):
            raise ValueError("invalid search worker bounds")
        counts = Counter()
        continuation = False
        woke_early = False
        deadline = asyncio.get_running_loop().time() + deadline_seconds
        if self.trusted_auto and deadline - asyncio.get_running_loop().time() > 20:
            try:
                # A payment/restart wake can arrive with committed results
                # still waiting for approval. Drain them before the next
                # provider page can spend the whole search slice.
                async with asyncio.timeout(20):
                    await self.trusted_auto.continue_batches(max_jobs=min(max_jobs, 2))
            except Exception:
                counts["unavailable"] += 1
        if self.trusted_auto and deadline - asyncio.get_running_loop().time() > 20:
            try:
                started = await self.trusted_auto.start_pending(
                    max_jobs=min(max_jobs, 2), deadline_at=deadline
                )
                counts["queued"] += started["started"]
                counts["unavailable"] += started["deferred"]
            except Exception:
                counts["unavailable"] += 1
        for job in await self.service.store.due(limit=max_jobs):
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining < 1:
                counts["deadline"] += 1
                break
            try:
                authority = (
                    await self.trusted_auto.search_authority_for_job(
                        user_id=job["user_id"], job_id=str(job["job_id"])
                    )
                    if self.trusted_auto
                    else None
                )
                outcome = await self.service.run_one(
                    user_id=job["user_id"],
                    job_id=str(job["job_id"]),
                    deadline_seconds=min(90, remaining),
                    **(
                        {
                            "require_current": authority,
                            "after_page": self.trusted_auto.after_search_page,
                        }
                        if authority is not None
                        else {}
                    ),
                )
                if outcome == "queued":
                    # The slice has released its lease before waking another
                    # drain. The scheduler remains recovery if this hint fails.
                    current = await self.service.store.status(
                        user_id=job["user_id"], job_id=str(job["job_id"])
                    )
                    continuation = continuation or current["errorCode"] is None
                    if self.trusted_auto and current["errorCode"] is None:
                        await wake_drive_work("suggestions")
                        woke_early = True
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
                if self.trusted_auto and deadline - asyncio.get_running_loop().time() > 25:
                    # A completed search must also get a continuation wake
                    # before batches run, since an outer deadline can cancel
                    # this worker between freezing and approving a batch.
                    if outcome == "completed":
                        await wake_drive_work("suggestions")
                        woke_early = True
                    await self.trusted_auto.after_search_slice(
                        user_id=job["user_id"], job_id=str(job["job_id"])
                    )
            except Exception:
                counts["unavailable"] += 1
        if self.trusted_auto and deadline - asyncio.get_running_loop().time() > 25:
            try:
                await self.trusted_auto.continue_batches(max_jobs=min(max_jobs, 2))
            except Exception:
                counts["unavailable"] += 1
        if continuation and not woke_early:
            await wake_drive_work("suggestions")
        return {"schema_version": "drive.owner_search.worker.v1", "outcomes": dict(counts)}
