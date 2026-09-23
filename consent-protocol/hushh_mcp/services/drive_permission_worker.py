"""Finite delivery drain. Database claims own authority, not a worker session.

Only queued confirmed effects may mutate Google. Expired dispatching and
unknown effects always use read-only reconciliation, never a repeated write.
"""

import asyncio
from collections import Counter

from sqlalchemy import text

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_revocation_executor import DriveRevocationExecutor


class DrivePermissionWorker:
    def __init__(self, executor=None):
        self.executor = executor or DriveRevocationExecutor()

    async def due(self, limit):
        def operation(connection):
            return [
                dict(row)
                for row in connection.execute(
                    text("""
                WITH due AS (SELECT operation_id FROM drive_share_permission_operations
                WHERE state IN ('queued','dispatching','unknown')
                  AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp())
                ORDER BY worker_inspected_at,created_at,operation_id
                LIMIT :limit FOR UPDATE SKIP LOCKED)
                UPDATE drive_share_permission_operations p SET worker_inspected_at=clock_timestamp()
                FROM due WHERE p.operation_id=due.operation_id
                RETURNING p.operation_id,p.user_id,p.kind,p.state
            """),
                    {"limit": min(max(limit, 1), 100)},
                ).mappings()
            ]

        return await self.executor.store._transaction(operation)

    async def _jobs(self, max_jobs):
        attempted = 0
        inspected = set()
        while attempted < max_jobs and len(inspected) < max_jobs * 5:
            batch = await self.due(min(max_jobs - attempted, max_jobs * 5 - len(inspected)))
            fresh = [row for row in batch if row["operation_id"] not in inspected]
            if not fresh:
                return
            for row in fresh:
                inspected.add(row["operation_id"])
                # Management is independent of admission for new sharing.
                feature = (
                    "drive_document_sharing"
                    if row["kind"] == "grant" and row["state"] == "queued"
                    else "google_drive_connection"
                )
                enabled = connector_feature_enabled(feature, row["user_id"])
                attempted += int(enabled)
                yield row, enabled

    async def run(self, *, max_jobs=8, deadline_seconds=540):
        if (
            type(max_jobs) is not int
            or not 1 <= max_jobs <= 20
            or type(deadline_seconds) is not int
            or not 1 <= deadline_seconds <= 540
        ):
            raise ValueError("invalid worker bounds")
        counts = Counter()
        try:
            async with asyncio.timeout(deadline_seconds):
                async for job, enabled in self._jobs(max_jobs):
                    if not enabled:
                        counts["disabled"] += 1
                        continue
                    method = (
                        self.executor.reconcile
                        if job["state"] in {"dispatching", "unknown"}
                        else self.executor.revoke
                        if job["kind"] == "revoke"
                        else self.executor.grant
                    )
                    try:
                        outcome = await method(
                            user_id=job["user_id"], operation_id=str(job["operation_id"])
                        )
                        counts[
                            outcome
                            if outcome
                            in {
                                "succeeded",
                                "preexisting",
                                "not_claimed",
                                "unknown",
                                "rejected",
                                "not_dispatched",
                                "present_unattributed",
                                "absent",
                                "needs_review",
                            }
                            else "unavailable"
                        ] += 1
                    except Exception:
                        # Do not log a provider response, file ID or account.
                        # Durable state determines the next safe operation.
                        counts["unavailable"] += 1
        except TimeoutError:
            counts["deadline"] += 1
        return {"schema_version": "drive.permissions.worker.v1", "outcomes": dict(counts)}
