"""Pure checkpoint cursor mutations for complete selected-account mail scans."""

from __future__ import annotations

import copy
from datetime import UTC, datetime
from typing import Any

from hushh_mcp.services.calendar_email_followup_coverage import (
    PERMANENT_UNREADABLE,
    RECOVERABLE_SOURCE,
    SOURCE_GONE,
    source_backoff_seconds,
    source_exhausted,
)
from hushh_mcp.services.calendar_email_followup_store import CalendarEmailFollowupStore, Monitor


def _now_ms(now: datetime | None = None) -> int:
    return int((now or datetime.now(UTC)).timestamp() * 1000)


def _initial_checkpoint(
    monitor: Monitor,
    *,
    snapshot_ms: int,
    history_id: str,
    cutoff_ms: int | None = None,
) -> dict[str, Any]:
    start_ms = int(monitor.historical_start_at.timestamp() * 1000)
    return {
        "version": 1,
        "mode": "bootstrap",
        # Gap recovery narrows this to the unsynchronized period; a first scan
        # always covers the owner's whole approved period.
        "cutoff_ms": max(start_ms, cutoff_ms) if cutoff_ms is not None else start_ms,
        "snapshot_ms": snapshot_ms,
        "history_id": history_id,
        "page_token": None,
        "next_page_token": None,
        "pending_threads": [],
        "thread_index": 0,
        "thread_messages": [],
        "message_index": 0,
        "section_index": 0,
        "partial_candidates": [],
        "partial_updates": [],
        "partial_drops": {},
        "partial_body_digest": None,
        "incomplete_sources": {},
        "failed_this_thread": False,
        "retry_cursor": 0,
        "unreadable": 0,
        "message_failures": {},
        "reassess_seen": {},
    }


def _cutoff_ms(monitor: Monitor, checkpoint: dict[str, Any]) -> int:
    """Oldest message this step may read.

    A retry or reassessment revisits specific threads that can predate a
    narrowed gap-recovery cutoff, so they are bounded by the owner's approved
    period instead.
    """
    if checkpoint.get("mode") in {"retry", "reassess"}:
        return int(monitor.historical_start_at.timestamp() * 1000)
    return int(checkpoint["cutoff_ms"])


def _clear_message(checkpoint: dict[str, Any]) -> None:
    checkpoint["section_index"] = 0
    checkpoint["partial_candidates"] = []
    checkpoint["partial_updates"] = []
    checkpoint["partial_drops"] = {}
    checkpoint["partial_body_digest"] = None


def _mark_incomplete(
    checkpoint: dict[str, Any],
    thread_id: str,
    code: str,
    message_id: str | None = None,
    *,
    now: datetime | None = None,
    retry_after: int | None = None,
) -> None:
    """Record one recoverable source with a bounded, backed-off retry schedule."""
    thread = checkpoint.setdefault("incomplete_sources", {}).setdefault(
        thread_id, {"thread": None, "messages": {}}
    )
    if message_id:
        thread["messages"][message_id] = code
    else:
        thread["thread"] = code
    thread["attempts"] = int(thread.get("attempts", 0)) + 1
    thread["retry_at_ms"] = _now_ms(now) + 1000 * source_backoff_seconds(
        thread["attempts"], retry_after=retry_after
    )
    checkpoint["failed_this_thread"] = True


def _clear_incomplete_thread(checkpoint: dict[str, Any], thread_id: str) -> None:
    """The thread itself was listed again; only its message-level gaps remain."""
    sources = checkpoint.setdefault("incomplete_sources", {})
    thread = sources.get(thread_id)
    if thread:
        thread["thread"] = None
        if not thread["messages"]:
            sources.pop(thread_id, None)


def _upgrade_checkpoint(checkpoint: dict[str, Any]) -> dict[str, Any]:
    """Fill fields added after a checkpoint was sealed; never drops a cursor."""
    for key, default in (
        ("partial_candidates", []),
        ("partial_updates", []),
        ("partial_drops", {}),
        ("partial_body_digest", None),
        ("incomplete_sources", {}),
        ("failed_this_thread", False),
        ("retry_cursor", 0),
        ("unreadable", 0),
        ("message_failures", {}),
        ("reassess_seen", {}),
    ):
        checkpoint.setdefault(key, copy.deepcopy(default))
    return checkpoint


def _record_unreadable(checkpoint: dict[str, Any]) -> None:
    checkpoint["unreadable"] = int(checkpoint.get("unreadable", 0)) + 1


def _clear_incomplete_message(checkpoint: dict[str, Any], thread_id: str, message_id: str) -> None:
    sources = checkpoint.setdefault("incomplete_sources", {})
    thread = sources.get(thread_id)
    if thread:
        thread["messages"].pop(message_id, None)
        if not thread["thread"] and not thread["messages"]:
            sources.pop(thread_id, None)


def _next_retry_batch(checkpoint: dict[str, Any], now: datetime | None = None) -> list[str]:
    """Two retry-due, non-exhausted sources; exhausted ones wait for the owner."""
    due_ms = _now_ms(now)
    sources = checkpoint.get("incomplete_sources", {})
    threads = [
        thread_id
        for thread_id, entry in sources.items()
        if not source_exhausted(entry) and int(entry.get("retry_at_ms", 0)) <= due_ms
    ]
    if not threads:
        return []
    start = int(checkpoint.get("retry_cursor", 0)) % len(threads)
    batch = [threads[(start + offset) % len(threads)] for offset in range(min(2, len(threads)))]
    checkpoint["retry_cursor"] = (start + len(batch)) % len(threads)
    return batch


def _earliest_retry_in(checkpoint: dict[str, Any], now: datetime | None = None) -> int | None:
    """Seconds until the next automatic retry, or None when nothing is waiting."""
    pending = [
        int(entry.get("retry_at_ms", 0))
        for entry in checkpoint.get("incomplete_sources", {}).values()
        if not source_exhausted(entry)
    ]
    if not pending:
        return None
    return max(0, (min(pending) - _now_ms(now)) // 1000)


def _reset_exhausted(checkpoint: dict[str, Any]) -> None:
    """A manual Retry gives every waiting source a fresh bounded allowance."""
    for entry in checkpoint.get("incomplete_sources", {}).values():
        entry["attempts"] = 0
        entry["retry_at_ms"] = 0
    checkpoint["message_failures"] = {}
    checkpoint["reassess_seen"] = {}


# Source-level conditions the scanner handles itself instead of failing the pass.
_SOURCE_INCOMPLETE = PERMANENT_UNREADABLE | SOURCE_GONE | RECOVERABLE_SOURCE


async def _save(
    store: CalendarEmailFollowupStore,
    monitor: Monitor,
    checkpoint: dict[str, Any],
    state: str,
    *,
    retry_in: int | None = None,
) -> None:
    await store.save_checkpoint(monitor, checkpoint, state=state, retry_in=retry_in)  # type: ignore[arg-type]
