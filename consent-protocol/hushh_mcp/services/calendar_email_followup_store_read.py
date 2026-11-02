"""Read-side projection of follow-up conversations for the owner's card.

The store adapter composes these pieces: one bounded page query, the previews of
that page's conversations, and the sealed-field opening that decides what the
default surface may show. Nothing here writes.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Connection

from hushh_mcp.services.calendar_email_followup_coverage import coverage
from hushh_mcp.services.calendar_email_followup_relevance import sanitize_excerpt
from hushh_mcp.services.calendar_email_followup_store_types import Monitor

# Opens one sealed field: (ciphertext, monitor, row id, purpose) -> value.
Opener = Callable[[str, Monitor, str, str], Any]

# Static SQL on purpose: the "live" predicate is repeated, not interpolated.
_COUNT = """SELECT count(*) FROM calendar_email_followup_conversations c
    WHERE c.user_id=:user_id AND c.account_id=:account_id
    AND EXISTS (SELECT 1 FROM calendar_email_followup_requests r
      WHERE r.conversation_id=c.id
        AND r.state IN ('pending','snoozed','needs_review')
        AND r.suppressed_at IS NULL)"""

_PAGE = """SELECT c.id,c.subject_ciphertext,c.sender_ciphertext,c.thread_ref_ciphertext,
    c.latest_internal_date_ms,
    count(r.id) FILTER (WHERE r.suppressed_at IS NULL) AS request_count,
    count(r.id) FILTER (WHERE r.state IN ('pending','snoozed','needs_review')
      AND r.suppressed_at IS NULL) AS active_count,
    min(COALESCE(r.due_date,r.proposed_date)) FILTER
      (WHERE r.state IN ('pending','snoozed','needs_review')
       AND r.suppressed_at IS NULL) AS next_date,
    -- Real dates first, then undated ASAP asks, then everything else;
    -- owner-assigned work before work whose owner is unclear.
    min(CASE WHEN COALESCE(r.due_date,r.proposed_date) IS NOT NULL THEN 0
             WHEN r.urgency='asap' THEN 1 ELSE 2 END) FILTER
      (WHERE r.state IN ('pending','snoozed','needs_review')
       AND r.suppressed_at IS NULL) AS review_rank,
    min(CASE r.responsibility WHEN 'owner' THEN 0 ELSE 1 END) FILTER
      (WHERE r.state IN ('pending','snoozed','needs_review')
       AND r.suppressed_at IS NULL) AS owner_rank
    FROM calendar_email_followup_conversations c
    JOIN calendar_email_followup_requests r ON r.conversation_id=c.id
    WHERE c.user_id=:user_id AND c.account_id=:account_id
    GROUP BY c.id HAVING count(r.id) FILTER
      (WHERE r.state IN ('pending','snoozed','needs_review')
       AND r.suppressed_at IS NULL)>0
    ORDER BY review_rank,next_date ASC NULLS LAST,owner_rank,
      c.latest_internal_date_ms DESC,c.id DESC LIMIT :limit OFFSET :offset"""

_PREVIEWS = """SELECT r.* FROM calendar_email_followup_requests r
    WHERE r.conversation_id=ANY(CAST(:conversation_ids AS UUID[]))
      AND r.state IN ('pending','snoozed','needs_review')
      AND r.suppressed_at IS NULL
    ORDER BY COALESCE(r.due_date,r.proposed_date) ASC NULLS LAST,
      (r.urgency='asap') DESC,r.source_internal_date_ms,r.id"""


def reminder_status(row: dict[str, Any]) -> str:
    """What the owner can rely on: sent, scheduled, none, or not applicable."""
    if row["state"] in {"done", "dismissed", "cancelled", "source_unavailable"}:
        return "closed"
    if not row["reminder_at"]:
        return "none"
    return "sent" if row["reminder_sent_revision"] == row["revision"] else "scheduled"


def _iso(value: Any) -> str | None:
    return value.isoformat() if value else None


def _is_partial(monitor: Monitor, thread_ref: Any) -> str:
    unverified = (monitor.checkpoint or {}).get("incomplete_sources", {})
    return "partial" if thread_ref in unverified else "complete"


def read_page(
    conn: Connection, monitor: Monitor, *, limit: int, offset: int
) -> tuple[int, list[Any], list[Any]]:
    """The owner's active conversations, in review order, with their previews."""
    scope = {"user_id": monitor.user_id, "account_id": monitor.account_id}
    count = int(conn.execute(text(_COUNT), scope).scalar_one())
    rows = conn.execute(text(_PAGE), {**scope, "limit": limit, "offset": offset}).mappings().all()
    previews = (
        conn.execute(text(_PREVIEWS), {"conversation_ids": [str(row["id"]) for row in rows]})
        .mappings()
        .all()
        if rows
        else []
    )
    return count, rows, previews


def preview_view(open_value: Opener, monitor: Monitor, row: Any) -> dict[str, Any]:
    row_id = str(row["id"])
    due_wording = row["due_wording_ciphertext"]
    return {
        "id": row_id,
        "kind": row["kind"],
        "state": row["state"],
        "title": open_value(row["title_ciphertext"], monitor, row_id, "title"),
        "original_due_wording": open_value(due_wording, monitor, row_id, "due_wording")
        if due_wording
        else None,
        "due_date": _iso(row["due_date"]),
        "due_relation": row["due_relation"],
        "proposed_date": _iso(row["proposed_date"]),
        "proposed_at": _iso(row["proposed_at"]),
        "ambiguities": row["ambiguities"],
        "category": row["category"],
        "urgency": row["urgency"],
        "meeting_state": row["meeting_state"],
        "responsibility": row["responsibility"],
    }


def page_view(
    open_value: Opener,
    monitor: Monitor,
    *,
    page: tuple[int, list[Any], list[Any]],
    offset: int,
) -> dict[str, Any]:
    count, rows, previews = page
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for preview in previews:
        grouped[str(preview["conversation_id"])].append(preview_view(open_value, monitor, preview))
    conversations = []
    for row in rows:
        row_id = str(row["id"])
        thread_ref = open_value(row["thread_ref_ciphertext"], monitor, row_id, "thread_ref")
        conversations.append(
            {
                "id": row_id,
                "subject": open_value(row["subject_ciphertext"], monitor, row_id, "subject"),
                "sender": open_value(row["sender_ciphertext"], monitor, row_id, "sender"),
                "latest_internal_date_ms": row["latest_internal_date_ms"],
                "request_count": int(row["request_count"]),
                "active_count": int(row["active_count"]),
                "preview_requests": grouped.get(row_id, [])[:3],
                "source_completeness": _is_partial(monitor, thread_ref),
            }
        )
    return {
        "account_id": monitor.account_id,
        "scan_state": monitor.scan_state,
        "incomplete_source_count": len((monitor.checkpoint or {}).get("incomplete_sources", {})),
        "coverage": coverage(
            scan_state=monitor.scan_state,
            error_code=monitor.scan_error_code,
            consecutive_failures=monitor.consecutive_failures,
            checkpoint=monitor.checkpoint,
        ),
        "total_conversations": count,
        "next_offset": offset + len(rows) if offset + len(rows) < count else None,
        "conversations": conversations,
    }


def conversation_view(
    open_value: Opener, monitor: Monitor, conversation: dict[str, Any], rows: list[Any]
) -> dict[str, Any]:
    conversation_id = str(conversation["id"])
    thread_ref = open_value(
        conversation["thread_ref_ciphertext"], monitor, conversation_id, "thread_ref"
    )
    return {
        "id": conversation_id,
        "account_id": monitor.account_id,
        "subject": open_value(
            conversation["subject_ciphertext"], monitor, conversation_id, "subject"
        ),
        "sender": open_value(conversation["sender_ciphertext"], monitor, conversation_id, "sender"),
        "latest_internal_date_ms": conversation["latest_internal_date_ms"],
        "source_completeness": _is_partial(monitor, thread_ref),
        "requests": [request_view(open_value, monitor, dict(row)) for row in rows],
    }


def request_view(open_value: Opener, monitor: Monitor, row: dict[str, Any]) -> dict[str, Any]:
    row_id = str(row["id"])
    due_wording = row["due_wording_ciphertext"]
    linked = row["linked_event_ciphertext"]
    return {
        "id": row_id,
        "kind": row["kind"],
        "state": row["state"],
        "title": open_value(row["title_ciphertext"], monitor, row_id, "title"),
        # Brief and link-free: the full source stays behind the authorized
        # source view, never in the default surface.
        "source_excerpt": sanitize_excerpt(
            open_value(row["quote_ciphertext"], monitor, row_id, "quote")
        ),
        "category": row["category"],
        "urgency": row["urgency"],
        "meeting_state": row["meeting_state"],
        "linked_event": open_value(linked, monitor, row_id, "linked_event") if linked else None,
        "reminder_status": reminder_status(row),
        "original_due_wording": open_value(due_wording, monitor, row_id, "due_wording")
        if due_wording
        else None,
        "due_date": _iso(row["due_date"]),
        "due_relation": row["due_relation"],
        "proposed_date": _iso(row["proposed_date"]),
        "proposed_at": _iso(row["proposed_at"]),
        "time_zone": row["time_zone"],
        "responsibility": row["responsibility"],
        "ambiguities": row["ambiguities"],
        "reminder_at": _iso(row["reminder_at"]),
        "source_internal_date_ms": row["source_internal_date_ms"],
        "revision": row["revision"],
        "booking_state": ("booked" if row["booking_event_ref_ciphertext"] else "not_booked")
        if row["kind"] == "meeting"
        else None,
    }
