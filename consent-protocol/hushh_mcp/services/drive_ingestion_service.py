"""Bounded ingestion over durable leases, not a fire-and-forget task queue.

The dedicated worker supplies the local scanner/parser/embedding implementation.
No API/startup hook activates processing, and selection alone is not consent.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import asdict, replace
from typing import Protocol

from hushh_mcp.services.document_index_service import PreparedIndex, index_version
from hushh_mcp.services.drive_document_targets import document_targets
from hushh_mcp.services.drive_ingestion_store import DriveIngestionStore
from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.external_connector_oauth_service import get_external_connector_oauth_service
from hushh_mcp.services.google_drive_adapter import (
    LIVE_COLLECTION_CONTENT_LIMIT,
    LIVE_PARTIAL_EXPORTS,
    DriveContent,
    DriveReadError,
    GoogleDriveAdapter,
)

logger = logging.getLogger(__name__)


class DocumentProcessor(Protocol):
    """In-memory only; no credentials, provider IDs, names, or owner identifiers.

    Implementations must enforce scan-before-binary-parse, bounded local/private
    processing and cancellation. They cannot send content to an undeclared API.
    """

    async def prepare(self, *, content: bytes, mime_type: str) -> PreparedIndex: ...


class DriveIngestionService:
    def __init__(self, *, processor: DocumentProcessor, oauth=None, store=None, adapter=None):
        self.processor = processor
        self.oauth = oauth or get_external_connector_oauth_service().drive()
        self.store = store or DriveIngestionStore(db=self.oauth.lifecycle.db)
        self.adapter = adapter or GoogleDriveAdapter()

    async def _fetch(self, job: dict) -> DriveContent | None:
        await self.store.current(job)
        row, credential = await self.oauth.current_credential(
            user_id=job["user_id"], required_profile=job.get("source_profile", "selected")
        )
        if row["connection_generation"] != job["connection_generation"]:
            raise DriveReadError("connection_changed")
        await self.store.current(job)
        metadata = self.store.cipher.open(job)
        if job.get("source_profile") == "live":
            before = await self.adapter.get_metadata(
                file_id=metadata["file_id"],
                access_token=credential["accessToken"],
                require_app_authorized=False,
            )
            if asdict(before) != metadata:
                raise DriveReadError("source_changed", retryable=True)
            await self.store.current(job)
            progress = await self.store.page_progress(job, source_version=before.version)
            if progress["complete"]:
                await self.store.publish_pages(job, metadata=before)
                return None
            mime, content = await self.adapter.read_live_bytes(
                file_id=before.file_id,
                mime_type=before.mime_type,
                access_token=credential["accessToken"],
                max_bytes=LIVE_COLLECTION_CONTENT_LIMIT,
            )
            await self.store.current(job)
            after = await self.adapter.get_metadata(
                file_id=before.file_id,
                access_token=credential["accessToken"],
                require_app_authorized=False,
            )
            if before != after:
                raise DriveReadError("source_changed", retryable=True)
            return DriveContent(before, mime, content)
        profile = getattr(self.processor, "profile", None)
        if isinstance(profile, str) and job.get("active_version"):
            fresh = await self.adapter.get_metadata(
                file_id=metadata["file_id"], access_token=credential["accessToken"]
            )
            expected = index_version(
                source_fingerprint=job["source_fingerprint"],
                source_version=fresh.version,
                profile=profile,
            )
            if asdict(fresh) == metadata and job["active_version"] == expected:
                await self.store.unchanged(job)
                return None
            await self.store.current(job)
        return await self.adapter.fetch_content(
            file_id=metadata["file_id"],
            access_token=credential["accessToken"],
            require_current=lambda: self.store.current(job),
        )

    async def run_one(
        self, *, user_id: str, document_ids=None, prefer_profile_upgrade=False
    ) -> dict[str, str]:
        targets = document_targets(document_ids)
        row = await self.oauth.lifecycle.read(user_id=user_id, connector_id="google_drive")
        if not row:
            return {"status": "unavailable"}
        job = await self.store.claim(
            user_id=user_id,
            generation=row["connection_generation"],
            **({"document_ids": targets} if targets is not None else {}),
            prefer_profile_upgrade=prefer_profile_upgrade,
        )
        if not job:
            return {"status": "idle"}
        started, marks = time.monotonic(), {}
        result = await self._process(job, user_id=user_id, marks=marks)
        fetched = marks.get("fetched", started)
        extracted = marks.get("extracted", fetched)
        # Aggregate stage timing only: no owner, document, name or content.
        logger.info(
            "drive_extraction_job status=%s pages=%d fetch_ms=%d extract_ms=%d total_ms=%d",
            result["status"],
            marks.get("pages", 0),
            round((fetched - started) * 1000),
            round((extracted - fetched) * 1000),
            round((time.monotonic() - started) * 1000),
        )
        return result

    async def _process(self, job: dict, *, user_id: str, marks: dict) -> dict[str, str]:
        try:
            # Less than the DB-clock lease. Cancellation/crash leaves a durable
            # reclaimable job; no late publish can acquire a replacement lease.
            async with asyncio.timeout(170):
                content = await self._fetch(job)
                marks["fetched"] = time.monotonic()
                if content is None:
                    return {"status": "unchanged"}
                await self.store.stage(job, "parsing")
                live = job.get("source_profile") == "live"
                if live:
                    progress = await self.store.page_progress(
                        job, source_version=content.metadata.version
                    )
                    prepared = await self.processor.extract_pages(
                        content=content.content,
                        mime_type=content.mime_type,
                        start_page=progress["next_page"],
                        page_limit=4,
                    )
                else:
                    prepared = await self.processor.prepare(
                        content=content.content, mime_type=content.mime_type
                    )
                marks["extracted"] = time.monotonic()
                if live:
                    marks["pages"] = len(prepared.pages)
                if live and content.metadata.mime_type in LIVE_PARTIAL_EXPORTS:
                    prepared = replace(
                        prepared,
                        has_gaps=True,
                        pages=tuple(
                            replace(
                                page, status="partial", error_code="source_extraction_incomplete"
                            )
                            for page in prepared.pages
                        ),
                    )
                prepared.validate()
                await self.store.stage(job, "indexing")
                current, credential = await self.oauth.current_credential(
                    user_id=user_id, required_profile=job.get("source_profile", "selected")
                )
                if current["connection_generation"] != job["connection_generation"]:
                    raise DriveReadError("connection_changed")
                await self.store.current(job)
                after = await self.adapter.get_metadata(
                    file_id=content.metadata.file_id,
                    access_token=credential["accessToken"],
                    **({"require_app_authorized": False} if live else {}),
                )
                if after != content.metadata:
                    raise DriveReadError("source_changed", retryable=True)
                if live:
                    complete = await self.store.publish_pages(job, metadata=after, batch=prepared)
                    if not complete:
                        return {"status": "queued"}
                else:
                    await self.store.publish(job, metadata=after, index=prepared)
            # No raw source, provider ID, filename, text, vectors or exception
            # reaches worker telemetry or a caller's tool history.
            return {"status": "ready"}
        except asyncio.CancelledError:
            raise
        except Exception as error:
            code = (
                str(error)
                if isinstance(error, (DriveReadError, DriveOAuthError))
                else (
                    "processing_timeout"
                    if isinstance(error, TimeoutError)
                    else "processor_unavailable"
                )
            )
            if code in {
                "connection_changed",
                "ingestion_superseded",
                "collection_processing_required",
                "background_preparation_required",
                "collection_superseded",
            }:
                return {"status": "superseded"}
            try:
                await self.store.fail(job, code=code)
            except DriveReadError:
                return {"status": "superseded"}
            return {
                "status": "unsupported"
                if job.get("source_profile") == "live" and code == "unsupported_format"
                else "not_ready"
            }
