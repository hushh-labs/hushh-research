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
from hushh_mcp.services.drive_telemetry import correlation_tag, drive_logger, drive_stage
from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.external_connector_lifecycle_store import ConnectorLifecycleError
from hushh_mcp.services.google_drive_adapter import RAW_PREFIX_LIMIT, DriveReadError
from hushh_mcp.services.google_drive_rest_transport import GoogleDriveRestTransport
from hushh_mcp.services.owner_placement_guard import admit_hub_content

logger = drive_logger("financial_packet_tagging")


# The drive bulk-share join delays: an ordinary token refresh settles well within them.
_REFRESH_JOIN_DELAYS = (0.2, 0.4, 0.8)


def _refresh_pending(error):
    return (
        isinstance(error, DriveOAuthError)
        and error.status_code == 409
        and str(error) == "refresh_in_progress"
    )


def _failure_code(error):
    if isinstance(error, DriveOAuthError):
        code = str(error)
        return code if code in tags.OAUTH_FAILURE_CODES else "oauth_unavailable"
    if isinstance(error, ConnectorLifecycleError):
        code = str(error)
        return code if code in tags.LIFECYCLE_FAILURE_CODES else "connector_unavailable"
    if isinstance(error, DriveReadError) and error.retryable:
        return "provider_unavailable"
    # The worker's own budget or a shutdown ended the batch: not a packet fault.
    if isinstance(error, (TimeoutError, asyncio.CancelledError)):
        return "processing_timeout"
    return "processing_unavailable"


class CandidateReads:
    def __init__(self, worker, job):
        self.worker, self.job = worker, job
        self.allowed = {item["source"]["id"]: item["source"] for item in job["items"]}
        self._first_read, self._credential_ready = asyncio.Lock(), False

    async def _tool(self, tool_name, arguments):
        # Concurrent head reads share one owner credential. The batch's first read
        # runs alone, so a refresh that is due (always, after a long retry wait)
        # finishes before reads go concurrent.
        if not self._credential_ready:
            async with self._first_read:
                if not self._credential_ready:
                    response = await self._join_refresh(tool_name, arguments)
                    self._credential_ready = True
                    return response
        return await self._join_refresh(tool_name, arguments)

    async def _join_refresh(self, tool_name, arguments):
        # A token that comes due mid-batch can still meet a sibling's refresh lease.
        # Losing it is normal contention, not a failed batch: failing would cancel
        # the sibling's refresh in flight. Briefly join the committed refresh,
        # re-checking authority between waits, as bulk sharing does.
        for attempt in range(len(_REFRESH_JOIN_DELAYS) + 1):
            if attempt:
                await asyncio.sleep(_REFRESH_JOIN_DELAYS[attempt - 1])
                await self.worker.current(self.job)
            try:
                return await self.worker.transport.read_group_index_tool(
                    user_id=self.job["user_id"],
                    tool_name=tool_name,
                    arguments=arguments,
                    expected_generation=self.job["connection_generation"],
                )
            except DriveOAuthError as error:
                if not _refresh_pending(error) or attempt == len(_REFRESH_JOIN_DELAYS):
                    raise
        raise AssertionError("unreachable refresh retry")

    async def verify_source(self, source):
        await self.worker.current(self.job)
        response = await self._tool("get_file_metadata", {"fileId": source["id"]})
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
        response = await self._tool(tool_name, arguments)
        await self.verify_source(source)
        return response


def candidate_tag(source, placement, model_version):
    """Map the classifier's closed groups to advisory display buckets only."""
    group = placement.get("group")
    bucket = (
        "financial"
        if group in {"financial_statements", "insurance_statements"}
        else "other"
        if group or placement.get("reason") == "fits_none"
        else "review"
    )
    return {
        "bucket": bucket,
        "reason": placement.get("reason", "no_evidence"),
        "group": group,
        "groupSource": placement.get("groupSource", "organizer_v1"),
        "modelVersion": placement.get("modelVersion", model_version),
        "reused": placement.get("reused", False),
        "policyVersion": tags.POLICY,
        "processingBasis": "server_managed_background_preparation",
        "sourceVersion": source.get("sourceVersion"),
    }


class FinancialPacketTagger:
    def __init__(self, *, store, transport=None, embedder=None, bundle=None):
        self.store = store
        self.transport = transport or GoogleDriveRestTransport(raw_prefix=True)
        self.embedder = embedder or IsolatedHeadEmbedder()
        self.bundle = bundle

    async def current(self, job):
        await admit_hub_content(job["user_id"], "drive_period_packets")
        await tags.require_current(self.store, job)

    async def _organize(self, job, bundle, deadline_seconds):
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
            result = [
                candidate_tag(
                    item["source"], placements.get(item["source"]["id"], {}), bundle.version
                )
                for item in job["items"]
            ]
        return result, cached

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
            "period_packet.tagging_claim queue_wait_ms=%.1f files=%d packet_tag=%s",
            max(0, (datetime.now(UTC) - job["tagging_next_at"]).total_seconds() * 1000),
            len(job["items"]),
            correlation_tag(str(job["packet_id"])),
        )
        try:
            await self.current(job)
            result, cached = await self._organize(job, bundle, deadline_seconds)
            await self.current(job)
            outcome = await tags.commit(self.store, job, result)
            logger.info(
                "period_packet.tagging outcome=%s files=%d cache_hits=%d packet_tag=%s",
                outcome,
                len(result),
                len(cached),
                correlation_tag(str(job["packet_id"])),
            )
            return outcome
        except (
            DriveOAuthError,
            DriveReadError,
            ConnectorLifecycleError,
            PermissionError,
            ValueError,
            TimeoutError,
            HTTPException,
            asyncio.CancelledError,
        ) as error:
            # No file, source evidence, sale version or owner result is removed.
            code = _failure_code(error)
            try:
                settled = await tags.commit(self.store, job, error=code)
            except (
                DriveOAuthError,
                DriveReadError,
                ConnectorLifecycleError,
                PermissionError,
                HTTPException,
            ):
                settled = "unrecorded"
            logger.info(
                "period_packet.tagging outcome=deferred code=%s settled=%s packet_tag=%s",
                code,
                settled,
                correlation_tag(str(job["packet_id"])),
            )
            if isinstance(error, asyncio.CancelledError):
                raise
            return "deferred"
