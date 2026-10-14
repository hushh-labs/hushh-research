"""Finite consented preparation drain; no ambient or persisted owner session."""

import asyncio
from collections import Counter

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_suggestion_service import DriveSuggestionService


class DriveSuggestionWorker:
    def __init__(self, service=None, *, packages=None):
        self.service = service or DriveSuggestionService()
        # Keep injected legacy test/services isolated. Production drains run
        # the resumable request-content evaluator alongside selected-file work.
        if packages is None and service is None:
            from hushh_mcp.services.drive_request_package_service import DriveRequestPackageService

            packages = DriveRequestPackageService()
        self.packages = packages

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
        if self.packages is not None:
            # A separate finite task prevents either legacy or package traffic
            # from starving the other; neither branch can extend this deadline.
            async with asyncio.TaskGroup() as group:
                package_run = group.create_task(
                    self.packages.run(max_jobs=max_jobs, deadline_seconds=deadline_seconds)
                )
                legacy_run = group.create_task(
                    DriveSuggestionWorker(self.service).run(
                        max_jobs=max_jobs, deadline_seconds=deadline_seconds
                    )
                )
            counts.update(legacy_run.result()["outcomes"])
            for status, count in package_run.result().items():
                target = {
                    "queued": "package_queued",
                    "ready": "review_ready",
                    "no_match": "no_ready_files",
                    "not_claimed": "not_claimed",
                    "deadline": "deadline",
                }.get(status, "unavailable")
                counts[target] += count
            return {"schema_version": "drive.suggestions.worker.v1", "outcomes": dict(counts)}
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
