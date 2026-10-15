"""Finite background processing batches; durable owner consent is job authority."""

from __future__ import annotations

import asyncio
from collections import Counter

from sqlalchemy import text

from hushh_mcp.services.connector_feature_admission import (
    connector_feature_enabled,
    connector_feature_owner_cohort,
)
from hushh_mcp.services.drive_document_pages import EXTRACTION_PROFILE
from hushh_mcp.services.drive_document_processor import LocalDocumentProcessor
from hushh_mcp.services.drive_document_store import PROCESSING_DISCLOSURE_VERSION
from hushh_mcp.services.drive_ingestion_service import DriveIngestionService


class DriveDocumentWorker:
    def __init__(self, service=None, *, collection_sync=None, packet_worker=None):
        self.service = service or DriveIngestionService(processor=LocalDocumentProcessor())
        if service is None and collection_sync is None:
            from hushh_mcp.services.drive_collection_sync import DriveCollectionSync

            collection_sync = DriveCollectionSync()
        self.collection_sync = collection_sync
        if service is None and packet_worker is None:
            from hushh_mcp.services.drive_packet_worker import DrivePacketWorker

            async def defer_wake(_stage):
                # This composition emits one shared wake after all lanes settle.
                return None

            packet_worker = DrivePacketWorker(wake=defer_wake)
        self.packet_worker = packet_worker

    async def due_owners(self, limit: int, *, reserve_profile_upgrade: bool = False) -> list[str]:
        def operation(connection):
            cohort = connector_feature_owner_cohort("drive_document_indexing")
            if cohort == ():
                return []
            return list(
                connection.execute(
                    text("""
                WITH owner_jobs AS (
                  SELECT d.user_id,0 AS lane,min(d.next_attempt_at) AS due_at
                  FROM connected_documents d
                  JOIN user_external_connector_connections c
                    ON c.user_id=d.user_id AND c.connector_id='google_drive'
                      AND c.connection_generation=d.connection_generation
                  WHERE c.status='connected' AND c.validation_state='verified'
                    AND (:all_owners OR d.user_id=ANY(CAST(:owners AS text[])))
                    AND d.processing_enabled AND (d.processing_disclosure_version=:disclosure
                      OR (d.source_profile='live' AND d.processing_disclosure_version='live-drive-collection-v1'))
                    AND d.status IN ('ready','queued','stale','failed_retryable','fetching','parsing','indexing')
                    AND d.next_attempt_at<=clock_timestamp()
                    AND (d.source_profile='live' OR d.attempt_count<5)
                    AND (d.lease_id IS NULL OR d.lease_expires_at<=clock_timestamp())
                  GROUP BY d.user_id
                  UNION ALL
                  SELECT e.user_id,1 AS lane,min(e.updated_at) AS due_at
                  FROM drive_document_extractions e
                  JOIN connected_documents d ON d.document_id=e.document_id
                    AND d.active_version=e.extraction_version
                  JOIN user_external_connector_connections c
                    ON c.user_id=e.user_id AND c.connector_id='google_drive'
                      AND c.connection_generation=e.connection_generation
                  WHERE c.status='connected' AND c.validation_state='verified'
                    AND (:all_owners OR e.user_id=ANY(CAST(:owners AS text[])))
                    AND e.extraction_profile<>:extraction_profile
                    AND d.user_id=e.user_id AND d.connection_generation=e.connection_generation
                    AND d.source_profile='live' AND d.processing_enabled
                    AND d.processing_disclosure_version='live-drive-collection-v1'
                    AND d.status='ready'
                    AND (d.lease_id IS NULL OR d.lease_expires_at<=clock_timestamp())
                  GROUP BY e.user_id
                )
                ,owner_queue AS (
                  SELECT user_id,
                    min(due_at) FILTER (WHERE lane=0) AS ordinary_due_at,
                    min(due_at) FILTER (WHERE lane=1) AS upgrade_due_at
                  FROM owner_jobs GROUP BY user_id
                ),upgrade_pick AS (
                  SELECT user_id FROM owner_queue
                  WHERE :reserve_profile_upgrade AND upgrade_due_at IS NOT NULL
                  ORDER BY (ordinary_due_at IS NOT NULL),upgrade_due_at,user_id LIMIT 1
                )
                SELECT q.user_id FROM owner_queue q
                LEFT JOIN upgrade_pick u ON u.user_id=q.user_id
                ORDER BY CASE WHEN u.user_id IS NOT NULL THEN 0 ELSE 1 END,
                  q.ordinary_due_at NULLS LAST,q.upgrade_due_at,q.user_id LIMIT :limit
            """),
                    {
                        "disclosure": PROCESSING_DISCLOSURE_VERSION,
                        "extraction_profile": EXTRACTION_PROFILE,
                        "reserve_profile_upgrade": reserve_profile_upgrade,
                        "limit": limit,
                        "all_owners": cohort is None,
                        "owners": list(cohort or ()),
                    },
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
        if self.packet_worker is not None:
            deadline_seconds = min(deadline_seconds, 160)
        counts: Counter = Counter()
        semantic_budget = (
            max(2, max_jobs // 3) if self.packet_worker is not None and max_jobs >= 4 else 0
        )
        discovery_budget = (
            min(2, max_jobs - semantic_budget - 1) if self.collection_sync is not None else 0
        )
        document_budget = max_jobs - semantic_budget - discovery_budget

        async def documents():
            processed = 0
            blocked = set()
            while processed < document_budget:
                reserve_profile_upgrade = processed % 4 == 0 and document_budget - processed >= 2
                owners = [
                    owner
                    for owner in await self.due_owners(
                        document_budget - processed,
                        reserve_profile_upgrade=reserve_profile_upgrade,
                    )
                    if owner not in blocked
                ]
                if not owners:
                    break
                semaphore = asyncio.Semaphore(4)

                async def one(owner, *, prefer_profile_upgrade, semaphore=semaphore):
                    async with semaphore:
                        if not connector_feature_enabled("drive_document_indexing", owner):
                            counts["disabled"] += 1
                            blocked.add(owner)
                            return
                        try:
                            outcome = await self.service.run_one(
                                user_id=owner, prefer_profile_upgrade=prefer_profile_upgrade
                            )
                            status = outcome.get("status")
                            counts[
                                status
                                if status
                                in {
                                    "ready",
                                    "queued",
                                    "unchanged",
                                    "idle",
                                    "unavailable",
                                    "superseded",
                                    "not_ready",
                                    "unsupported",
                                }
                                else "not_ready"
                            ] += 1
                            if status not in {"ready", "queued", "unchanged", "unsupported"}:
                                blocked.add(owner)
                        except Exception:
                            counts["not_ready"] += 1
                            blocked.add(owner)

                await asyncio.gather(
                    *(
                        one(owner, prefer_profile_upgrade=(processed + index) % 4 == 0)
                        for index, owner in enumerate(owners)
                    )
                )
                processed += len(owners)

        async def discovery():
            if self.collection_sync is not None and discovery_budget:
                result = await self.collection_sync.run(
                    max_jobs=discovery_budget, deadline_seconds=min(deadline_seconds, 100)
                )
                for status, count in result.get("outcomes", {}).items():
                    if status in {"queued", "synced", "unavailable", "deadline", "idle"}:
                        counts[status] += count

        async def semantics():
            remaining = semantic_budget
            while remaining:
                # A packet sweep claims distinct owners only once. Continue a
                # productive sweep so one large collection can use its finite
                # budget, without concurrent jobs for the same owner/phase.
                result = await self.packet_worker.run(
                    max_jobs=remaining, deadline_seconds=min(deadline_seconds, 160)
                )
                for status, count in result.items():
                    target = (
                        "queued"
                        if status in {"facts_queued", "facts_complete", "packet_queued"}
                        else "ready"
                        if status == "ready"
                        else "idle"
                        if status == "idle"
                        else "deadline"
                        if status == "deadline"
                        else "not_ready"
                    )
                    counts[target] += count
                attempted = sum(result.values())
                if (
                    not attempted
                    or result.get("deadline")
                    or not any(
                        result.get(status, 0)
                        for status in (
                            "facts_queued",
                            "facts_complete",
                            "packet_queued",
                            "ready",
                            "incomplete",
                            "unable_to_verify",
                        )
                    )
                ):
                    break
                remaining -= min(remaining, attempted)

        try:
            async with asyncio.timeout(deadline_seconds):
                async with asyncio.TaskGroup() as group:
                    group.create_task(documents())
                    group.create_task(discovery())
                    group.create_task(semantics())
        except TimeoutError:
            counts["deadline"] += 1
        if counts["queued"] or counts["ready"]:
            from hushh_mcp.services.drive_work_wake import wake_drive_work

            await wake_drive_work("documents")
        return {
            "schema_version": "drive.worker.v1",
            "outcomes": {key: value for key, value in counts.items() if value},
        }
