"""Bounded due drain; source and consent are rechecked before durable delivery."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any, Callable

import httpx

from hushh_mcp.services.calendar_email_followup_account import (
    SelectedMailAccessError,
    open_selected_mail_grant,
)
from hushh_mcp.services.calendar_email_followup_reader import (
    CompleteMailReadError,
    read_complete_message,
    thread_message_ids,
)
from hushh_mcp.services.calendar_email_followup_store import (
    CalendarEmailFollowupStore,
    DueClaim,
    FollowupStateError,
)
from hushh_mcp.services.system_push_delivery import wake_system_push_worker

logger = logging.getLogger(__name__)


async def _verify_source(
    claim: DueClaim,
    *,
    store: CalendarEmailFollowupStore,
    client: httpx.AsyncClient,
    grant: Any,
) -> str:
    """Return ready, defer, or source_unavailable without interpreting mail."""

    async def current() -> None:
        await grant.require_current()
        await store.require_monitor_current(claim.monitor)

    await current()
    message = await read_complete_message(
        client=client,
        token=grant.token,
        message_id=claim.source_message_id,
        require_current=current,
    )
    if (
        message.thread_id != claim.thread_id
        or message.internal_date_ms != claim.source_internal_date_ms
        or message.body_digest != claim.source_body_digest
    ):
        return "source_unavailable"
    refs = await thread_message_ids(
        client=client,
        token=grant.token,
        thread_id=claim.thread_id,
        require_current=current,
    )
    if claim.source_message_id not in {message_id for message_id, _ in refs}:
        return "source_unavailable"
    if claim.thread_id in (claim.monitor.checkpoint or {}).get("incomplete_sources", {}):
        return "defer"
    for message_id, received_at_ms in refs:
        if message_id == claim.source_message_id or received_at_ms < claim.source_internal_date_ms:
            continue
        if await store.scanned_digest(claim.monitor, message_id) is None:
            return "defer"
    await current()
    return "ready"


async def drain_due_reminders(
    *,
    store: CalendarEmailFollowupStore | None = None,
    now: datetime | None = None,
    limit: int = 10,
    transport: httpx.AsyncBaseTransport | None = None,
    open_grant: Callable[..., Any] = open_selected_mail_grant,
) -> dict[str, int]:
    """One finite run. The outbox and Feed commit atomically per request."""
    if not 1 <= limit <= 20:
        raise ValueError("invalid_reminder_limit")
    store = store or CalendarEmailFollowupStore()
    instant = now or datetime.now(UTC)
    result = {"checked": 0, "queued": 0, "deferred": 0, "source_unavailable": 0}
    async with httpx.AsyncClient(transport=transport, timeout=10, follow_redirects=False) as client:
        for _ in range(limit):
            claim = await store.claim_due(now=instant)
            if not claim:
                break
            result["checked"] += 1
            try:
                grant = await open_grant(
                    user_id=claim.monitor.user_id, account_id=claim.monitor.account_id
                )
                if grant.epoch_digest != claim.monitor.grant_epoch_digest:
                    raise SelectedMailAccessError("mail_grant_changed")
                verdict = await _verify_source(claim, store=store, client=client, grant=grant)
                if verdict == "source_unavailable":
                    await store.mark_source_unavailable(claim)
                    result["source_unavailable"] += 1
                elif verdict == "ready" and await store.queue_due(claim, now=instant):
                    result["queued"] += 1
                    wake_system_push_worker()
                else:
                    await store.defer_due(claim, now=instant)
                    result["deferred"] += 1
            except CompleteMailReadError as exc:
                if exc.code == "source_unavailable":
                    await store.mark_source_unavailable(claim)
                    result["source_unavailable"] += 1
                else:
                    await store.defer_due(claim, now=instant)
                    result["deferred"] += 1
            except Exception as exc:
                logger.warning(
                    "calendar_followups.reminder_deferred error_type=%s", type(exc).__name__
                )
                await store.defer_due(claim, now=instant)
                result["deferred"] += 1
    return result


async def verify_pending_push_source(
    *,
    user_id: str,
    request_id: str,
    revision: int,
    store: CalendarEmailFollowupStore | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> str:
    """Re-read Gmail on each delivery attempt, including retries after a restart."""
    store = store or CalendarEmailFollowupStore()
    claim = await store.source_claim_for_push(
        user_id=user_id, request_id=request_id, revision=revision
    )
    if not claim:
        return "unavailable"
    try:
        grant = await open_selected_mail_grant(
            user_id=claim.monitor.user_id, account_id=claim.monitor.account_id
        )
        if grant.epoch_digest != claim.monitor.grant_epoch_digest:
            return "unavailable"
        async with httpx.AsyncClient(
            transport=transport, timeout=10, follow_redirects=False
        ) as client:
            verdict = await _verify_source(claim, store=store, client=client, grant=grant)
        return "unavailable" if verdict == "source_unavailable" else verdict
    except (SelectedMailAccessError, CompleteMailReadError, FollowupStateError) as exc:
        return (
            "unavailable"
            if exc.code
            in {
                "mail_grant_changed",
                "selected_mail_permission_required",
                "source_unavailable",
                "monitor_changed",
            }
            else "defer"
        )
    except Exception as exc:
        logger.warning("calendar_followups.push_source_deferred error_type=%s", type(exc).__name__)
        return "defer"
