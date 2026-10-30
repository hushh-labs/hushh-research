"""Provider discovery and separate local organizing on the existing packet queue."""

from __future__ import annotations

import asyncio
import json
import os
from collections import Counter
from datetime import UTC, datetime

from fastapi import HTTPException

from hushh_mcp.hushh_adk.turn import SpecialistAdkTurnError
from hushh_mcp.services.drive_financial_packet_query import QUERY_SOURCE
from hushh_mcp.services.drive_owner_allowed import request_planner_processor_supported
from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService
from hushh_mcp.services.drive_period_packet_contract import CATEGORY_PURPOSES
from hushh_mcp.services.drive_period_packet_metrics import claimed
from hushh_mcp.services.drive_period_packet_metrics import snapshot as record_snapshot
from hushh_mcp.services.drive_period_packet_preview import snapshot_search
from hushh_mcp.services.drive_period_packet_search import (
    advance_search,
    create_search_job,
    finish_search,
)
from hushh_mcp.services.drive_period_packet_store import DrivePeriodPacketStore
from hushh_mcp.services.drive_request_package_assessment import semantic_request_model_binding
from hushh_mcp.services.drive_suggestion_service import (
    interpret_semantic_live_search,
    plan_semantic_live_search,
)
from hushh_mcp.services.drive_telemetry import drive_logger, drive_operation, drive_stage
from hushh_mcp.services.external_connector_lifecycle_store import ConnectorLifecycleError
from hushh_mcp.services.google_drive_adapter import DriveReadError
from hushh_mcp.services.owner_placement_guard import admit_hub_content

logger = drive_logger("drive_period_packets")


def _failure_state(error, build):
    # A schema-valid plan can still be unsupported by provider discovery.
    # Retain usable previews, but never pin retries to that failed plan.
    if isinstance(error, ValueError):
        build = {key: value for key, value in build.items() if key not in {"plan", "model_binding"}}
    code = (
        str(error)
        if isinstance(error, DriveReadError)
        else "provider_timeout"
        if isinstance(error, TimeoutError)
        else "processing_authority_required"
        if isinstance(error, PermissionError)
        else "planner_output_invalid"
        if isinstance(error, ValueError)
        else "provider_unavailable"
    )
    return code, build


class DrivePeriodPacketService:
    def __init__(
        self, *, store=None, search=None, planner=interpret_semantic_live_search, require_owner=None
    ):
        self.store = store or DrivePeriodPacketStore()
        self.search = search or DriveOwnerSearchService()
        self.planner = planner
        self.require_owner = require_owner

    async def preview(self, *, user_id, packet_id, cursor=None):
        if self.require_owner is None:
            raise DriveReadError("owner_authority_required")
        await self.require_owner()
        await admit_hub_content(user_id, "drive_period_packets")
        result = await self.store.owner_preview(user_id=user_id, packet_id=packet_id, cursor=cursor)
        await self.require_owner()
        return result

    async def prepare_preview(self, *, user_id, packet_id, refresh=False):
        if self.require_owner is None:
            raise DriveReadError("owner_authority_required")
        await self.require_owner()
        await admit_hub_content(user_id, "drive_period_packets")
        if await self.store.request_preview(user_id=user_id, packet_id=packet_id, refresh=refresh):
            from hushh_mcp.services.drive_work_wake import wake_drive_work

            outcomes = await asyncio.gather(
                self.run_one(
                    user_id=user_id,
                    packet_id=packet_id,
                    deadline_seconds=25,
                    first_results_only=True,
                ),
                wake_drive_work("suggestions"),
                return_exceptions=True,
            )
            for outcome in outcomes:
                if isinstance(outcome, BaseException):
                    raise outcome
        return await self.preview(user_id=user_id, packet_id=packet_id)

    async def ensure_owner(self, *, user_id, timezone="UTC"):
        await admit_hub_content(user_id, "drive_period_packets")
        return await self.store.ensure_owner(user_id=user_id, timezone=timezone)

    async def _plan(self, job, require_current):
        if job["category"] == "financial":
            from hushh_mcp.services.drive_financial_packet_query import financial_plan

            await require_current()
            return financial_plan(), None
        binding = semantic_request_model_binding()
        if not request_planner_processor_supported(binding):
            raise DriveReadError("connector_unavailable")
        # A plan was authored for this exact category/period. Another period's
        # interpretation may contain date-specific predicates and cannot be reused.
        build = job["build"]
        if build.get("model_binding") == binding and build.get("plan"):
            await require_current()
            return build["plan"], binding
        prompt = {
            "semantic_plan_version": 1,
            "document_request": {
                "purpose": CATEGORY_PURPOSES[job["category"]],
                "periodStart": job["period_start"].isoformat(),
                "periodEnd": job["period_end"].isoformat(),
            },
            "transaction_search": True,
            "current_time_utc": datetime.now(UTC).isoformat(timespec="seconds"),
            "user_timezone": job["period_timezone"],
        }
        plan = await plan_semantic_live_search(
            self.planner,
            prompt=json.dumps(prompt),
            user_id=job["user_id"],
            require_current=require_current,
            model_binding=binding,
        )
        return plan.model_dump(mode="json"), binding

    async def _search_job(self, job, plan, binding):
        return await create_search_job(self.search.store, job, plan, binding)

    @drive_operation(job_key="packet_id")
    async def run_one(
        self, *, user_id, packet_id=None, deadline_seconds=75, first_results_only=False
    ):
        await self.ensure_owner(user_id=user_id)
        job = await self.store.claim_build(
            user_id=user_id, **({"packet_id": packet_id} if packet_id else {})
        )
        if job is None:
            return "idle"

        async def current():
            if self.require_owner is not None:
                await self.require_owner()
            await self.store.require_build_current(
                user_id=user_id,
                packet_id=str(job["packet_id"]),
                revision=job["revision"],
                lease_id=job["lease_id"],
            )

        logger.info(
            "period_packet.claim queue_wait_ms=%.1f",
            max(0, (datetime.now(UTC) - job["next_at"]).total_seconds() * 1000),
        )
        build = job["build"]
        deadline = asyncio.get_running_loop().time() + deadline_seconds
        try:
            async with asyncio.timeout(deadline_seconds):
                with drive_stage(
                    logger, "packet_query" if job["category"] == "financial" else "packet_plan"
                ):
                    plan, binding = await self._plan(job, current)
                build = {**build, "plan": plan, "model_binding": binding}
                if job["category"] == "financial":
                    build["query_source"] = dict(QUERY_SOURCE)
                    logger.info(
                        "period_packet.query source=predefined version=%s planner_executed=false",
                        QUERY_SOURCE["version"],
                    )
                state = await self._search_job(job, plan, binding)
                build = claimed(logger, job, build, state, first_results_only=first_results_only)

                async def snapshot(**_):
                    nonlocal build
                    with drive_stage(logger, "packet_snapshot"):
                        build = await snapshot_search(self.store, job, build, state["jobId"])
                        record_snapshot(logger, job, build)

                await snapshot()
                state = await advance_search(
                    self.search,
                    state,
                    user_id=user_id,
                    current=current,
                    deadline=deadline,
                    snapshot=snapshot,
                    first_results_only=first_results_only,
                )
                await snapshot()
                return await finish_search(self.store, job, build, state, logger=logger)
        except (
            DriveReadError,
            ValueError,
            TimeoutError,
            PermissionError,
            SpecialistAdkTurnError,
        ) as error:
            code, build = _failure_state(error, build)
            await self.store.save_build(job, build, error=code)
            logger.info("period_packet.search outcome=unavailable code=%s", code)
            return "unavailable"

    async def run(self, *, max_jobs=1, deadline_seconds=90):
        if type(max_jobs) is not int or not 1 <= max_jobs <= 4 or not 1 <= deadline_seconds <= 180:
            raise ValueError("Invalid period packet worker bounds")
        if os.getenv("DRIVE_PERIOD_PACKETS_ENABLED", "false").lower() != "true":
            return {"schema_version": "drive.period_packets.v1", "outcomes": {}}
        counts = Counter()
        from hushh_mcp.services.drive_financial_packet_tagging import FinancialPacketTagger

        async def discover(user_id):
            try:
                counts[
                    await self.run_one(
                        user_id=user_id, deadline_seconds=max(1, min(75, deadline_seconds - 1))
                    )
                ] += 1
            except (
                DriveReadError,
                ValueError,
                TimeoutError,
                PermissionError,
                HTTPException,
                ConnectorLifecycleError,
            ):
                counts["unavailable"] += 1

        async def organize():
            try:
                tagger = FinancialPacketTagger(store=self.store)
                # The drain's stage budget also covers due_owners and the claim, so leave
                # margin for the batch's own timeout and commit to finish before that
                # budget cancels it.
                counts[
                    "tagging_"
                    + await tagger.run_one(deadline_seconds=max(1, deadline_seconds - 10))
                ] += 1
            except Exception as error:  # Advisory organizing must not cancel discovery siblings.
                logger.warning(
                    "period_packet.tagging outcome=deferred code=local_classifier_failure type=%s",
                    type(error).__name__,
                )
                counts["tagging_deferred"] += 1

        # Independent saved-result organizing never consumes the discovery budget.
        # Two owners maximum; an ordinary foreground request retains slot priority.
        owners = await self.store.due_owners(limit=min(max_jobs, 2))
        async with asyncio.timeout(deadline_seconds):
            async with asyncio.TaskGroup() as group:
                for user_id in owners:
                    group.create_task(discover(user_id))
                group.create_task(organize())
        if counts["queued"] or counts["tagging_queued"]:
            from hushh_mcp.services.drive_work_wake import wake_drive_work

            await wake_drive_work("suggestions")
        return {"schema_version": "drive.period_packets.v1", "outcomes": dict(counts)}
