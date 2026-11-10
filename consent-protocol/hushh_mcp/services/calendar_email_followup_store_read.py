"""Read-side projection of follow-up conversations for the owner's card.

The store adapter composes these pieces: one bounded page query, the previews of
that page's conversations, and the sealed-field opening that decides what the
default surface may show. Nothing here writes.

Eligibility, ranking and paging all happen in SQL, before the page is chosen, so
an expired item never occupies a slot that is then hidden by the client. Which
view a request belongs to is recomputed from the clock on every read, so a
deadline that passes moves its request without any background job, and nothing
is marked done or deleted because its date passed.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

from sqlalchemy import text
from sqlalchemy.engine import Connection

from hushh_mcp.services.calendar_email_followup_coverage import coverage
from hushh_mcp.services.calendar_email_followup_relevance import (
    UNDATED_FRESH_DAYS,
    sanitize_excerpt,
)
from hushh_mcp.services.calendar_email_followup_store_types import FollowupStateError, Monitor

# Opens one sealed field: (ciphertext, monitor, row id, purpose) -> value.
Opener = Callable[[str, Monitor, str, str], Any]

View = Literal["upcoming", "overdue", "snoozed", "history"]
VIEWS: tuple[View, ...] = ("upcoming", "overdue", "snoozed", "history")

# The calendar day a request is about, in the owner's time zone.
_DAY = "COALESCE(r.due_date,r.proposed_date,(r.proposed_at AT TIME ZONE :tz)::date)"

# Which list a live request belongs to, from the clock and what the sender asked.
#   closed by the owner or its source            -> history
#   snoozed until a time that has not come       -> snoozed
#   undated                                       -> upcoming while it is recent
#                                                    and the owner's or urgent
#   dated today or later                          -> upcoming
#   dated before today:
#     the owner's own unresolved obligation       -> overdue (never marked done)
#     an opportunity that lapsed, a past meeting
#     proposal, work that is not the owner's      -> history
# An obligation whose date effect is unknown is kept as overdue, not expired.
_BUCKET = f"""CASE
  WHEN r.state IN ('done','dismissed','cancelled','source_unavailable') THEN 'history'
  WHEN r.state='snoozed' AND r.reminder_at>:now THEN 'snoozed'
  WHEN {_DAY} IS NULL THEN CASE
    WHEN (r.responsibility='owner' OR r.urgency='asap')
     AND r.source_internal_date_ms>=:fresh_ms THEN 'upcoming' ELSE 'history' END
  WHEN {_DAY}>:today OR ({_DAY}=:today AND
    (r.due_date IS NULL OR r.due_relation IS DISTINCT FROM 'before')) THEN 'upcoming'
  WHEN r.kind<>'meeting' AND r.responsibility='owner'
   AND r.after_date IN ('owed','unspecified') THEN 'overdue'
  ELSE 'history' END"""

# Every request that may appear to the owner, with its view and rank inputs.
# Suppressed requests (reassessed away) and merged ones (restated elsewhere) are
# not independent items; their sources stay on their own sealed rows.
_LIVE = f"""WITH live AS (
  SELECT r.id AS request_id,r.conversation_id,{_BUCKET} AS bucket,{_DAY} AS day,
    CASE r.responsibility WHEN 'owner' THEN 0 ELSE 1 END AS owner_rank,
    CASE r.urgency WHEN 'asap' THEN 0 WHEN 'time_bound' THEN 1 ELSE 2 END AS urgency_rank,
    CASE WHEN r.category IN ('document_or_information','deliverable_deadline') THEN 0
         WHEN r.category IN ('meeting_request','schedule_change') THEN 1 ELSE 2 END AS category_rank,
    jsonb_array_length(r.ambiguities) AS ambiguity_count,
    r.source_internal_date_ms,r.reminder_at
  FROM calendar_email_followup_requests r
  WHERE r.user_id=:user_id AND r.account_id=:account_id
    AND r.suppressed_at IS NULL AND r.merged_into IS NULL
), ranked AS (
  SELECT live.*,
    -- Verified urgency and a close date first, then later dates, then undated.
    CASE WHEN urgency_rank=0 THEN 0 WHEN day<=CAST(:today AS DATE)+7 THEN 0
         WHEN day IS NOT NULL THEN 1 ELSE 2 END AS tier
  FROM live
)"""  # nosec B608 # composed only from module-constant SQL fragments; no request data is interpolated

# Static per view. Fewer ambiguities is the available confidence signal.
_ORDER: dict[str, str] = {
    "upcoming": """tier,owner_rank,day ASC NULLS LAST,urgency_rank,category_rank,ambiguity_count,
      source_internal_date_ms DESC,request_id""",
    "overdue": """day DESC NULLS LAST,owner_rank,source_internal_date_ms DESC,request_id""",
    "snoozed": """reminder_at ASC NULLS LAST,request_id""",
    "history": """source_internal_date_ms DESC,request_id""",
}


def _page_sql(view: str) -> str:
    order = _ORDER[view]
    return f"""{_LIVE}, best AS (
  SELECT DISTINCT ON (conversation_id) ranked.* FROM ranked WHERE bucket=:view
  ORDER BY conversation_id,{order}
)
SELECT c.id,c.subject_ciphertext,c.sender_ciphertext,c.thread_ref_ciphertext,
  c.latest_internal_date_ms,
  (SELECT count(*) FROM live l WHERE l.conversation_id=c.id) AS request_count,
  (SELECT count(*) FROM live l WHERE l.conversation_id=c.id AND l.bucket=:view) AS active_count
FROM best JOIN calendar_email_followup_conversations c ON c.id=best.conversation_id
ORDER BY {order},c.latest_internal_date_ms DESC,c.id DESC LIMIT :limit OFFSET :offset"""  # nosec B608 # composed only from module-constant SQL fragments; no request data is interpolated; order is from a fixed dict keyed by a validated view


_COUNTS = f"""{_LIVE}
SELECT bucket,count(DISTINCT conversation_id) FROM live GROUP BY bucket"""  # nosec B608 # composed only from module-constant SQL fragments; no request data is interpolated


def _previews_sql(view: str) -> str:
    return f"""{_LIVE}
SELECT r.*,ranked.bucket FROM ranked
JOIN calendar_email_followup_requests r ON r.id=ranked.request_id
WHERE ranked.conversation_id=ANY(CAST(:conversation_ids AS UUID[])) AND ranked.bucket=:view
ORDER BY ranked.conversation_id,{_ORDER[view]}"""  # nosec B608 # composed only from module-constant SQL fragments; no request data is interpolated; order is from a fixed dict keyed by a validated view


# One conversation's live requests with their view and how many other emails
# restated each. Requests the owner has closed stay visible here.
_DETAIL = f"""{_LIVE}
SELECT r.*,ranked.bucket,
  (SELECT count(*) FROM calendar_email_followup_requests m
   WHERE m.merged_into=r.id AND m.user_id=r.user_id AND m.account_id=r.account_id) AS repeat_count
FROM ranked JOIN calendar_email_followup_requests r ON r.id=ranked.request_id
WHERE ranked.conversation_id=CAST(:conversation_id AS UUID)
ORDER BY r.source_internal_date_ms,r.id"""  # nosec B608 # composed only from module-constant SQL fragments; no request data is interpolated


def _utcnow() -> datetime:
    return datetime.now(UTC)


def clock_params(monitor: Monitor, now: datetime | None) -> dict[str, Any]:
    """The owner's local day and the recency floor for one read."""
    instant = now or _utcnow()
    if instant.tzinfo is None:
        raise FollowupStateError("invalid_clock")
    return {
        "user_id": monitor.user_id,
        "account_id": monitor.account_id,
        "tz": monitor.time_zone,
        "now": instant,
        "today": instant.astimezone(ZoneInfo(monitor.time_zone)).date(),
        "fresh_ms": int((instant - timedelta(days=UNDATED_FRESH_DAYS)).timestamp() * 1000),
    }


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
    conn: Connection,
    monitor: Monitor,
    *,
    limit: int,
    offset: int,
    view: str = "upcoming",
    now: datetime | None = None,
) -> tuple[int, list[Any], list[Any], dict[str, int]]:
    """One page of the owner's conversations for a view, with previews and counts."""
    if view not in VIEWS:
        raise FollowupStateError("invalid_view")
    scope = clock_params(monitor, now)
    counts = {name: 0 for name in VIEWS}
    for bucket, total in conn.execute(text(_COUNTS), scope).all():
        counts[bucket] = int(total)
    rows = (
        conn.execute(
            text(_page_sql(view)), {**scope, "view": view, "limit": limit, "offset": offset}
        )
        .mappings()
        .all()
        if counts[view]
        else []
    )
    previews = (
        conn.execute(
            text(_previews_sql(view)),
            {**scope, "view": view, "conversation_ids": [str(row["id"]) for row in rows]},
        )
        .mappings()
        .all()
        if rows
        else []
    )
    return counts[view], rows, previews, counts


def read_detail(
    conn: Connection, monitor: Monitor, conversation_id: str, *, now: datetime | None = None
) -> list[Any]:
    return list(
        conn.execute(
            text(_DETAIL), {**clock_params(monitor, now), "conversation_id": conversation_id}
        )
        .mappings()
        .all()
    )


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
        "after_date": row["after_date"],
        "bucket": row["bucket"],
    }


def page_view(
    open_value: Opener,
    monitor: Monitor,
    *,
    page: tuple[int, list[Any], list[Any], dict[str, int]],
    offset: int,
    view: str = "upcoming",
) -> dict[str, Any]:
    count, rows, previews, counts = page
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
        "view": view,
        "view_counts": counts,
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
        "after_date": row["after_date"],
        "bucket": row["bucket"],
        # How many other emails restated this request; their sources stay stored.
        "repeat_count": int(row["repeat_count"]),
    }
