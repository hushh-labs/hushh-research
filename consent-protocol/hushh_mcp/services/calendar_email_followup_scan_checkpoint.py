"""Pure checkpoint cursor mutations for complete selected-account mail scans."""

from __future__ import annotations

from typing import Any

from hushh_mcp.services.calendar_email_followup_store import CalendarEmailFollowupStore, Monitor


def _initial_checkpoint(monitor: Monitor, *, snapshot_ms: int, history_id: str) -> dict[str, Any]:
    return {
        "version": 1,
        "mode": "bootstrap",
        "cutoff_ms": int(monitor.historical_start_at.timestamp() * 1000),
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
        "partial_body_digest": None,
        "incomplete_sources": {},
        "failed_this_thread": False,
        "retry_cursor": 0,
    }


def _clear_message(checkpoint: dict[str, Any]) -> None:
    checkpoint["section_index"] = 0
    checkpoint["partial_candidates"] = []
    checkpoint["partial_updates"] = []
    checkpoint["partial_body_digest"] = None


def _mark_incomplete(
    checkpoint: dict[str, Any], thread_id: str, code: str, message_id: str | None = None
) -> None:
    thread = checkpoint.setdefault("incomplete_sources", {}).setdefault(
        thread_id, {"thread": None, "messages": {}}
    )
    if message_id:
        thread["messages"][message_id] = code
    else:
        thread["thread"] = code
    checkpoint["failed_this_thread"] = True


def _clear_incomplete_message(checkpoint: dict[str, Any], thread_id: str, message_id: str) -> None:
    sources = checkpoint.setdefault("incomplete_sources", {})
    thread = sources.get(thread_id)
    if thread:
        thread["messages"].pop(message_id, None)
        if not thread["thread"] and not thread["messages"]:
            sources.pop(thread_id, None)


def _next_retry_batch(checkpoint: dict[str, Any]) -> list[str]:
    threads = list(checkpoint.get("incomplete_sources", {}))
    if not threads:
        return []
    start = int(checkpoint.get("retry_cursor", 0)) % len(threads)
    batch = [threads[(start + offset) % len(threads)] for offset in range(min(2, len(threads)))]
    checkpoint["retry_cursor"] = (start + len(batch)) % len(threads)
    return batch


_SOURCE_INCOMPLETE = frozenset(
    {
        "source_unavailable",
        "no_readable_body",
        "incomplete_body",
        "body_too_large",
        "provider_response_too_large",
        "unsupported_readable_part",
        "invalid_body_tree",
        "incomplete_thread",
        "assessment_overflow",
        "external_parts_limit",
    }
)


async def _save(
    store: CalendarEmailFollowupStore, monitor: Monitor, checkpoint: dict[str, Any], state: str
) -> None:
    await store.save_checkpoint(monitor, checkpoint, state=state)  # type: ignore[arg-type]
