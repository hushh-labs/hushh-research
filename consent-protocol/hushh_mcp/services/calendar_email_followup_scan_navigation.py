"""Thread and provider-page navigation for resumable selected-account scans."""

from __future__ import annotations

from datetime import datetime
from typing import Any

import httpx

from hushh_mcp.services.calendar_email_followup_reader import (
    CompleteMailReadError,
    history_message_page,
    list_message_page,
    thread_message_ids,
)
from hushh_mcp.services.calendar_email_followup_scan_checkpoint import (
    _SOURCE_INCOMPLETE,
    _mark_incomplete,
    _next_retry_batch,
    _save,
)
from hushh_mcp.services.calendar_email_followup_store import CalendarEmailFollowupStore, Monitor


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
            elif checkpoint["mode"] == "retry":
                checkpoint["mode"] = "history"
                await _save(
                    store,
                    monitor,
                    checkpoint,
                    "partial" if checkpoint.get("incomplete_sources") else "complete",
                )
                return 0, 0, True
            else:
                checkpoint["history_id"] = checkpoint["history_current_id"]
                if checkpoint.get("incomplete_sources"):
                    checkpoint["mode"] = "retry"
                    checkpoint["pending_threads"] = _next_retry_batch(checkpoint)
                await _save(
                    store,
                    monitor,
                    checkpoint,
                    "partial" if checkpoint.get("incomplete_sources") else "complete",
                )
                return 0, 0, True
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
        if exc.code not in _SOURCE_INCOMPLETE:
            raise
        _mark_incomplete(checkpoint, thread_id, exc.code)
        checkpoint["thread_index"] += 1
        checkpoint["failed_this_thread"] = False
        await _save(store, monitor, checkpoint, "partial")
        return 0, 0, False
    eligible = [
        message_id
        for message_id, internal_date_ms in refs
        if internal_date_ms >= checkpoint["cutoff_ms"]
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

    if checkpoint["mode"] == "retry":
        checkpoint["mode"] = "history"
        await _save(
            store,
            monitor,
            checkpoint,
            "partial" if checkpoint.get("incomplete_sources") else "complete",
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
        refs, next_page, current_id = await history_message_page(
            client=client,
            token=grant.token,
            start_history_id=checkpoint["history_id"],
            page_token=checkpoint["page_token"],
            require_current=grant.require_current,
        )
        checkpoint["pending_threads"] = list(dict.fromkeys(thread for _, thread in refs))
        checkpoint["next_page_token"] = next_page
        checkpoint["history_current_id"] = current_id
    checkpoint["thread_index"] = 0
    if not checkpoint["pending_threads"]:
        checkpoint["page_token"] = checkpoint["next_page_token"]
        checkpoint["next_page_token"] = None
        if checkpoint["page_token"] is None:
            if checkpoint["mode"] == "bootstrap":
                checkpoint["mode"] = "history"
            else:
                checkpoint["history_id"] = checkpoint["history_current_id"]
                if checkpoint.get("incomplete_sources"):
                    checkpoint["mode"] = "retry"
                    checkpoint["pending_threads"] = _next_retry_batch(checkpoint)
                await _save(
                    store,
                    monitor,
                    checkpoint,
                    "partial" if checkpoint.get("incomplete_sources") else "complete",
                )
                return 0, 0, True
    await _save(store, monitor, checkpoint, "pending")
    return 0, 0, False
