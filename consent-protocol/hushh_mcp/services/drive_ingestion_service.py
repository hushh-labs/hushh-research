"""Bounded ingestion over durable leases, not a fire-and-forget task queue.

The dedicated worker supplies the local scanner/parser/embedding implementation.
No API/startup hook activates processing, and selection alone is not consent.
"""

from __future__ import annotations

import asyncio
from dataclasses import asdict
from typing import Protocol

from hushh_mcp.services.document_index_service import PreparedIndex, index_version
from hushh_mcp.services.drive_ingestion_store import DriveIngestionStore
from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.external_connector_oauth_service import get_external_connector_oauth_service
from hushh_mcp.services.google_drive_adapter import DriveContent, DriveReadError, GoogleDriveAdapter


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
        row, credential = await self.oauth.current_credential(user_id=job["user_id"])
        if row["connection_generation"] != job["connection_generation"]:
            raise DriveReadError("connection_changed")
        await self.store.current(job)
        metadata = self.store.cipher.open(job)
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

    async def run_one(self, *, user_id: str) -> dict[str, str]:
        row = await self.oauth.lifecycle.read(user_id=user_id, connector_id="google_drive")
        if not row:
            return {"status": "unavailable"}
        job = await self.store.claim(user_id=user_id, generation=row["connection_generation"])
        if not job:
            return {"status": "idle"}
        try:
            # Less than the DB-clock lease. Cancellation/crash leaves a durable
            # reclaimable job; no late publish can acquire a replacement lease.
            async with asyncio.timeout(170):
                content = await self._fetch(job)
                if content is None:
                    return {"status": "unchanged"}
                await self.store.stage(job, "parsing")
                prepared = await self.processor.prepare(
                    content=content.content, mime_type=content.mime_type
                )
                prepared.validate()
                await self.store.stage(job, "indexing")
                current, credential = await self.oauth.current_credential(user_id=user_id)
                if current["connection_generation"] != job["connection_generation"]:
                    raise DriveReadError("connection_changed")
                await self.store.current(job)
                after = await self.adapter.get_metadata(
                    file_id=content.metadata.file_id, access_token=credential["accessToken"]
                )
                if after != content.metadata:
                    raise DriveReadError("source_changed", retryable=True)
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
            }:
                return {"status": "superseded"}
            try:
                await self.store.fail(job, code=code)
            except DriveReadError:
                return {"status": "superseded"}
            return {"status": "not_ready"}
