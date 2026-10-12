"""Bounded, resumable removal of bulk-created direct Drive Viewer ACLs."""

from __future__ import annotations

import asyncio
from collections import Counter

from hushh_mcp.services.drive_permission_executor import verified_issuer
from hushh_mcp.services.drive_request_bulk_removal_store import DriveRequestBulkRemovalStore
from hushh_mcp.services.drive_revocation_executor import current_recorded_viewer
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.external_connector_oauth_service import (
    get_external_connector_oauth_service,
)
from hushh_mcp.services.google_drive_adapter import DriveReadError
from hushh_mcp.services.google_drive_permission_adapter import GoogleDrivePermissionAdapter


class DriveRequestBulkRemovalWorker:
    def __init__(self, *, store=None, oauth=None, adapter=None):
        self.oauth = oauth or get_external_connector_oauth_service().drive()
        self.store = store or DriveRequestBulkRemovalStore(db=self.oauth.lifecycle.db)
        self.adapter = adapter or GoogleDrivePermissionAdapter()

    async def _credential(self, job):
        row, credentials = await self.oauth.current_credential(
            user_id=job["user_id"], required_profile="live"
        )
        if verified_issuer(credentials) != job["plan"]["issuer"]:
            raise DriveSharingError("reconnect_original_account")
        return credentials

    async def _run_job(self, row):
        job = await self.store.claim(user_id=row["user_id"], removal_id=str(row["removal_id"]))
        if job is None:
            return "not_claimed"
        plan = job["plan"]
        dispatched = job["state"] == "unknown"
        try:
            credentials = await self._credential(job)
            args = {
                "file_id": plan["file_id"],
                "access_token": credentials["accessToken"],
                "require_current": lambda: self.store.require_current(job),
                "resource_key": plan.get("resource_key"),
            }
            await self.adapter.inspect_permission_management(**args, require_app_authorized=False)
            snapshot = await self.adapter.list_permissions(**args)
            try:
                present = current_recorded_viewer(snapshot, plan)
            except DriveSharingError:
                await self.store.settle(job, state="needs_review", code="permission_changed")
                return "needs_review"
            if present is None:
                await self.store.settle(job, state="absent")
                return "absent"
            if dispatched:
                # A timed-out DELETE may have succeeded and another actor may
                # have restored access. Presence alone cannot authorize a retry.
                await self.store.settle(job, state="needs_review", code="outcome_unknown")
                return "needs_review"
            await self.store.mark_dispatching(job)
            dispatched = True
            await self.adapter.remove_recorded_permission(
                **args, recorded_permission_id=plan["permission_id"]
            )
            # A successful DELETE response is not the final user-visible
            # outcome. Confirm the recorded direct ACL is absent; a timeout
            # here becomes GET-only reconciliation, never another DELETE.
            after = await self.adapter.list_permissions(**args)
            if any(item["id"] == plan["permission_id"] for item in after.permissions):
                await self.store.settle(job, state="needs_review", code="permission_still_present")
                return "needs_review"
            await self.store.settle(job, state="removed")
            return "removed"
        except (DriveReadError, TimeoutError) as error:
            if isinstance(error, DriveSharingError) and str(error) == "reconnect_original_account":
                await self.store.settle(
                    job, state="needs_review", code="reconnect_original_account"
                )
                return "needs_review"
            await self.store.settle(
                job,
                state="unknown" if dispatched else "queued",
                code="permission_outcome_unknown" if dispatched else "reconnect_required",
            )
            return "unknown" if dispatched else "queued"

    async def run(self, *, max_jobs=20, deadline_seconds=75):
        if type(max_jobs) is not int or not 1 <= max_jobs <= 20:
            raise ValueError("invalid bulk removal bounds")
        if type(deadline_seconds) is not int or not 1 <= deadline_seconds <= 160:
            raise ValueError("invalid bulk removal deadline")
        counts = Counter()
        try:
            async with asyncio.timeout(deadline_seconds):
                counts["materialized"] += await self.store.materialize(limit=100)
                for row in await self.store.due(limit=max_jobs):
                    try:
                        counts[await self._run_job(row)] += 1
                    except Exception:
                        # The durable lease is intentionally left for later
                        # read-only reconciliation. Never log private details.
                        counts["unavailable"] += 1
        except TimeoutError:
            counts["deadline"] += 1
        return {"schema_version": "drive.bulk_removals.worker.v1", "outcomes": dict(counts)}
