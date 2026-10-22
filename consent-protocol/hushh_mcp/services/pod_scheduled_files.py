"""A scheduled explicit organization request uses the existing Files specialist."""

from __future__ import annotations

from hushh_mcp.services.pod_files.library import FilesRefused, identifier
from hushh_mcp.services.pod_files.runtime import files_access, operation
from hushh_mcp.services.pod_scheduled_tasks import ScheduleRefused


class ScheduledFileOrganization:
    max_active_seconds = 180
    required_scopes = ("pod.act", "files.manage")

    def __init__(self, check):
        self.check = check

    async def prepare(self, parameters: dict, *, check=None) -> dict:
        from hushh_mcp.one_adk.agent_tree import _load_product_agent_manifest

        if set(parameters) != {"file_id"}:
            raise ScheduleRefused("SCHEDULE_PARAMETERS_REFUSED")
        file_id = identifier(parameters["file_id"])
        manifest = _load_product_agent_manifest("agent_files")
        if manifest.runtime.adk_mode != "task" or "organize_file" not in {
            tool.name for tool in manifest.tools
        }:
            raise ScheduleRefused("SCHEDULE_CAPABILITY_UNAVAILABLE")
        with files_access(check or self.check):
            async with operation() as library:
                settings = await library.analysis_allowed(file_id)
                entry = await library.stat(file_id)
                if entry["kind"] != "file" or entry["state"] != "ready":
                    raise ScheduleRefused("SCHEDULE_SOURCE_UNAVAILABLE")
                return {
                    "file_id": file_id,
                    "file_revision": entry["revision"],
                    "analysis_revision": settings["revision"],
                    "agent_version": manifest.version,
                }

    async def run(self, terms: dict, occurrence_id: str, check) -> str:
        from hushh_mcp.services.pod_files.jobs import prepare_delivery, run_job

        with files_access(check):
            try:
                current = await self.prepare({"file_id": terms["file_id"]}, check=check)
                if current != terms:
                    return "needs_review"
                async with operation(mutation=True) as library:
                    job = await prepare_delivery(
                        library,
                        file_id=terms["file_id"],
                        request_id=occurrence_id,
                        expected_file_revision=terms["file_revision"],
                        expected_analysis_revision=terms["analysis_revision"],
                    )
                # A normal Files request may already own this file's job.
                # Never hijack its delivery or invent another execution.
                if (
                    not isinstance(job.get("delivery"), str)
                    or job.get("requestId") != occurrence_id
                    or job.get("revision") != terms["file_revision"]
                    or job.get("consentRevision") != terms["analysis_revision"]
                ):
                    return "needs_review"
                await check()
                outcome = await run_job(job["id"], job["delivery"], delivery_check=check)
                return {
                    "completed": "completed",
                    "failed": "failed",
                    "cancelled": "cancelled",
                    "review_required": "needs_review",
                }.get(outcome["state"], "needs_review")
            except FilesRefused:
                return "needs_review"
