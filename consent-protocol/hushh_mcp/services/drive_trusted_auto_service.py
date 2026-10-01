"""Bounded automatic Drive request sharing for a current accepted Trusted peer.

The saved request carries an encrypted creation-time policy marker. Every
search and batch rechecks the current pair, Trusted roster and the owner's
separate background Drive setting. Google grants remain in the durable bulk
worker; this service never calls the provider permission API.
"""

from __future__ import annotations

import asyncio

from hushh_mcp.services.drive_bulk_share_service import DriveBulkShareService
from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore
from hushh_mcp.services.drive_request_bulk_service import DriveRequestBulkService
from hushh_mcp.services.drive_request_payment_service import DriveRequestPaymentService
from hushh_mcp.services.drive_sharing_store import DriveSharingStore
from hushh_mcp.services.drive_work_wake import wake_drive_work
from hushh_mcp.services.google_drive_adapter import DriveReadError


def _defer_code(error: BaseException) -> str:
    if str(error) == "background_preparation_required":
        return "background_preparation_required"
    if str(error) == "trusted_request_unavailable":
        return "trusted_relationship_changed"
    return "preparation_unavailable"


class DriveTrustedAutoService:
    def __init__(self, *, sharing=None, bulk=None, payment=None, wake=None):
        self.sharing = sharing or DriveSharingStore()
        self.bulk = bulk or DriveBulkShareStore(db=self.sharing.db)
        self.payment = payment or DriveRequestPaymentService(db=self.sharing.db)
        self.wake = wake or wake_drive_work

    async def _payment_ready(self, *, user_id: str, request_id: str, share_id: str) -> bool:
        state = await self.payment.ensure_payment_for_frozen_batch(
            user_id=user_id, request_id=request_id, share_id=share_id
        )
        if state["status"] == "paid":
            return True
        # The order and payment-ready event are committed. Prompt the sharing
        # drain to deliver its notification; the scheduled drain remains backup.
        await self.wake("sharing")
        return False

    def _authority(self, user_id: str, request_id: str):
        async def require_current():
            await self.sharing.trusted_request_authority(user_id=user_id, request_id=request_id)

        return require_current

    async def search_authority_for_job(self, *, user_id: str, job_id: str):
        """Bind a queued search slice to its current Trusted/background policy."""
        request_id = await self.sharing.trusted_request_for_job(user_id=user_id, job_id=job_id)
        if request_id is None:
            return None
        require_current = self._authority(user_id, request_id)

        async def guarded():
            try:
                await require_current()
            except (DriveReadError, TimeoutError) as error:
                await self.sharing.defer_trusted_search(
                    user_id=user_id, request_id=request_id, code=_defer_code(error)
                )
                raise

        return guarded

    async def start_pending(
        self, *, max_jobs: int = 1, deadline_at: float | None = None
    ) -> dict[str, int]:
        """Plan new trusted requests while reserving time for worker continuation."""
        outcomes = {"started": 0, "deferred": 0}
        for item in await self.sharing.due_trusted_searches(limit=min(20, max_jobs * 4)):
            if outcomes["started"] >= max_jobs:
                break
            if deadline_at is not None and deadline_at - asyncio.get_running_loop().time() < 20:
                await self.wake("suggestions")
                break
            user_id, request_id = item["user_id"], item["request_id"]
            require_current = self._authority(user_id, request_id)
            try:
                await require_current()
                service = DriveRequestBulkService(
                    sharing=self.sharing,
                    bulk=self.bulk,
                    require_owner=require_current,
                    wake=self.wake,
                )
                if deadline_at is None:
                    await service.start_search(
                        user_id=user_id,
                        request_id=request_id,
                        authority_mode="trusted_auto",
                    )
                else:
                    async with asyncio.timeout_at(deadline_at - 15):
                        await service.start_search(
                            user_id=user_id,
                            request_id=request_id,
                            authority_mode="trusted_auto",
                        )
                outcomes["started"] += 1
                # The durable search may have no committed rows yet. Wake its
                # own slice before spending this invocation on empty batches.
                await self.wake("suggestions")
            except (DriveReadError, TimeoutError) as error:
                await self.sharing.defer_trusted_search(
                    user_id=user_id, request_id=request_id, code=_defer_code(error)
                )
                outcomes["deferred"] += 1
        return outcomes

    async def share_available(self, *, user_id: str, request_id: str, max_batches: int = 8) -> int:
        """Queue at most eight 25-file batches; wake again if more are committed."""
        if type(max_batches) is not int or not 1 <= max_batches <= 16:
            raise ValueError("invalid trusted batch bound")
        require_current = self._authority(user_id, request_id)
        await require_current()
        request_bulk = DriveRequestBulkService(
            sharing=self.sharing,
            bulk=self.bulk,
            require_owner=require_current,
            wake=self.wake,
        )
        share_service = DriveBulkShareService(
            store=self.bulk, require_owner=require_current, wake=self.wake
        )
        queued = 0
        remaining = []
        # A worker may have died after freezing an exact batch but before its
        # approval. Resume that immutable review before claiming new rows.
        pending = await self.bulk.pending_request_reviews(
            user_id=user_id, request_id=request_id, limit=max_batches
        )
        for review in pending:
            await require_current()
            if not await self._payment_ready(
                user_id=user_id, request_id=request_id, share_id=review["shareId"]
            ):
                return queued
            await share_service.approve(
                user_id=user_id,
                share_id=review["shareId"],
                revision=review["revision"],
                review_digest=review["reviewDigest"],
                approval_source="trusted_auto",
            )
            queued += 1
        for _ in range(max_batches - queued):
            await require_current()
            positions = await self.bulk.unclaimed_positions(
                user_id=user_id, request_id=request_id, limit=25
            )
            if not positions:
                break
            review = await request_bulk.prepare(
                user_id=user_id, request_id=request_id, positions=positions
            )
            await require_current()
            if not await self._payment_ready(
                user_id=user_id, request_id=request_id, share_id=review["shareId"]
            ):
                return queued
            await share_service.approve(
                user_id=user_id,
                share_id=review["shareId"],
                revision=review["revision"],
                review_digest=review["reviewDigest"],
                approval_source="trusted_auto",
            )
            queued += 1
        if queued == max_batches:
            # A completed search may have hundreds of rows remaining. The
            # scheduler is recovery; this bounded wake keeps sharing moving.
            # Check while the request is still pending: refresh_request may
            # close a fully resolved request, making unclaimed_positions fail.
            remaining = await self.bulk.pending_request_reviews(
                user_id=user_id, request_id=request_id, limit=1
            ) or await self.bulk.unclaimed_positions(
                user_id=user_id, request_id=request_id, limit=1
            )
        await self.bulk.refresh_request(user_id=user_id, request_id=request_id)
        if remaining:
            await self.wake("suggestions")
        return queued

    async def after_search_slice(self, *, user_id: str, job_id: str) -> int:
        request_id = await self.sharing.trusted_request_for_job(user_id=user_id, job_id=job_id)
        if request_id is None:
            return 0
        try:
            return await self.share_available(user_id=user_id, request_id=request_id)
        except (DriveReadError, TimeoutError) as error:
            await self.sharing.defer_trusted_search(
                user_id=user_id, request_id=request_id, code=_defer_code(error)
            )
            return 0

    async def continue_batches(self, *, max_jobs: int = 2) -> int:
        """Continue after search completion, when the search job is no longer due."""
        count = 0
        for item in await self.sharing.due_trusted_batches(limit=min(20, max_jobs * 4)):
            if count >= max_jobs:
                break
            try:
                await self.share_available(user_id=item["user_id"], request_id=item["request_id"])
            except (DriveReadError, TimeoutError) as error:
                await self.sharing.defer_trusted_search(
                    user_id=item["user_id"],
                    request_id=item["request_id"],
                    code=_defer_code(error),
                )
            count += 1
        return count
