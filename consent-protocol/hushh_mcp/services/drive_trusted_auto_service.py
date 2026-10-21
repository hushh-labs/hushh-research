"""Bounded automatic Drive request sharing for a current accepted Trusted peer.

The saved request carries an encrypted creation-time policy marker. Every
search and batch rechecks the current pair, Trusted roster and the owner's
separate background Drive setting. Google grants remain in the durable bulk
worker; this service only reads recipient permissions before checkout.
"""

from __future__ import annotations

import asyncio

from hushh_mcp.services.drive_bulk_share_service import DriveBulkShareService
from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore
from hushh_mcp.services.drive_request_bulk_service import (
    DriveRequestBulkService,
    _deterministic_statement_plan,
)
from hushh_mcp.services.drive_request_payment_service import DriveRequestPaymentService
from hushh_mcp.services.drive_sharing_store import OWNER_SETUP_CODES, DriveSharingStore
from hushh_mcp.services.drive_work_wake import wake_drive_work
from hushh_mcp.services.google_drive_adapter import DriveReadError


def _defer_code(error: BaseException) -> str:
    if str(error) in OWNER_SETUP_CODES:
        return str(error)
    if str(error) in {"package_existing_access_requires_review", "payment_not_ready"}:
        return str(error)
    if str(error) == "date_range_required":
        return "date_range_required"
    if str(error) == "background_preparation_required":
        return "background_preparation_required"
    if str(error) == "trusted_request_unavailable":
        return "trusted_relationship_changed"
    if str(error) == "drive_share_in_progress":
        # Another request's batch holds the owner's Drive. Wait; not a failure.
        return "share_in_progress"
    if str(error) == "search_in_progress":
        # Another of the owner's searches is running (one at a time), or this
        # search's results are not final yet. Wait; not a failed start, so it
        # never counts toward the three attempts that park a request for good.
        return "share_in_progress"
    return "preparation_unavailable"


class DriveTrustedAutoService:
    def __init__(self, *, sharing=None, bulk=None, payment=None, wake=None):
        self.sharing = sharing or DriveSharingStore()
        self.bulk = bulk or DriveBulkShareStore(db=self.sharing.db)
        self.payment = payment or DriveRequestPaymentService(db=self.sharing.db)
        self.wake = wake or wake_drive_work

    async def _undated_packet_current(self, *, user_id, context):
        from hushh_mcp.services.drive_owner_search_store import validate_reusable_packet
        from hushh_mcp.services.drive_packet_store import DrivePacketStore

        binding = context.get("reusablePacket")
        if not binding:
            raise DriveReadError("date_range_required")
        manifest = await DrivePacketStore(db=self.sharing.db).current_packet_manifest(
            owner_user_id=user_id, packet_id=binding["packetId"], version=binding["version"]
        )
        validate_reusable_packet(
            manifest, binding, user_id, approved_terms=context.get("packageAllowed") is True
        )

    async def preflight_package(
        self, *, user_id: str, request_id: str, inspect_access: bool = True
    ):
        """Check source versions and recipient access before any paid delivery."""
        from hushh_mcp.services.drive_package_access_preflight import DrivePackageAccessPreflight

        files = await self.bulk.package_sources(user_id=user_id, request_id=request_id)
        if not files:
            return None
        if not inspect_access:
            from hushh_mcp.services.drive_live_reader import DriveLiveReader

            require_current = self._authority(user_id, request_id)
            reader = DriveLiveReader(user_id=user_id, require_access=require_current)
            credential = await reader._credential()
            semaphore = asyncio.Semaphore(4)

            async def verify(file):
                async with semaphore:
                    await require_current()
                    if reader._generation != file["generation"]:
                        raise DriveReadError("connection_changed")
                    actual = await reader.adapter.get_share_metadata(
                        file_id=file["id"],
                        access_token=credential["accessToken"],
                        **(
                            {"resource_key": file["resourceKey"]} if file.get("resourceKey") else {}
                        ),
                    )
                    if actual.version != file["sourceVersion"] or actual.name != file["name"]:
                        raise DriveReadError("source_changed")
                    await require_current()

            async with asyncio.timeout(40):
                await asyncio.gather(*(verify(file) for file in files))
            return None
        result = await DrivePackageAccessPreflight(sharing=self.sharing, bulk=self.bulk).inspect(
            user_id=user_id,
            request_id=request_id,
            require_current=self._authority(user_id, request_id),
            files=files,
        )
        if result.status == "mixed":
            raise DriveReadError("package_existing_access_requires_review")
        if result.status == "unknown":
            raise DriveReadError("payment_not_ready")
        return result

    async def _payment_ready(self, *, user_id: str, request_id: str, share_id: str) -> bool:
        state = await self.payment.ensure_payment_for_frozen_batch(
            user_id=user_id, request_id=request_id, share_id=share_id
        )
        if state["status"] == "paid":
            return True
        if state.get("orderCreated") is True:
            # This call committed the order. The sharing drain binds a Stripe
            # deadline before it writes and dispatches the payment-ready
            # notification. An order that already existed was woken when it
            # was created (here or at the owner's Allow); every later status
            # change wakes its own lane (Checkout bind, Stripe webhook). Waking
            # again on each page handoff of an unpaid order only floods the
            # sharing drain; the scheduled drain stays the recovery path.
            context = await self.sharing.request_bulk_context(
                user_id=user_id, request_id=request_id
            )
            await self.wake("v1" if context.get("v1LiveRequest") else "sharing")
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
        require_current = None
        dates_checked = False

        async def guarded():
            nonlocal dates_checked, require_current
            try:
                if require_current is None:
                    # Resolve request state after run_one claims the job so a
                    # closed request reaches its lease-release error boundary.
                    context = await self.sharing.request_bulk_context(
                        user_id=user_id, request_id=request_id
                    )
                    require_current = (
                        (
                            lambda: self.sharing.package_preparation_authority(
                                user_id=user_id, request_id=request_id
                            )
                        )
                        if context.get("agentPackageRequired")
                        else self._authority(user_id, request_id)
                    )
                await require_current()
                if not dates_checked:
                    context = await self.sharing.request_bulk_context(
                        user_id=user_id, request_id=request_id
                    )
                    purpose = context["purpose"]
                    if not (purpose.get("periodStart") and purpose.get("periodEnd")):
                        await self._undated_packet_current(user_id=user_id, context=context)
                    dates_checked = True
            except (DriveReadError, TimeoutError) as error:
                await self.sharing.defer_trusted_search(
                    user_id=user_id, request_id=request_id, code=_defer_code(error)
                )
                raise

        return guarded

    async def start_pending(
        self, *, max_jobs: int = 1, deadline_at: float | None = None, v1_only: bool = False
    ) -> dict[str, int]:
        """Plan new trusted requests while reserving time for worker continuation."""
        outcomes = {"started": 0, "deferred": 0}
        for item in await self.sharing.due_trusted_searches(
            limit=min(20, max_jobs * 4), **({"v1_only": True} if v1_only else {})
        ):
            if outcomes["started"] >= max_jobs:
                break
            if deadline_at is not None and deadline_at - asyncio.get_running_loop().time() < 20:
                await self.wake("v1" if v1_only else "suggestions")
                break
            user_id, request_id = item["user_id"], item["request_id"]
            package = item.get("agent_package") is True
            require_current = (
                (
                    lambda user_id=user_id, request_id=request_id: (
                        self.sharing.package_preparation_authority(
                            user_id=user_id, request_id=request_id
                        )
                    )
                )
                if package
                else self._authority(user_id, request_id)
            )
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
                        authority_mode="agent_package" if package else "trusted_auto",
                        after_page=None if package else self.after_search_page,
                    )
                else:
                    async with asyncio.timeout_at(deadline_at - 15):
                        await service.start_search(
                            user_id=user_id,
                            request_id=request_id,
                            authority_mode="agent_package" if package else "trusted_auto",
                            after_page=None if package else self.after_search_page,
                        )
                outcomes["started"] += 1
                # The durable search may have no committed rows yet. Wake its
                # own slice before spending this invocation on empty batches.
                await self.wake("v1" if v1_only else "suggestions")
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
        context = await self.sharing.request_bulk_context(user_id=user_id, request_id=request_id)
        if (
            context.get("v1LiveRequest")
            and context.get("trustedAuto")
            and not context.get("packageAllowed")
        ):
            if not await self.sharing.freeze_trusted_selection(
                user_id=user_id, request_id=request_id
            ):
                return 0
            context = await self.sharing.request_bulk_context(
                user_id=user_id, request_id=request_id
            )
        require_current = self._authority(user_id, request_id)
        await require_current()
        purpose = context["purpose"]
        if not (purpose.get("periodStart") and purpose.get("periodEnd")):
            await self._undated_packet_current(user_id=user_id, context=context)
        if (
            not context.get("agentPackageRequired")
            and not context.get("autoshare")
            and _deterministic_statement_plan(purpose)
        ):
            # A saved one-query job may still carry the older file-activity
            # marker until its lease is replanned. It cannot auto-select files.
            # An autoshare request passes only with its own date selection:
            # any other search needs owner review below, and approve refuses
            # a statement grant without that selection.
            return 0
        if await self.sharing.request_owner_review_required(user_id=user_id, request_id=request_id):
            # Discovery still runs under current background authority. Its
            # candidates need exact owner review before a batch or order exists.
            return 0
        request_bulk = DriveRequestBulkService(
            sharing=self.sharing,
            bulk=self.bulk,
            require_owner=require_current,
            wake=self.wake,
        )
        share_service = DriveBulkShareService(
            store=self.bulk, require_owner=require_current, wake=self.wake
        )
        if (
            context.get("autoshare")
            and not context.get("agentPackageRequired")
            and await self.bulk.final_autoshare_access_candidate(
                user_id=user_id, request_id=request_id
            )
        ):
            # Freeze the final bounded selection before waiting for payment;
            # otherwise a second batch can never enter the all-existing proof.
            for _ in range(5):
                await require_current()
                positions = await self.bulk.unclaimed_positions(
                    user_id=user_id, request_id=request_id, limit=25
                )
                if not positions:
                    break
                await request_bulk.prepare(
                    user_id=user_id, request_id=request_id, positions=positions
                )
            sources = await self.bulk.autoshare_checkout_sources(
                user_id=user_id, request_id=request_id
            )
            if sources["complete"]:
                from hushh_mcp.services.drive_package_access_preflight import (
                    DrivePackageAccessPreflight,
                )

                access = None
                try:
                    access = await DrivePackageAccessPreflight(
                        sharing=self.sharing, bulk=self.bulk
                    ).inspect(
                        user_id=user_id,
                        request_id=request_id,
                        require_current=require_current,
                        files=sources["files"],
                    )
                except TimeoutError:
                    pass
                except DriveReadError as error:
                    if not error.retryable:
                        raise
                # The optional waiver check cannot permanently park the paid
                # flow on a transient read. Authority still has to be current.
                await require_current()
                if access is not None and access.status == "all_existing":
                    await self.payment.complete_existing_autoshare(
                        user_id=user_id, request_id=request_id, result=access
                    )
                    return 0
        if context.get("agentPackageRequired"):
            payment_state = await self.payment.payment_state(
                requester_user_id=context["recipientUserId"], request_id=request_id
            )
            # Confirmed payment is durable authority to resume interrupted
            # delivery. Its own earlier grants are expected existing access.
            paid = payment_state["status"] == "paid"
            access = await self.preflight_package(
                user_id=user_id, request_id=request_id, inspect_access=not paid
            )
            # The whole purchased set exists before any order is created.
            for _ in range(5):
                await require_current()
                positions = await self.bulk.unclaimed_positions(
                    user_id=user_id, request_id=request_id, limit=25
                )
                if not positions:
                    break
                await request_bulk.prepare(
                    user_id=user_id, request_id=request_id, positions=positions
                )
            if await self.bulk.unclaimed_positions(user_id=user_id, request_id=request_id, limit=1):
                raise DriveReadError("package_incomplete")
            if access is not None and access.status == "all_existing":
                from hushh_mcp.services.drive_package_existing_access_store import (
                    DrivePackageExistingAccessStore,
                )

                # Freezing reviews is separate I/O: read the ACLs again rather
                # than completing from a snapshot that may have been revoked.
                fresh = await self.preflight_package(user_id=user_id, request_id=request_id)
                if fresh is None or fresh.status != "all_existing":
                    raise DriveReadError("package_existing_access_requires_review")
                await DrivePackageExistingAccessStore(
                    db=self.bulk.db, cipher=self.bulk.cipher
                ).complete(user_id=user_id, request_id=request_id, result=fresh)
                await self.wake("sharing")
                return 0
            max_batches = max(max_batches, 5)
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

    async def after_search_page(self, *, user_id: str, job_id: str) -> int:
        """Hand off one committed provider page before searching for more."""
        # A provider page has at most 100 matches. Keep each immutable share
        # at 25 files; sparse pages are available without waiting for the scan.
        return await self.after_search_slice(user_id=user_id, job_id=job_id, max_batches=4)

    async def after_search_slice(self, *, user_id: str, job_id: str, max_batches: int = 8) -> int:
        request_id = await self.sharing.trusted_request_for_job(user_id=user_id, job_id=job_id)
        if request_id is None:
            return 0
        context = await self.sharing.request_bulk_context(user_id=user_id, request_id=request_id)
        if context.get("agentPackageRequired") and not context.get("packageAllowed"):
            await self.wake("suggestions")
            return 0
        try:
            return await self.share_available(
                user_id=user_id, request_id=request_id, max_batches=max_batches
            )
        except (DriveReadError, TimeoutError) as error:
            await self.sharing.defer_trusted_search(
                user_id=user_id, request_id=request_id, code=_defer_code(error)
            )
            return 0

    async def continue_batches(self, *, max_jobs: int = 2, v1_only: bool = False) -> int:
        """Continue after search completion, when the search job is no longer due."""
        count = 0
        # due_trusted_batches rotates each selected row. Claim only work this
        # invocation can process so older unpaid or busy requests cannot keep
        # a paid frozen review behind them indefinitely.
        for item in await self.sharing.due_trusted_batches(
            limit=max_jobs, **({"v1_only": True} if v1_only else {})
        ):
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
