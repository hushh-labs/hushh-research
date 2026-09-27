"""Finite search slices hosted by the existing Drive worker deployment."""

import asyncio
from collections import Counter

from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService
from hushh_mcp.services.drive_work_wake import wake_drive_work


class DriveOwnerSearchWorker:
    def __init__(self, service=None):
        self.service = service or DriveOwnerSearchService()

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
        deadline = asyncio.get_running_loop().time() + deadline_seconds
        for job in await self.service.store.due(limit=max_jobs):
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining < 1:
                counts["deadline"] += 1
                break
            try:
                outcome = await self.service.run_one(
                    user_id=job["user_id"],
                    job_id=str(job["job_id"]),
                    deadline_seconds=min(90, remaining),
                )
                if outcome == "queued":
                    # The slice has released its lease before waking another
                    # drain. The scheduler remains recovery if this hint fails.
                    current = await self.service.store.status(
                        user_id=job["user_id"], job_id=str(job["job_id"])
                    )
                    continuation = continuation or current["errorCode"] is None
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
            except Exception:
                counts["unavailable"] += 1
        if continuation:
            await wake_drive_work("suggestions")
        return {"schema_version": "drive.owner_search.worker.v1", "outcomes": dict(counts)}
