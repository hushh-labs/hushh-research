"""Finite Drive-sharing notification outbox drain.

This worker deliberately knows only the opaque event row. It does not open
request/review/permission envelopes, call Google Drive, or hold a request
transaction while it dispatches a best-effort push.
"""

from __future__ import annotations

import asyncio
import logging
from collections import Counter
from collections.abc import Callable
from typing import Any, cast
from uuid import UUID

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_share_notification_store import (
    DriveQueryNotificationStore,
    DriveShareNotificationStore,
)
from hushh_mcp.services.push_notifications import send_user_data_push

logger = logging.getLogger(__name__)

PUSH_TIMEOUT_SECONDS = 20
# Fixed local presentation per closed type. Never a file name, person,
# request purpose or provider text; web and native render the same words.
# The three question types come from drive_query_events (migration 244);
# their request_id is a Drive question, not a document share request.
DOCUMENT_SHARE_NOTIFICATION_COPY = {
    "document_share_request": ("Document request", "Open One to review."),
    "document_share_review_ready": ("Files ready to review", "Open One to choose what to share."),
    "document_share_decided": ("Drive sharing update", "Open One to see the latest."),
    "document_share_outcome": ("Drive sharing finished", "Open One to see the shared files."),
    "document_share_revoked": ("Drive access changed", "Open One to see what changed."),
    "document_share_revocation_outcome": ("Drive access changed", "Open One to see what changed."),
    "document_share_question": (
        "Drive question",
        "Someone asked about your Drive. Open One to review.",
    ),
    "document_share_answered": ("Drive question answered", "Open One to see the answer."),
    "document_share_declined": ("Drive question declined", "Open One for details."),
}
DOCUMENT_SHARE_NOTIFICATION_TYPES = frozenset(DOCUMENT_SHARE_NOTIFICATION_COPY)


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
        stores: tuple[DriveShareNotificationStore, ...] | None = None,
    ) -> None:
        # Document shares first, then Drive questions. An explicit single
        # store keeps the one-outbox behaviour for existing callers.
        self.stores: tuple[DriveShareNotificationStore, ...] = stores or (
            (store,)
            if store is not None
            else (
                DriveShareNotificationStore(),
                DriveQueryNotificationStore(),
            )
        )
        self.store: DriveShareNotificationStore = self.stores[0]
        self.send_push: Callable[..., int] = send_push or cast(
            Callable[..., int], send_user_data_push
        )

    async def _jobs(self, max_jobs: int, store: DriveShareNotificationStore | None = None):
        store = store or self.store
        attempted = 0
        inspected: set[str] = set()
        while attempted < max_jobs and len(inspected) < max_jobs * 5:
            due = await store.due(min(max_jobs - attempted, max_jobs * 5 - len(inspected)))
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
                job = await store.claim(event_id=event_id)
                if job is not None:
                    job = {**job, "_store": store}
                    attempted += 1
                    yield job, True
                    if attempted >= max_jobs:
                        return

    async def _dispatch(self, job: dict[str, Any]) -> str:
        store: DriveShareNotificationStore = job.get("_store") or self.store
        payload = notification_payload(job)
        if payload is None:
            return "suppressed" if await store.suppress(job) else "not_claimed"
        title, body = DOCUMENT_SHARE_NOTIFICATION_COPY[payload["notification_type"]]
        try:
            async with asyncio.timeout(PUSH_TIMEOUT_SECONDS):
                attempted_deliveries = await asyncio.to_thread(
                    self.send_push,
                    str(job["user_id"]),
                    **payload,
                    # Required by the existing generic transport. They are
                    # fixed local presentation fallback, not event data; the
                    # reviewed client derives the tap target from type + UUID.
                    title=title,
                    body=body,
                    deep_link="/one/feed",
                    notification_category="ONE_DOCUMENT_SHARING",
                    show_alert=True,
                    # Recipient routing remains server-side. The generic FCM
                    # adapter must not add the raw owner id to this opaque
                    # Drive-sharing payload.
                    include_user_id=False,
                )
        except Exception:  # noqa: BLE001 - no provider detail belongs in logs or state.
            return cast(str, await store.retry(job))
        # The generic FCM adapter is deliberately best-effort and reports zero
        # when Firebase is unavailable, the owner has no device token, or all
        # sends fail. That is not a delivery handoff: retain bounded retry and
        # terminal-unavailable state instead of falsely settling the event.
        if type(attempted_deliveries) is not int or attempted_deliveries <= 0:
            return cast(str, await store.retry(job))
        return "settled" if await store.settle(job) else "not_claimed"

    async def run(self, *, max_jobs: int = 8, deadline_seconds: int = 540) -> dict[str, Any]:
        if (
            type(max_jobs) is not int
            or not 1 <= max_jobs <= 20
            or type(deadline_seconds) is not int
            or not 1 <= deadline_seconds <= 540
        ):
            raise ValueError("invalid worker bounds")
        counts: Counter[str] = Counter()
        attempted = 0
        try:
            async with asyncio.timeout(deadline_seconds):
                for index, store in enumerate(self.stores):
                    if attempted >= max_jobs:
                        break
                    # Reserve a share of this finite sweep for later outboxes;
                    # a busy document queue must not starve Drive answers.
                    budget = max(1, (max_jobs - attempted) // (len(self.stores) - index))
                    async for job, enabled in self._jobs(budget, store):
                        if not enabled:
                            counts["disabled"] += 1
                            continue
                        if job is None:
                            counts["not_claimed"] += 1
                            continue
                        attempted += 1
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
        if set(counts) - {"disabled", "not_claimed"}:
            # Aggregate outcome counts only: no identity, request or type. A
            # settled count is a dispatch hand-off, never device receipt. A
            # held (disabled) event alone is not logged every minute.
            logger.info(
                "drive_notify.run %s",
                " ".join(f"{key}={value}" for key, value in sorted(counts.items())),
            )
        return {"schema_version": "drive.share_notifications.worker.v1", "outcomes": dict(counts)}
