"""Finite background processing batches; durable owner consent is job authority."""

from __future__ import annotations

import asyncio
from collections import Counter

from sqlalchemy import text

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_document_processor import LocalDocumentProcessor
from hushh_mcp.services.drive_document_store import PROCESSING_DISCLOSURE_VERSION
from hushh_mcp.services.drive_ingestion_service import DriveIngestionService


class DriveDocumentWorker:
    def __init__(self, service=None):
        self.service = service or DriveIngestionService(processor=LocalDocumentProcessor())

    async def due_owners(self, limit: int) -> list[str]:
        def operation(connection):
            return list(
                connection.execute(
                    text("""
                SELECT d.user_id FROM connected_documents d
                JOIN user_external_connector_connections c
                  ON c.user_id=d.user_id AND c.connector_id='google_drive'
                    AND c.connection_generation=d.connection_generation
                WHERE c.status='connected' AND c.validation_state='verified'
                  AND d.processing_enabled AND d.processing_disclosure_version=:disclosure
                  AND d.status IN ('ready','queued','stale','failed_retryable','fetching','parsing','indexing')
                  AND d.next_attempt_at<=clock_timestamp() AND d.attempt_count<5
                  AND (d.lease_id IS NULL OR d.lease_expires_at<=clock_timestamp())
                GROUP BY d.user_id ORDER BY min(d.next_attempt_at),d.user_id LIMIT :limit
            """),
                    {"disclosure": PROCESSING_DISCLOSURE_VERSION, "limit": limit},
                ).scalars()
            )

        return await self.service.store._transaction(operation)

    async def run(self, *, max_jobs: int = 8, deadline_seconds: int = 540) -> dict:
        if (
            type(max_jobs) is not int
            or not 1 <= max_jobs <= 20
            or type(deadline_seconds) is not int
            or not 1 <= deadline_seconds <= 540
        ):
            raise ValueError("invalid worker bounds")
        counts: Counter = Counter()
        try:
            async with asyncio.timeout(deadline_seconds):
                for owner in await self.due_owners(max_jobs):
                    if not connector_feature_enabled("drive_document_indexing", owner):
                        counts["disabled"] += 1
                        continue
                    try:
                        outcome = await self.service.run_one(user_id=owner)
                        status = outcome.get("status")
                        counts[
                            status
                            if status
                            in {
                                "ready",
                                "unchanged",
                                "idle",
                                "unavailable",
                                "superseded",
                                "not_ready",
                            }
                            else "not_ready"
                        ] += 1
                    except Exception:
                        counts["not_ready"] += 1
        except TimeoutError:
            counts["deadline"] += 1
        return {"schema_version": "drive.worker.v1", "outcomes": dict(counts)}
