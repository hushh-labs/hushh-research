"""Finite Drive-sharing notification outbox drain.

This worker deliberately knows only the opaque event row. It does not open
request/review/permission envelopes, call Google Drive, or hold a request
transaction while it dispatches a best-effort push.
"""

from __future__ import annotations

import asyncio
from collections import Counter
from collections.abc import Callable
from typing import Any, cast
from uuid import UUID

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_share_notification_store import DriveShareNotificationStore
from hushh_mcp.services.push_notifications import send_user_data_push

PUSH_TIMEOUT_SECONDS = 20
DOCUMENT_SHARE_NOTIFICATION_TYPES = frozenset(
    {
        "document_share_request",
        "document_share_review_ready",
        "document_share_decided",
        "document_share_outcome",
        "document_share_revoked",
        "document_share_revocation_outcome",
    }
)


def _opaque_id(value: object) -> str:
    return str(UUID(str(value)))


def notification_payload(job: dict[str, Any]) -> dict[str, Any] | None:
    """Build the reviewed opaque transport payload without opening any envelope."""
    event_id = _opaque_id(job["event_id"])
    request_id = _opaque_id(job["request_id"])
    event_type = str(job["event_type"]).strip().lower()
    if event_type not in DOCUMENT_SHARE_NOTIFICATION_TYPES:
        return None
    tag = f"drive-share-event:{event_id}"
    return {
        "notification_type": event_type,
        "notification_tag": tag,
        # The fixed local review route is derived by web/native from this
        # closed type plus opaque UUID. No backend/provider URL is forwarded.
        "data": {
            "type": event_type,
            "request_id": request_id,
            "event_id": event_id,
            "message_id": tag,
        },
    }


class DriveShareNotificationWorker:
    """Claim then dispatch a small finite batch of generic Drive events."""

    def __init__(
        self,
        store: DriveShareNotificationStore | None = None,
        *,
        send_push: Callable[..., int] | None = None,
    ) -> None:
        self.store: DriveShareNotificationStore = store or DriveShareNotificationStore()
        self.send_push: Callable[..., int] = send_push or cast(
            Callable[..., int], send_user_data_push
        )

    async def _jobs(self, max_jobs: int):
        attempted = 0
        inspected: set[str] = set()
        while attempted < max_jobs and len(inspected) < max_jobs * 5:
            due = await self.store.due(min(max_jobs - attempted, max_jobs * 5 - len(inspected)))
            fresh = [item for item in due if str(item["event_id"]) not in inspected]
            if not fresh:
                return
            for item in fresh:
                event_id = str(item["event_id"])
                inspected.add(event_id)
                # A queued event is not dispatch authority. It can be
                # inspected while the recipient is outside the strict UAT
                # cohort, but it must remain queued until feature admission
                # is restored for that exact account.
                enabled = connector_feature_enabled("drive_document_sharing", str(item["user_id"]))
                if not enabled:
                    yield None, False
                    continue
                job = await self.store.claim(event_id=event_id)
                if job is not None:
                    attempted += 1
                    yield job, True
                    if attempted >= max_jobs:
                        return

    async def _dispatch(self, job: dict[str, Any]) -> str:
        payload = notification_payload(job)
        if payload is None:
            return "suppressed" if await self.store.suppress(job) else "not_claimed"
        try:
            async with asyncio.timeout(PUSH_TIMEOUT_SECONDS):
                attempted_deliveries = await asyncio.to_thread(
                    self.send_push,
                    str(job["user_id"]),
                    **payload,
                    # Required by the existing generic transport. They are
                    # fixed local presentation fallback, not event data; the
                    # reviewed client derives the tap target from type + UUID.
                    title="Document request",
                    body="Open One to review.",
                    deep_link="/one/feed",
                    notification_category="ONE_DOCUMENT_SHARING",
                    show_alert=True,
                    # Recipient routing remains server-side. The generic FCM
                    # adapter must not add the raw owner id to this opaque
                    # Drive-sharing payload.
                    include_user_id=False,
                )
        except Exception:  # noqa: BLE001 - no provider detail belongs in logs or state.
            return cast(str, await self.store.retry(job))
        # The generic FCM adapter is deliberately best-effort and reports zero
        # when Firebase is unavailable, the owner has no device token, or all
        # sends fail. That is not a delivery handoff: retain bounded retry and
        # terminal-unavailable state instead of falsely settling the event.
        if type(attempted_deliveries) is not int or attempted_deliveries <= 0:
            return cast(str, await self.store.retry(job))
        return "settled" if await self.store.settle(job) else "not_claimed"

    async def run(self, *, max_jobs: int = 8, deadline_seconds: int = 540) -> dict[str, Any]:
        if (
            type(max_jobs) is not int
            or not 1 <= max_jobs <= 20
            or type(deadline_seconds) is not int
            or not 1 <= deadline_seconds <= 540
        ):
            raise ValueError("invalid worker bounds")
        counts: Counter[str] = Counter()
        try:
            async with asyncio.timeout(deadline_seconds):
                async for job, enabled in self._jobs(max_jobs):
                    if not enabled:
                        counts["disabled"] += 1
                        continue
                    if job is None:
                        counts["not_claimed"] += 1
                        continue
                    try:
                        outcome = await self._dispatch(job)
                    except Exception:  # noqa: BLE001 - durable retry state is authoritative.
                        outcome = "unavailable"
                    counts[
                        outcome
                        if outcome
                        in {
                            "settled",
                            "settled_unavailable",
                            "retry_scheduled",
                            "suppressed",
                            "not_claimed",
                        }
                        else "unavailable"
                    ] += 1
        except TimeoutError:
            counts["deadline"] += 1
        return {"schema_version": "drive.share_notifications.worker.v1", "outcomes": dict(counts)}
