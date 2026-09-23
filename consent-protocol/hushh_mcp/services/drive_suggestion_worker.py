"""Finite consented preparation drain; no ambient or persisted owner session."""

import asyncio
from collections import Counter

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_suggestion_service import DriveSuggestionService


class DriveSuggestionWorker:
    def __init__(self, service=None):
        self.service = service or DriveSuggestionService()

    async def _jobs(self, max_jobs):
        attempted = 0
        inspected = set()
        while attempted < max_jobs and len(inspected) < max_jobs * 5:
            batch = await self.service.store.due_preparations(
                min(max_jobs - attempted, max_jobs * 5 - len(inspected))
            )
            fresh = [row for row in batch if row["request_id"] not in inspected]
            if not fresh:
                return
            for row in fresh:
                inspected.add(row["request_id"])
                enabled = connector_feature_enabled("drive_document_sharing", row["user_id"])
                attempted += int(enabled)
                yield row, enabled

    async def run(self, *, max_jobs=8, deadline_seconds=540):
        if (
            type(max_jobs) is not int
            or not 1 <= max_jobs <= 20
            or type(deadline_seconds) is not int
            or not 1 <= deadline_seconds <= 540
        ):
            raise ValueError("invalid worker bounds")
        counts = Counter()
        try:
            async with asyncio.timeout(deadline_seconds):
                # Durable inspection timestamps rotate even excluded or
                # unclaimable rows. A finite drain cannot starve later work.
                async for request, enabled in self._jobs(max_jobs):
                    if not enabled:
                        counts["disabled"] += 1
                        continue
                    try:
                        status = await self.service.run_one(
                            user_id=request["user_id"], request_id=str(request["request_id"])
                        )
                        counts[
                            status
                            if status
                            in {"not_claimed", "no_ready_files", "review_ready", "unavailable"}
                            else "unavailable"
                        ] += 1
                    except Exception:
                        counts["unavailable"] += 1
        except TimeoutError:
            counts["deadline"] += 1
        return {"schema_version": "drive.suggestions.worker.v1", "outcomes": dict(counts)}
