"""Finite metadata-only packet planning and discovery on the existing search queue."""

from __future__ import annotations

import asyncio
import json
import os
from collections import Counter
from datetime import UTC, datetime

from hushh_mcp.hushh_adk.turn import SpecialistAdkTurnError
from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService
from hushh_mcp.services.drive_period_packet_contract import (
    CATEGORY_PURPOSES,
    PERIOD_PACKET_POLICY,
    PacketPeriod,
)
from hushh_mcp.services.drive_period_packet_preview import search_client_id, snapshot_search
from hushh_mcp.services.drive_period_packet_store import DrivePeriodPacketStore
from hushh_mcp.services.drive_request_discovery import (
    DISCOVERY_DELIVERY_POLICY,
    compile_discovery_queries,
)
from hushh_mcp.services.drive_request_package_assessment import semantic_request_model_binding
from hushh_mcp.services.drive_request_semantic_plan import semantic_plan_digest
from hushh_mcp.services.drive_suggestion_service import (
    interpret_semantic_live_search,
    plan_semantic_live_search,
)
from hushh_mcp.services.drive_telemetry import drive_logger, drive_operation, drive_stage
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
            await self.run_one(user_id=user_id, packet_id=packet_id, deadline_seconds=25)
        return await self.preview(user_id=user_id, packet_id=packet_id)

    async def ensure_owner(self, *, user_id, timezone="UTC"):
        await admit_hub_content(user_id, "drive_period_packets")
        return await self.store.ensure_owner(user_id=user_id, timezone=timezone)

    async def _plan(self, job, require_current):
        binding = semantic_request_model_binding()
        if binding["provider"] != "azure_openai":
            raise DriveReadError("connector_unavailable")
        # A plan was authored for this exact category/period. Another period's
        # interpretation may contain date-specific predicates and cannot be reused.
        build = job["build"]
        if build.get("model_binding") == binding and build.get("plan"):
            await require_current()
            return build["plan"], binding
        prompt = {
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
        purpose = {
            "purpose": CATEGORY_PURPOSES[job["category"]],
            "periodStart": job["period_start"].isoformat(),
            "periodEnd": job["period_end"].isoformat(),
        }
        queries = compile_discovery_queries(
            plan["semantic_query"],
            file_kind=plan["file_kind"],
            period_start=purpose["periodStart"],
            period_end=purpose["periodEnd"],
            timezone=job["period_timezone"],
            shared_with_me=plan.get("shared_with_me", False),
        )
        state, _ = await self.search.store.create(
            user_id=job["user_id"],
            client_request_id=search_client_id(job),
            request={"query": purpose["purpose"], "timezone": job["period_timezone"]},
            confirmed=True,
            period_packet_id=str(job["packet_id"]),
            replace_terminal_request=True,
            checkpoint={
                "request": {"query": purpose["purpose"], "timezone": job["period_timezone"]},
                "period_packet_origin": {
                    "packet_id": str(job["packet_id"]),
                    "revision": job["revision"],
                    "policy": PERIOD_PACKET_POLICY,
                },
                "arguments": queries[0]["arguments"],
                "queries": queries,
                "query_index": 0,
                "semantic_plan": plan["semantic_query"],
                "semantic_plan_digest": semantic_plan_digest(plan["semantic_query"]),
                "semantic_model_binding": binding,
                "semantic_purpose": purpose,
                "discovery_delivery_policy": DISCOVERY_DELIVERY_POLICY,
                "evidence_route": "provider",
                "request_file_kind": plan["file_kind"],
                "request_direct_originals": True,
                "request_explicit_dates": True,
                "request_owner_review_required": False,
                "requested_period": {
                    "start": purpose["periodStart"],
                    "end": purpose["periodEnd"],
                    "timezone": job["period_timezone"],
                },
                "coverage_counts": {},
                "folder_queue": [],
                "folder_digests": [],
                "phase": "user",
                "page_token": None,
                "drive_page_token": None,
                "drives": [],
                "drive_index": 0,
                "seen_tokens": [],
                "drive_tokens": [],
            },
        )
        return state

    @drive_operation(job_key="packet_id")
    async def run_one(self, *, user_id, packet_id=None, deadline_seconds=75):
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

        build = job["build"]
        try:
            async with asyncio.timeout(deadline_seconds):
                with drive_stage(logger, "packet_plan"):
                    plan, binding = await self._plan(job, current)
                build = {**build, "plan": plan, "model_binding": binding}
                state = await self._search_job(job, plan, binding)

                async def snapshot(**_):
                    nonlocal build
                    with drive_stage(logger, "packet_snapshot"):
                        build = await snapshot_search(self.store, job, build, state["jobId"])

                await snapshot()
                if state["status"] != "completed":
                    await self.search.run_one(
                        user_id=user_id,
                        job_id=state["jobId"],
                        require_current=current,
                        max_pages=2,
                        deadline_seconds=min(30, deadline_seconds),
                        after_page=snapshot,
                    )
                    state = await self.search.store.status(user_id=user_id, job_id=state["jobId"])
                await snapshot()
                if state["status"] == "completed" and not state["incompleteSearch"]:
                    period = PacketPeriod(
                        start=job["period_start"],
                        end=job["period_end"],
                        timezone=job["period_timezone"],
                    )
                    # A scan begun while the period was open is a preview, never the final sale.
                    if period.closed(datetime.now(UTC)) and period.closed(
                        datetime.fromisoformat(state["createdAt"])
                    ):
                        job["build"] = build
                        await self.store.freeze(job, search_job_id=state["jobId"])
                    else:
                        await self.store.save_build(job, build, preview_complete=True)
                    logger.info(
                        "period_packet.search outcome=completed matched=%d", state["matched"]
                    )
                    return "completed"
                await self.store.save_build(
                    job,
                    build,
                    error=(state.get("errorCode") or "search_incomplete")
                    if state["status"] in {"failed", "limited"}
                    else None,
                )
                return "queued"
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
        async with asyncio.timeout(deadline_seconds):
            for user_id in await self.store.due_owners(limit=max_jobs):
                try:
                    counts[
                        await self.run_one(
                            user_id=user_id, deadline_seconds=min(75, deadline_seconds)
                        )
                    ] += 1
                except (DriveReadError, ValueError, TimeoutError):
                    counts["unavailable"] += 1
        return {"schema_version": "drive.period_packets.v1", "outcomes": dict(counts)}
