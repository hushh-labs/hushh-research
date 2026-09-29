"""Bounded, resumable bulk Drive grants and one summary signal per recipient.

The database review, manifest, effects and leases are authority. A provider
write with an uncertain result is reconciled by GET, never blindly replayed.
"""

from __future__ import annotations

import asyncio
import time
from collections import Counter
from collections.abc import Callable
from typing import Any

from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore
from hushh_mcp.services.drive_permission_executor import (
    existing_individual_permission,
    require_recipient_identity,
    verified_issuer,
)
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.drive_telemetry import drive_logger
from hushh_mcp.services.drive_work_wake import wake_drive_work
from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.external_connector_oauth_service import (
    get_external_connector_oauth_service,
)
from hushh_mcp.services.google_drive_adapter import DriveReadError
from hushh_mcp.services.google_drive_permission_adapter import (
    DrivePermissionError,
    GoogleDrivePermissionAdapter,
)
from hushh_mcp.services.push_notifications import send_user_data_push

MAX_EFFECTS_PER_SLICE = 400
MAX_CONCURRENCY = 8
_START_INTERVAL = 0.18  # <= roughly five effects/second before provider backoff
logger = drive_logger("drive_bulk_share")


class DriveBulkShareWorker:
    def __init__(
        self,
        *,
        store: DriveBulkShareStore | None = None,
        oauth=None,
        adapter: GoogleDrivePermissionAdapter | None = None,
        verify_recipient: Callable[..., Any] | None = None,
        send_push: Callable[..., int] | None = None,
        wake=None,
    ):
        self.store = store or DriveBulkShareStore()
        self.oauth = oauth or get_external_connector_oauth_service().drive()
        self.adapter = adapter or GoogleDrivePermissionAdapter()
        self.verify_recipient = verify_recipient or require_recipient_identity
        self.send_push = send_push or send_user_data_push
        self.wake = wake or wake_drive_work
        self._pace_lock = asyncio.Lock()
        self._next_start = 0.0
        self._interval = _START_INTERVAL

    async def _pace(self):
        async with self._pace_lock:
            loop = asyncio.get_running_loop()
            now = loop.time()
            delay = max(0.0, self._next_start - now)
            self._next_start = max(now, self._next_start) + self._interval
        if delay:
            await asyncio.sleep(delay)

    def _slow_down(self):
        # A provider read 429/5xx is retryable and should reduce the local
        # mutation rate; it is never a reason to loosen an authority fence.
        self._interval = min(1.5, self._interval * 1.5)

    def _speed_up(self):
        self._interval = max(_START_INTERVAL, self._interval * 0.98)

    async def _credential(self, job):
        row, credentials = await self.oauth.current_credential(
            user_id=job["user_id"], required_profile="live"
        )
        if row["connection_generation"] != job["generation"]:
            raise DriveSharingError("connection_changed")
        return credentials

    async def _settle_receipt(self, job, *, state, receipt):
        # A known Google success must be durably recorded if a brief database
        # interruption recovers. These retries write only the same receipt,
        # never another Google permission.
        for attempt in range(3):
            try:
                return await asyncio.shield(self.store.settle(job, state=state, receipt=receipt))
            except Exception:
                if attempt == 2:
                    raise
                await asyncio.sleep(0.2 * (2**attempt))

    async def _reconcile(self, job):
        try:
            credentials = await self._credential(job)
            snapshot = await self.adapter.list_permissions(
                file_id=job["file"]["id"],
                access_token=credentials["accessToken"],
                require_current=lambda: self.store.require_reconciliation_current(job),
                **(
                    {"resource_key": job["file"]["resourceKey"]}
                    if job["file"].get("resourceKey")
                    else {}
                ),
            )
            present = existing_individual_permission(snapshot, email=job["recipient"]["email"])
            await self.store.require_reconciliation_current(job)
        except (DriveReadError, DriveSharingError, DriveOAuthError, TimeoutError):
            return await self.store.release(job, error="permission_outcome_unknown", uncertain=True)
        # A later ACL match cannot establish that this process created the
        # permission. Both outcomes require a fresh owner decision to retry.
        state = "present_unattributed" if present is not None else "absent"
        await self.store.settle(
            job,
            state=state,
            safe_error_code="permission_outcome_unknown",
            receipt={
                "managed": False,
                "provenance": "reconciled_presence_only"
                if present is not None
                else "reconciled_absence_only",
            },
        )
        return state

    async def _grant(self, job):
        dispatched = False
        provider_succeeded = False
        try:
            recipient = job["recipient"]
            file = job["file"]
            await self.verify_recipient(recipient)
            credentials = await self._credential(job)
            args = {
                "file_id": file["id"],
                "access_token": credentials["accessToken"],
                "require_current": lambda: self.store.require_current(job),
            }
            if file.get("resourceKey"):
                args["resource_key"] = file["resourceKey"]
            await self.adapter.inspect_shareable(
                **args,
                expected_version="1",
                require_app_authorized=False,
                require_genai_eligibility=False,
                metadata_only=True,
                expected_name=file["name"],
                time_field="modifiedTime",
                start_time="1970-01-01T00:00:00Z",
                end_time="9999-12-31T23:59:59Z",
            )
            before = await self.adapter.list_permissions(**args)
            await self.verify_recipient(recipient)
            existing = existing_individual_permission(before, email=recipient["email"])
            if existing is not None:
                await self._settle_receipt(
                    job,
                    state="preexisting",
                    receipt={
                        "managed": False,
                        "permission_id": existing["id"],
                        "provenance": "existing_acl_before_post",
                    },
                )
                self._speed_up()
                return "preexisting"
            # No network await between durable dispatch marker and POST.
            await self.store.mark_dispatching(job)
            dispatched = True
            created = await self.adapter.create_reader(
                **args,
                verified_email=recipient["email"],
                send_notification_email=False,
            )
            provider_succeeded = True
            await self._settle_receipt(
                job,
                state="succeeded",
                receipt={
                    "managed": True,
                    "permission_id": created.permission_id,
                    "email": created.email,
                    "issuer": verified_issuer(credentials),
                    "provenance": "successful_create_after_absence_check",
                },
            )
            self._speed_up()
            return "succeeded"
        except asyncio.CancelledError:
            # The lease and dispatch marker remain durable. After a POST,
            # the next worker performs read-only reconciliation.
            raise
        except (DriveReadError, DriveSharingError, DriveOAuthError, TimeoutError) as error:
            code = str(error)
            if provider_succeeded:
                # Do not erase known provider success if receipt storage failed.
                raise
            retryable = (
                isinstance(error, DriveReadError)
                and error.retryable
                or isinstance(error, TimeoutError)
                or isinstance(error, DriveOAuthError)
                and error.status_code >= 500
                or code in {"recipient_verification_unavailable", "connection_unavailable"}
            )
            if isinstance(error, DrivePermissionError) and error.retryable:
                self._slow_down()
            uncertain = dispatched and (
                not isinstance(error, DrivePermissionError) or error.outcome_unknown
            )
            safe = (
                "permission_outcome_unknown"
                if uncertain
                else "source_changed"
                if code == "source_changed"
                else "source_not_shareable"
                if code in {"source_not_shareable", "permission_target_unavailable"}
                else "recipient_changed"
                if code == "recipient_changed"
                else "connection_changed"
                if code in {"connection_changed", "reconnect_required"}
                else "permission_catalog_incomplete"
                if code.startswith("permission_catalog")
                else "permission_rejected"
                if code == "permission_rejected"
                else "provider_unavailable"
            )
            return await self.store.release(
                job,
                error=safe,
                retryable=retryable and not uncertain,
                uncertain=uncertain,
            )

    async def _effect(self, row):
        job = await self.store.claim(
            user_id=row["user_id"],
            share_id=str(row["share_id"]),
            position=row["position"],
            recipient_user_id=row["recipient_user_id"],
        )
        if job is None:
            return "not_claimed"
        if job["state"] in {"dispatching", "unknown"}:
            return await self._reconcile(job)
        return await self._grant(job)

    async def _notification(self, row):
        job = await self.store.claim_notification(
            share_id=str(row["share_id"]), recipient_user_id=row["recipient_user_id"]
        )
        if job is None:
            return "not_claimed"
        if job.get("origin_request_id"):
            # Progressive request availability is announced by the one
            # request-level event after a confirmed grant. Older in-flight
            # bulk notices must not produce a duplicate alert.
            return await self.store.settle_notification(job, delivered=True)
        # Stable HMAC tag deduplicates presentation across devices and retries;
        # neither owner nor recipient identity is sent in the payload.
        tag = self.store.cipher.digest(
            "bulk-share-notification",
            [job.get("origin_request_id") or job["share_id"], job["recipient_user_id"]],
        )
        try:
            attempted = await asyncio.wait_for(
                asyncio.to_thread(
                    self.send_push,
                    job["recipient_user_id"],
                    notification_type="drive_bulk_share_ready",
                    title="Drive files shared",
                    body="Open One to view your files.",
                    deep_link="/one/profile/my-data",
                    notification_tag=f"drive-bulk:{tag}",
                    notification_category="ONE_DOCUMENT_SHARING",
                    data={"type": "drive_bulk_share_ready", "message_id": f"drive-bulk:{tag}"},
                    show_alert=True,
                    include_user_id=False,
                ),
                timeout=20,
            )
        except Exception:
            # A timeout might have delivered the push. Avoid a duplicate;
            # the durable recipient collection remains available in One.
            return await self.store.settle_notification(job, delivered=None)
        return await self.store.settle_notification(
            job, delivered=type(attempted) is int and attempted > 0
        )

    async def run(self, *, max_jobs=400, deadline_seconds=80):
        if (
            type(max_jobs) is not int
            or not 1 <= max_jobs <= MAX_EFFECTS_PER_SLICE
            or type(deadline_seconds) is not int
            or not 1 <= deadline_seconds <= 160
        ):
            raise ValueError("invalid bulk worker bounds")
        counts: Counter[str] = Counter()
        started = time.perf_counter()
        offered = 0
        semaphore = asyncio.Semaphore(MAX_CONCURRENCY)
        deadline = asyncio.get_running_loop().time() + deadline_seconds

        async def run_effect(row):
            async with semaphore:
                await self._pace()
                try:
                    outcome = await self._effect(row)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    outcome = "unavailable"
                counts[
                    outcome
                    if outcome
                    in {
                        "succeeded",
                        "preexisting",
                        "queued",
                        "unknown",
                        "failed",
                        "skipped",
                        "present_unattributed",
                        "absent",
                        "not_claimed",
                    }
                    else "unavailable"
                ] += 1

        async def run_notice(row):
            try:
                outcome = await self._notification(row)
            except asyncio.CancelledError:
                raise
            except Exception:
                outcome = "unavailable"
            counts[
                f"notification_{outcome}"
                if outcome in {"settled", "queued", "unavailable", "not_claimed"}
                else "notification_unavailable"
            ] += 1

        try:
            async with asyncio.timeout(deadline_seconds):
                # Previously completed recipients are notified first. A large
                # 400-effect page cannot starve the summary signal.
                ready_notices = await self.store.due_notifications(limit=8)
                await asyncio.gather(*(run_notice(row) for row in ready_notices))
                rows = await self.store.due(limit=max_jobs)
                offered = len(rows)
                effect_budget = max(1, deadline - asyncio.get_running_loop().time() - 5)
                try:
                    async with asyncio.timeout(effect_budget):
                        await asyncio.gather(*(run_effect(row) for row in rows))
                except TimeoutError:
                    counts["deadline"] += 1
                if deadline - asyncio.get_running_loop().time() >= 25:
                    notices = await self.store.due_notifications(limit=8)
                    await asyncio.gather(*(run_notice(row) for row in notices))
        except TimeoutError:
            counts["deadline"] += 1
        # Prompt another finite slice when eligible work is ready now. The
        # scheduler recovers any lost wake and handles future backoff dates.
        if counts["succeeded"] or counts["preexisting"] or counts["queued"] or counts["deadline"]:
            if await self.store.due(limit=1) or await self.store.due_notifications(limit=1):
                await self.wake("sharing")
        logger.info(
            "drive_bulk_share.worker duration_ms=%.2f offered=%d processed=%d "
            "shared=%d preexisting=%d unknown=%d unavailable=%d notices=%d",
            (time.perf_counter() - started) * 1000,
            offered,
            sum(value for key, value in counts.items() if not key.startswith("notification_")),
            counts["succeeded"],
            counts["preexisting"],
            counts["unknown"] + counts["present_unattributed"],
            counts["unavailable"],
            counts["notification_settled"],
        )
        return {"schema_version": "drive.bulk_share.worker.v1", "outcomes": dict(counts)}
