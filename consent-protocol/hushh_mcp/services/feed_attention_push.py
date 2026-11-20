"""A bare "One has something for you" push when a notable feed row appears.

This is a wake-up only, like ``one_reply``. The title, body and data are fixed
strings plus the opaque feed row id; no event type, name, amount or other text
reaches Firebase or the lock screen. What One actually says about the update is
written later, in an ordinary chat turn the person's app starts after they tap
the push and unlock (``hushh_mcp.one_adk.feed_attention``), so the message is
generated with their chat key present and sealed into their conversation. The
server never pre-writes or stores it.

How a row becomes a push:

* **Notable.** Feed rows carry no importance signal, so a conservative closed
  list of event types is used: things that went wrong or need the person, from
  domains that have no push of their own. Consent, connection, location and
  Drive-share rows already send dedicated pushes and are never repeated here.
* **Capped.** At most ``DAILY_CAP`` pushes per person in any 24 hours, counted
  over ``one_attention_ledger`` under a per-person advisory lock, so two server
  instances cannot both spend the last slot. A capped row is recorded as
  ``throttled`` and never reconsidered.
* **Once.** The ledger's primary key (person, kind, feed row) makes the claim
  idempotent across instances and restarts.
* **Opt-out.** A person who turned notifications off has no registered device
  token, and ``send_user_data_push`` sends nothing; the row is then recorded as
  ``no_device`` and does not count toward the cap. There is no separate
  server-side notification preference to consult today.

The sweep reads only rows created in the last hour, inside a bounded id window
at the head of ``feed_events`` (primary-key index), so it never scans history.
It is off unless ``ONE_FEED_ATTENTION_PUSH_ENABLED`` is true.
"""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from hushh_mcp.branding import PRODUCT_NAME

logger = logging.getLogger(__name__)

FEED_ATTENTION_NOTIFICATION_TYPE = "one_feed_attention"
FEED_ATTENTION_TITLE = PRODUCT_NAME
FEED_ATTENTION_BODY = "One has something for you"
FEED_ATTENTION_CATEGORY = "ONE_CHAT"
# Only native devices: the tap opens the app, which then asks One after unlock.
FEED_ATTENTION_PLATFORMS = frozenset({"ios", "android"})
LEDGER_KIND = "feed_attention_push"
DAILY_CAP = 2
SWEEP_INTERVAL_SECONDS = 60.0
SWEEP_BATCH = 200
# Head-of-table window, in feed rows, the sweep may look back through.
SWEEP_ID_WINDOW = 2000
_PUSH_TIMEOUT_SECONDS = 10.0
ENABLE_ENV = "ONE_FEED_ATTENTION_PUSH_ENABLED"

# Conservative and closed. Each needs the person or reports something that went
# wrong, and none has a push of its own today.
NOTABLE_EVENT_TYPES: frozenset[str] = frozenset(
    {
        "mail_information_request_detected",
        "mail_reconnect_required",
        "mail_message_failed",
        "mail_delivery_unconfirmed",
        "calendar_reconnect_required",
        "kai_analysis_completed",
        "kyc_status_changed",
    }
)


def is_notable(event_type: object) -> bool:
    return isinstance(event_type, str) and event_type in NOTABLE_EVENT_TYPES


def feed_attention_enabled() -> bool:
    return os.getenv(ENABLE_ENV, "").strip().lower() in {"1", "true", "yes", "on"}


def feed_attention_push(item_id: str) -> dict[str, Any]:
    """The complete push for one feed row. Nothing here is derived from the row's content."""
    return {
        "notification_type": FEED_ATTENTION_NOTIFICATION_TYPE,
        "title": FEED_ATTENTION_TITLE,
        "body": FEED_ATTENTION_BODY,
        # The client derives the tap target from type plus the id; this fixed
        # fallback is only for older builds that do not know the type.
        "deep_link": "/one/feed",
        "notification_tag": f"{FEED_ATTENTION_NOTIFICATION_TYPE}:{item_id}",
        "notification_category": FEED_ATTENTION_CATEGORY,
        "data": {"feed_item_id": item_id, "message_id": uuid.uuid4().hex},
        "show_alert": True,
        # Recipient routing stays server-side; the account id never reaches the device.
        "include_user_id": False,
        "platforms": FEED_ATTENTION_PLATFORMS,
    }


@dataclass(frozen=True)
class FeedCandidate:
    item_id: str
    user_id: str
    event_type: str


class FeedAttentionStore(Protocol):
    async def candidates(self, *, event_types: list[str], limit: int) -> list[FeedCandidate]: ...

    async def claim(self, *, user_id: str, item_id: str, daily_cap: int) -> str | None: ...

    async def settle(self, *, user_id: str, item_id: str, outcome: str) -> None: ...

    async def prune(self) -> None: ...


Sender = Callable[[str, dict[str, Any]], Awaitable[int]]

_CANDIDATES_SQL = """
SELECT fe.id::TEXT AS item_id, fe.user_id, fe.event_type
FROM feed_events AS fe
WHERE fe.id > (SELECT COALESCE(MAX(id), 0) FROM feed_events) - $3
  AND fe.event_type = ANY($1::TEXT[])
  AND fe.read_at IS NULL
  AND fe.created_at > NOW() - INTERVAL '1 hour'
  AND NOT EXISTS (
    SELECT 1 FROM one_attention_ledger AS l
    WHERE l.user_id = fe.user_id AND l.kind = 'feed_attention_push'
      AND l.subject_ref = fe.id::TEXT
  )
ORDER BY fe.id
LIMIT $2
"""

_SENT_TODAY_SQL = """
SELECT COUNT(*) FROM one_attention_ledger
WHERE user_id = $1 AND kind = 'feed_attention_push' AND outcome = 'sent'
  AND created_at > NOW() - INTERVAL '24 hours'
"""

_CLAIM_SQL = """
INSERT INTO one_attention_ledger (user_id, kind, subject_ref, outcome)
SELECT $1, 'feed_attention_push', $2, $3
WHERE EXISTS (SELECT 1 FROM actor_profiles WHERE user_id = $1)
ON CONFLICT (user_id, kind, subject_ref) DO NOTHING
RETURNING outcome
"""

_SETTLE_SQL = """
UPDATE one_attention_ledger SET outcome = $3, updated_at = NOW()
WHERE user_id = $1 AND kind = 'feed_attention_push' AND subject_ref = $2
"""

_PRUNE_SQL = """
DELETE FROM one_attention_ledger
WHERE kind = 'feed_attention_push' AND created_at < NOW() - INTERVAL '30 days'
"""

_OFFERED_ITEM_SQL = """
SELECT fe.id, fe.source_domain, fe.event_type, fe.actor_label, fe.metadata,
       fe.read_at, fe.created_at
FROM feed_events AS fe
JOIN one_attention_ledger AS l
  ON l.user_id = fe.user_id AND l.kind = 'feed_attention_push'
 AND l.subject_ref = fe.id::TEXT AND l.outcome = 'sent'
WHERE fe.user_id = $1 AND fe.id = $2
"""


class PostgresFeedAttentionStore:
    async def candidates(self, *, event_types: list[str], limit: int) -> list[FeedCandidate]:
        from db.connection import get_pool

        pool = await get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(_CANDIDATES_SQL, event_types, limit, SWEEP_ID_WINDOW)
        return [
            FeedCandidate(
                item_id=str(row["item_id"]),
                user_id=str(row["user_id"]),
                event_type=str(row["event_type"]),
            )
            for row in rows
        ]

    async def claim(self, *, user_id: str, item_id: str, daily_cap: int) -> str | None:
        from db.connection import get_pool

        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                # Serialize this person's cap check across instances.
                await conn.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
                    f"one_attention_ledger:{user_id}",
                )
                sent = int(await conn.fetchval(_SENT_TODAY_SQL, user_id) or 0)
                outcome = "sent" if sent < daily_cap else "throttled"
                claimed = await conn.fetchval(_CLAIM_SQL, user_id, item_id, outcome)
        return str(claimed) if claimed is not None else None

    async def settle(self, *, user_id: str, item_id: str, outcome: str) -> None:
        from db.connection import get_pool

        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.execute(_SETTLE_SQL, user_id, item_id, outcome)

    async def prune(self) -> None:
        from db.connection import get_pool

        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.execute(_PRUNE_SQL)


async def get_offered_feed_item(*, user_id: str, item_id: str) -> Mapping[str, Any] | None:
    """The owner's feed row, only if the server actually sent an attention push for it."""
    import json

    from db.connection import get_pool
    from hushh_mcp.services.feed_service import FeedService

    if not item_id.isdigit():
        return None
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(_OFFERED_ITEM_SQL, user_id, int(item_id))
    if row is None:
        return None
    record = dict(row)
    if isinstance(record.get("metadata"), str):
        try:
            record["metadata"] = json.loads(record["metadata"])
        except ValueError:
            record["metadata"] = {}
    created = record.get("created_at")
    if isinstance(created, datetime):
        record["created_at"] = created.isoformat()
    # The same allowlist the Feed API applies: only bounded, renderable metadata.
    item: dict[str, Any] = FeedService._to_item(record)
    return item


async def send_feed_attention_push(user_id: str, payload: dict[str, Any]) -> int:
    """Send one bare wake-up to the owner's native devices. Never raises."""
    from hushh_mcp.services.push_notifications import send_user_data_push

    try:
        async with asyncio.timeout(_PUSH_TIMEOUT_SECONDS):
            return await asyncio.to_thread(send_user_data_push, user_id, **payload)
    except Exception:  # noqa: BLE001 - a wake-up is best-effort; no provider detail in logs
        logger.warning("one.feed_attention_push_skipped")
        return 0


async def run_feed_attention_sweep(
    *,
    store: FeedAttentionStore,
    sender: Sender = send_feed_attention_push,
    daily_cap: int = DAILY_CAP,
) -> dict[str, int]:
    """Consider each new notable feed row once; push at most ``daily_cap`` a day per person."""
    counts = {"sent": 0, "throttled": 0, "no_device": 0}
    candidates = await store.candidates(event_types=sorted(NOTABLE_EVENT_TYPES), limit=SWEEP_BATCH)
    for candidate in candidates:
        if not is_notable(candidate.event_type):
            continue
        outcome = await store.claim(
            user_id=candidate.user_id, item_id=candidate.item_id, daily_cap=daily_cap
        )
        if outcome is None:
            continue  # another instance already considered it, or no actor profile
        if outcome != "sent":
            counts["throttled"] += 1
            continue
        devices = await sender(candidate.user_id, feed_attention_push(candidate.item_id))
        if devices <= 0:
            # Notifications off (no token) or not deliverable: not a spent slot.
            await store.settle(
                user_id=candidate.user_id, item_id=candidate.item_id, outcome="no_device"
            )
            counts["no_device"] += 1
            continue
        counts["sent"] += 1
    await store.prune()
    return counts


async def _feed_attention_loop(store: FeedAttentionStore, interval_seconds: float) -> None:
    logger.info("one.feed_attention_loop_started interval_s=%s", interval_seconds)
    while True:
        try:
            counts = await run_feed_attention_sweep(store=store)
            if any(counts.values()):
                logger.info(
                    "one.feed_attention_sweep sent=%s throttled=%s no_device=%s",
                    counts["sent"],
                    counts["throttled"],
                    counts["no_device"],
                )
        except asyncio.CancelledError:
            return
        except Exception as error:  # noqa: BLE001 - a sweep failure must not end the loop
            logger.warning("one.feed_attention_sweep_failed error=%s", type(error).__name__)
        await asyncio.sleep(interval_seconds)


def start_feed_attention_loop(
    *,
    store: FeedAttentionStore | None = None,
    interval_seconds: float = SWEEP_INTERVAL_SECONDS,
) -> asyncio.Task[None]:
    return asyncio.create_task(
        _feed_attention_loop(store or PostgresFeedAttentionStore(), interval_seconds),
        name="one-feed-attention-push",
    )


__all__ = [
    "DAILY_CAP",
    "ENABLE_ENV",
    "FEED_ATTENTION_BODY",
    "FEED_ATTENTION_NOTIFICATION_TYPE",
    "FEED_ATTENTION_PLATFORMS",
    "FEED_ATTENTION_TITLE",
    "NOTABLE_EVENT_TYPES",
    "FeedCandidate",
    "FeedAttentionStore",
    "PostgresFeedAttentionStore",
    "feed_attention_enabled",
    "feed_attention_push",
    "get_offered_feed_item",
    "is_notable",
    "run_feed_attention_sweep",
    "send_feed_attention_push",
    "start_feed_attention_loop",
]
