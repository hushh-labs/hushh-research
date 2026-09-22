"""Bounded ingestion over durable leases, not a fire-and-forget task queue.

No production processor is selected by this foundation. Callers MUST supply a
separately verified scanner/parser/embedding implementation. No API/startup
hook can activate this path accidentally; scheduler wiring follows acceptance.
"""

from __future__ import annotations

import asyncio
from typing import Protocol

from hushh_mcp.services.document_index_service import PreparedIndex
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

    async def _fetch(self, job: dict) -> DriveContent:
        await self.store.current(job)
        row, credential = await self.oauth.current_credential(user_id=job["user_id"])
        if row["connection_generation"] != job["connection_generation"]:
            raise DriveReadError("connection_changed")
        metadata = self.store.cipher.open(job)
        return await self.adapter.fetch_content(
            file_id=metadata["file_id"], access_token=credential["accessToken"]
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
            async with asyncio.timeout(90):
                content = await self._fetch(job)
                await self.store.stage(job, "parsing")
                prepared = await self.processor.prepare(
                    content=content.content, mime_type=content.mime_type
                )
                prepared.validate()
                await self.store.stage(job, "indexing")
                current, credential = await self.oauth.current_credential(user_id=user_id)
                if current["connection_generation"] != job["connection_generation"]:
                    raise DriveReadError("connection_changed")
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
