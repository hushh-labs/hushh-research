"""Asynchronous organizing of saved packet candidates, never a discovery gate."""

import asyncio
import hashlib
import os
from contextlib import nullcontext
from dataclasses import replace
from datetime import UTC, datetime

from fastapi import HTTPException

from hushh_mcp.services import drive_financial_packet_tag_store as tags
from hushh_mcp.services.drive_document_prefix import PREFIX_POLICY
from hushh_mcp.services.drive_groups.adapters import IsolatedHeadEmbedder, TransportHeadSource
from hushh_mcp.services.drive_groups.indexer import classify_candidates
from hushh_mcp.services.drive_groups.models import load_bundle
from hushh_mcp.services.drive_telemetry import drive_logger, drive_stage
from hushh_mcp.services.google_drive_adapter import RAW_PREFIX_LIMIT, DriveReadError
from hushh_mcp.services.google_drive_rest_transport import GoogleDriveRestTransport
from hushh_mcp.services.owner_placement_guard import admit_hub_content

logger = drive_logger("financial_packet_tagging")


class CandidateReads:
    def __init__(self, worker, job):
        self.worker, self.job = worker, job
        self.allowed = {item["source"]["id"]: item["source"] for item in job["items"]}

    async def verify_source(self, source):
        await self.worker.current(self.job)
        response = await self.worker.transport.read_group_index_tool(
            user_id=self.job["user_id"],
            tool_name="get_file_metadata",
            arguments={"fileId": source["id"]},
            expected_generation=self.job["connection_generation"],
        )
        await self.worker.current(self.job)
        file = response.payload.get("file", {}) if not response.is_error else {}
        if (
            not source.get("sourceVersion")
            or str(file.get("version", "")) != source["sourceVersion"]
            or file.get("trashed") is True
        ):
            raise DriveReadError("source_unavailable")

    async def read_tool(self, *, user_id, tool_name, arguments):
        if (
            user_id != self.job["user_id"]
            or tool_name != "read_file_content"
            or arguments.get("fileId") not in self.allowed
        ):
            raise DriveReadError("invalid_argument")
        source = self.allowed[arguments["fileId"]]
        await self.verify_source(source)
        response = await self.worker.transport.read_group_index_tool(
            user_id=user_id,
            tool_name=tool_name,
            arguments=arguments,
            expected_generation=self.job["connection_generation"],
        )
        await self.verify_source(source)
        return response


class FinancialPacketTagger:
    def __init__(self, *, store, transport=None, embedder=None, bundle=None):
        self.store = store
        self.transport = transport or GoogleDriveRestTransport(raw_prefix=True)
        self.embedder = embedder or IsolatedHeadEmbedder()
        self.bundle = bundle

    async def current(self, job):
        await admit_hub_content(job["user_id"], "drive_period_packets")
        await tags.require_current(self.store, job)

    async def run_one(self, *, deadline_seconds=85):
        if os.getenv("DRIVE_PERIOD_PACKETS_ENABLED", "").lower() != "true":
            return "disabled"
        original = self.bundle or load_bundle()
        policy = f"{original.version}:{PREFIX_POLICY}:{RAW_PREFIX_LIMIT}:{original.head_chars}:require-head"
        bundle = replace(original, version=hashlib.sha256(policy.encode()).hexdigest()[:12])
        job = await tags.claim(self.store, bundle.version)
        if job is None:
            return "idle"
        logger.info(
            "period_packet.tagging_claim queue_wait_ms=%.1f files=%d",
            max(0, (datetime.now(UTC) - job["tagging_next_at"]).total_seconds() * 1000),
            len(job["items"]),
        )
        try:
            await self.current(job)
            reads = CandidateReads(self, job)
            worker = self

            class FencedEmbedding:
                async def embed(self, heads):
                    await worker.current(job)
                    vectors = await worker.embedder.embed(heads)
                    await worker.current(job)
                    return vectors

            async with asyncio.timeout(deadline_seconds):
                async with getattr(self.transport, "owner_search_session", nullcontext)():
                    cached = await tags.cached(self.store, job, bundle.version)
                    for item in job["items"]:
                        if item["source"]["id"] in cached:
                            try:
                                await reads.verify_source(item["source"])
                            except DriveReadError as error:
                                if str(error) != "source_unavailable":
                                    raise
                                cached.pop(item["source"]["id"])
                    with drive_stage(logger, "packet_tagging"):
                        run = await classify_candidates(
                            [
                                item["source"]
                                for item in job["items"]
                                if item["source"]["id"] not in cached
                            ],
                            heads=TransportHeadSource(reads, job["user_id"]),
                            embedder=FencedEmbedding(),
                            bundle=bundle,
                            read_concurrency=2,
                            require_head=True,
                        )
                placements = {
                    file.file_id: {
                        "group": file.placement.group,
                        "reason": file.placement.reason,
                        "groupSource": file.placement.group_source,
                    }
                    for file in run.files
                }
                placements.update(cached)
                result = []
                for item in job["items"]:
                    placement = placements.get(item["source"]["id"], {})
                    group = placement.get("group")
                    bucket = (
                        "financial"
                        if group in {"financial_statements", "insurance_statements"}
                        else "other"
                        if group or placement.get("reason") == "fits_none"
                        else "review"
                    )
                    result.append(
                        {
                            "bucket": bucket,
                            "reason": placement.get("reason", "no_evidence"),
                            "group": group,
                            "groupSource": placement.get("groupSource", "organizer_v1"),
                            "modelVersion": placement.get("modelVersion", bundle.version),
                            "reused": placement.get("reused", False),
                            "policyVersion": tags.POLICY,
                            "processingBasis": "server_managed_background_preparation",
                            "sourceVersion": item["source"].get("sourceVersion"),
                        }
                    )
            await self.current(job)
            outcome = await tags.commit(self.store, job, result)
            logger.info(
                "period_packet.tagging outcome=%s files=%d cache_hits=%d",
                outcome,
                len(result),
                len(cached),
            )
            return outcome
        except (
            DriveReadError,
            PermissionError,
            ValueError,
            TimeoutError,
            HTTPException,
            asyncio.CancelledError,
        ) as error:
            # No file, source evidence, sale version or owner result is removed.
            try:
                await tags.commit(self.store, job, error=True)
            except (DriveReadError, PermissionError, HTTPException):
                pass
            if isinstance(error, asyncio.CancelledError):
                raise
            return "deferred"
