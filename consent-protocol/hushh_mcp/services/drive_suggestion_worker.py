"""Finite consented preparation drain; no ambient or persisted owner session."""

import asyncio
import os
from collections import Counter

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_suggestion_service import DriveSuggestionService
from hushh_mcp.services.owner_placement_guard import admit_hub_content


def _agent_packages_enabled() -> bool:
    return os.getenv("DRIVE_AGENT_PACKAGES_ENABLED", "").strip().lower() == "true"


class DriveSuggestionWorker:
    def __init__(self, service=None, *, packages=None):
        self.service = service or DriveSuggestionService()
        self._create_packages = service is None
        self.packages = packages

    def _package_service(self):
        if self.packages is None and self._create_packages:
            from hushh_mcp.services.drive_request_package_service import DriveRequestPackageService

            self.packages = DriveRequestPackageService()
        return self.packages

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

    async def run(self, *, max_jobs=8, deadline_seconds=540, v1_only=False):
        if (
            type(max_jobs) is not int
            or not 1 <= max_jobs <= 20
            or type(deadline_seconds) is not int
            or not 1 <= deadline_seconds <= 540
            or type(v1_only) is not bool
        ):
            raise ValueError("invalid worker bounds")
        counts = Counter()
        if v1_only:
            # V1 reuses request-scoped content evaluation only. It never runs
            # the legacy selected-file suggestion queue or catalog builders.
            packages = self._package_service()
            result = (
                await packages.run(
                    max_jobs=max_jobs, deadline_seconds=deadline_seconds, v1_only=True
                )
                if packages is not None
                else {"not_claimed": 1}
            )
            for outcome, count in result.items():
                counts[
                    {
                        "queued": "package_queued",
                        "ready": "review_ready",
                        "no_match": "no_ready_files",
                        "not_claimed": "not_claimed",
                        "deadline": "deadline",
                    }.get(outcome, "unavailable")
                ] += count
            return {"schema_version": "drive.suggestions.worker.v1", "outcomes": dict(counts)}
        period_only = (
            not _agent_packages_enabled()
            and os.getenv("DRIVE_PERIOD_PACKETS_ENABLED", "").strip().lower() == "true"
        )
        packages = self._package_service() if _agent_packages_enabled() or period_only else None
        if packages is not None:
            return await self._run_packages(packages, period_only, max_jobs, deadline_seconds)
        try:
            async with asyncio.timeout(deadline_seconds):
                # Durable inspection timestamps rotate even excluded or
                # unclaimable rows. A finite drain cannot starve later work.
                async for request, enabled in self._jobs(max_jobs):
                    if not enabled:
                        counts["disabled"] += 1
                        continue
                    try:
                        await admit_hub_content(request["user_id"], "drive_suggestion_worker")
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

    async def _run_packages(self, packages, period_only, max_jobs, deadline_seconds):
        counts = Counter()
        # A separate finite task prevents either legacy or package traffic
        # from starving the other; neither branch can extend this deadline.
        async with asyncio.TaskGroup() as group:
            package_run = group.create_task(
                packages.run(
                    max_jobs=max_jobs,
                    deadline_seconds=deadline_seconds,
                    **({"provider_only": True} if period_only else {}),
                )
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
