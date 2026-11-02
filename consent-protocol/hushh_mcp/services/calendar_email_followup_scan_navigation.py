"""Thread and provider-page navigation for resumable selected-account scans."""

from __future__ import annotations

from datetime import datetime
from typing import Any

import httpx

from hushh_mcp.services.calendar_email_followup_coverage import source_disposition
from hushh_mcp.services.calendar_email_followup_reader import (
    CompleteMailReadError,
    list_message_page,
    thread_message_ids,
)
from hushh_mcp.services.calendar_email_followup_reader_history import history_changes_page
from hushh_mcp.services.calendar_email_followup_scan_checkpoint import (
    _clear_incomplete_thread,
    _cutoff_ms,
    _earliest_retry_in,
    _mark_incomplete,
    _next_retry_batch,
    _save,
)
from hushh_mcp.services.calendar_email_followup_store import CalendarEmailFollowupStore, Monitor

# Modes that revisit named threads and then hand control back to history sync.
_BATCH_MODES = frozenset({"retry", "reassess"})


def _final_state(checkpoint: dict[str, Any]) -> str:
    return "partial" if checkpoint.get("incomplete_sources") else "complete"


async def _finish_pass(
    store: CalendarEmailFollowupStore,
    monitor: Monitor,
    checkpoint: dict[str, Any],
    now: datetime | None,
) -> tuple[int, int, bool]:
    """History is caught up: queue due retries, then earlier results to refresh.

    Retries come first because they restore coverage; reassessment of follow-ups
    created before relevance existed is bounded to a couple of threads per pass.
    """
    checkpoint["history_id"] = checkpoint["history_current_id"]
    batch = _next_retry_batch(checkpoint, now) if checkpoint.get("incomplete_sources") else []
    mode = "retry"
    if not batch:
        # A thread waiting on a retry, or one already revisited without becoming
        # current, is not queued again: a message that cannot be refreshed must
        # not loop through reassessment.
        seen = checkpoint.setdefault("reassess_seen", {})
        batch = await store.stale_assessment_threads(
            monitor,
            cutoff_ms=int(monitor.historical_start_at.timestamp() * 1000),
            limit=2,
            exclude=frozenset(checkpoint.get("incomplete_sources", {}))
            | frozenset(thread for thread, visits in seen.items() if visits >= 2),
        )
        for thread in batch:
            seen[thread] = int(seen.get(thread, 0)) + 1
        mode = "reassess"
    if batch:
        checkpoint["mode"] = mode
        checkpoint["pending_threads"] = batch
        checkpoint["thread_index"] = 0
        await _save(store, monitor, checkpoint, "pending")
        return 0, 0, False
    await _save(
        store,
        monitor,
        checkpoint,
        _final_state(checkpoint),
        retry_in=_earliest_retry_in(checkpoint, now),
    )
    return 0, 0, True


async def _step_thread(
    *,
    monitor: Monitor,
    checkpoint: dict[str, Any],
    store: CalendarEmailFollowupStore,
    grant: Any,
    client: httpx.AsyncClient,
    sections_left: int,
    now: datetime | None,
) -> tuple[int, int, bool]:
    threads = checkpoint["pending_threads"]
    index = checkpoint["thread_index"]
    if index >= len(threads):
        checkpoint["pending_threads"] = []
        checkpoint["thread_index"] = 0
        checkpoint["page_token"] = checkpoint["next_page_token"]
        checkpoint["next_page_token"] = None
        if checkpoint["page_token"] is None:
            if checkpoint["mode"] == "bootstrap":
                checkpoint["mode"] = "history"
            elif checkpoint["mode"] in _BATCH_MODES:
                checkpoint["mode"] = "history"
                await _save(
                    store,
                    monitor,
                    checkpoint,
                    _final_state(checkpoint),
                    retry_in=_earliest_retry_in(checkpoint, now),
                )
                return 0, 0, True
            else:
                return await _finish_pass(store, monitor, checkpoint, now)
        await _save(store, monitor, checkpoint, "pending")
        return 0, 0, False
    thread_id = threads[index]
    try:
        refs = await thread_message_ids(
            client=client,
            token=grant.token,
            thread_id=thread_id,
            require_current=grant.require_current,
        )
    except CompleteMailReadError as exc:
        disposition = source_disposition(exc.code)
        if disposition == "gone":
            await store.mark_thread_gone(monitor, thread_id)
            checkpoint["incomplete_sources"].pop(thread_id, None)
        elif disposition == "retry":
            _mark_incomplete(checkpoint, thread_id, exc.code, now=now, retry_after=exc.retry_after)
        else:
            raise
        checkpoint["thread_index"] += 1
        checkpoint["failed_this_thread"] = False
        await _save(store, monitor, checkpoint, "pending")
        return 0, 0, False
    _clear_incomplete_thread(checkpoint, thread_id)
    # The listing is complete, so an earlier message missing from it is gone.
    await store.retire_unlisted_stale(monitor, thread_id, [message_id for message_id, _ in refs])
    eligible = [
        message_id
        for message_id, internal_date_ms in refs
        if internal_date_ms >= _cutoff_ms(monitor, checkpoint)
        and (checkpoint["mode"] != "bootstrap" or internal_date_ms <= checkpoint["snapshot_ms"])
    ]
    if not eligible:
        checkpoint["thread_index"] += 1
    else:
        checkpoint["thread_messages"] = eligible
        checkpoint["message_index"] = 0
    await _save(store, monitor, checkpoint, "pending")
    return 0, 0, False


async def _step_page(
    *,
    monitor: Monitor,
    checkpoint: dict[str, Any],
    store: CalendarEmailFollowupStore,
    grant: Any,
    client: httpx.AsyncClient,
    sections_left: int,
    now: datetime | None,
) -> tuple[int, int, bool]:
    if checkpoint["mode"] in _BATCH_MODES:
        checkpoint["mode"] = "history"
        await _save(
            store,
            monitor,
            checkpoint,
            _final_state(checkpoint),
            retry_in=_earliest_retry_in(checkpoint, now),
        )
        return 0, 0, True
    if checkpoint["mode"] == "bootstrap":
        page = await list_message_page(
            client=client,
            token=grant.token,
            after_ms=checkpoint["cutoff_ms"],
            before_ms=checkpoint["snapshot_ms"],
            page_token=checkpoint["page_token"],
            require_current=grant.require_current,
        )
        checkpoint["pending_threads"] = list(dict.fromkeys(thread for _, thread in page.messages))
        checkpoint["next_page_token"] = page.next_page_token
    else:
        changes = await history_changes_page(
            client=client,
            token=grant.token,
            start_history_id=checkpoint["history_id"],
            page_token=checkpoint["page_token"],
            require_current=grant.require_current,
        )
        if changes.deleted:
            # Idempotent: a restart that replays this page repeats a no-op.
            await store.mark_messages_gone(monitor, list(changes.deleted))
        checkpoint["pending_threads"] = list(dict.fromkeys(thread for _, thread in changes.added))
        checkpoint["next_page_token"] = changes.next_page_token
        checkpoint["history_current_id"] = changes.history_id
    checkpoint["thread_index"] = 0
    if not checkpoint["pending_threads"]:
        checkpoint["page_token"] = checkpoint["next_page_token"]
        checkpoint["next_page_token"] = None
        if checkpoint["page_token"] is None:
            if checkpoint["mode"] == "bootstrap":
                checkpoint["mode"] = "history"
            else:
                return await _finish_pass(store, monitor, checkpoint, now)
    await _save(store, monitor, checkpoint, "pending")
    return 0, 0, False
