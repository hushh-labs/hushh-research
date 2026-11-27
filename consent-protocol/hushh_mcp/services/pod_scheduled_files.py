"""A scheduled explicit organization request uses the existing Files specialist."""

from __future__ import annotations

from hushh_mcp.services.pod_files.library import FilesRefused, identifier
from hushh_mcp.services.pod_files.runtime import files_access, operation
from hushh_mcp.services.pod_scheduled_tasks import ScheduleRefused


class ScheduledFileOrganization:
    max_active_seconds = 180
    required_scopes = ("pod.act", "files.manage")

    def __init__(self, check, *, sandbox_log=None, sandbox_pod_id: str = ""):
        self.check = check
        self.sandbox_log = sandbox_log
        self.sandbox_pod_id = sandbox_pod_id

    async def prepare(self, parameters: dict, *, check=None) -> dict:
        terms = await self._prepare_file(parameters, check=check or self.check)
        if self.sandbox_log is not None:
            from hushh_mcp.services.pod_scheduled_model import resolve_scheduled_model

            model = await resolve_scheduled_model(
                self.sandbox_log, pod_id=self.sandbox_pod_id, check=check or self.check
            )
            terms["model_binding"] = model.binding.model_dump()
        return terms

    async def _prepare_file(self, parameters: dict, *, check) -> dict:
        from hushh_mcp.one_adk.agent_tree import _load_product_agent_manifest

        fields = set(parameters)
        revisions = {"expected_file_revision", "expected_analysis_revision"}
        if fields not in ({"file_id"}, {"file_id"} | revisions) or any(
            type(parameters[key]) is not int or parameters[key] < 0 for key in fields & revisions
        ):
            raise ScheduleRefused("SCHEDULE_PARAMETERS_REFUSED")
        file_id = identifier(parameters["file_id"])
        manifest = _load_product_agent_manifest("agent_files")
        if manifest.runtime.adk_mode != "task" or "organize_file" not in {
            tool.name for tool in manifest.tools
        }:
            raise ScheduleRefused("SCHEDULE_CAPABILITY_UNAVAILABLE")
        with files_access(check):
            async with operation() as library:
                settings = await library.analysis_allowed(file_id)
                entry = await library.stat(file_id)
                if entry["kind"] != "file" or entry["state"] != "ready":
                    raise ScheduleRefused("SCHEDULE_SOURCE_UNAVAILABLE")
                if revisions <= fields and (
                    parameters["expected_file_revision"] != entry["revision"]
                    or parameters["expected_analysis_revision"] != settings["revision"]
                ):
                    raise ScheduleRefused("SCHEDULE_SOURCE_CHANGED")
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
                current = await self._prepare_file({"file_id": terms["file_id"]}, check=check)
                if current != {
                    key: value for key, value in terms.items() if key != "model_binding"
                }:
                    return "needs_review"
                model = None
                worker_check = check
                if self.sandbox_log is not None:
                    from hushh_mcp.services.pod_ai_selection import ai_selection_revision
                    from hushh_mcp.services.pod_scheduled_checkpoint import ScheduledModelBinding
                    from hushh_mcp.services.pod_scheduled_model import resolve_scheduled_model

                    revision = ai_selection_revision()

                    async def verify_model_current():
                        await check()
                        if ai_selection_revision() != revision:
                            raise FilesRefused("FILES_JOB_MODEL_CHANGED", 403)

                    worker_check = verify_model_current
                    try:
                        binding = ScheduledModelBinding.model_validate(terms.get("model_binding"))
                        resolved = await resolve_scheduled_model(
                            self.sandbox_log,
                            pod_id=self.sandbox_pod_id,
                            check=worker_check,
                            expected=binding,
                        )
                        model = resolved.build()
                    except (ScheduleRefused, ValueError):
                        return "needs_review"
                elif "model_binding" in terms:
                    return "needs_review"
                await worker_check()
                with files_access(worker_check):
                    async with operation(mutation=True) as library:
                        job = await prepare_delivery(
                            library,
                            file_id=terms["file_id"],
                            request_id=occurrence_id,
                            expected_file_revision=terms["file_revision"],
                            expected_analysis_revision=terms["analysis_revision"],
                            **({"brokered_schedule": True} if model is not None else {}),
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
                await worker_check()
                outcome = await run_job(
                    job["id"],
                    job["delivery"],
                    delivery_check=check,
                    **({"model": model, "model_check": worker_check} if model is not None else {}),
                )
                return {
                    "completed": "completed",
                    "failed": "failed",
                    "cancelled": "cancelled",
                    "review_required": "needs_review",
                }.get(outcome["state"], "needs_review")
            except FilesRefused:
                return "needs_review"
