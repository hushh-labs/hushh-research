"""The closed meeting-file context a Calendar request adds to its Feed rows.

The Feed table holds no plaintext, so which meeting files a request asked for,
and which the organizer said they do not have, is read from the participant's
own sealed request for the request ids on one page. Only the closed
``recording`` / ``notes`` vocabulary leaves the envelope: no title, time, email
or file. A request that is not a Calendar meeting, or one that cannot be opened,
leaves its row exactly as it was.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from typing import Any
from uuid import UUID

logger = logging.getLogger(__name__)

CALENDAR_CONTEXT_EVENTS = frozenset(
    {"document_share_request", "document_share_request_sent", "document_share_decided"}
)
# Allowed through the Feed's metadata whitelist; set only by this module.
CALENDAR_CONTEXT_KEYS = ("calendar_meeting", "calendar_requested_types", "not_available_types")
_KINDS = ("recording", "notes")


def _needs_context(row: dict[str, Any]) -> bool:
    return row.get("event_type") in CALENDAR_CONTEXT_EVENTS and isinstance(
        row.get("metadata"), dict
    )


def _request_ids(rows: list[dict[str, Any]]) -> list[str]:
    wanted: set[str] = set()
    for row in rows:
        if not _needs_context(row):
            continue
        try:
            wanted.add(str(UUID(str(row["metadata"].get("request_id") or ""))))
        except (TypeError, ValueError, AttributeError):
            continue
    return sorted(wanted)


def _closed(values: Any) -> str:
    """The closed types as one scalar, e.g. ``recording,notes``: Feed metadata carries no lists."""
    return ",".join(kind for kind in _KINDS if kind in (values or ()))


def _context_of(cipher: Any, item: dict[str, Any]) -> dict[str, Any] | None:
    try:
        private = cipher.open(
            item["request_envelope"],
            user_id=item["user_id"],
            resource_id=str(item["request_id"]),
            purpose="request",
        )
    except Exception:  # one unreadable request never hides the others' context
        logger.warning("feed.calendar_request_context_unreadable")
        return None
    calendar = private.get("calendar")
    if private.get("request_type") != "calendar_meeting" or not isinstance(calendar, dict):
        return None
    return {
        "calendar_meeting": True,
        "calendar_requested_types": _closed(calendar.get("requested_types")),
        # Empty means the organizer has not said anything; the Feed drops an empty value.
        "not_available_types": _closed(calendar.get("not_available_types")),
    }


def _contexts(get_db: Callable[[], Any], user_id: str, ids: list[str]) -> dict[str, dict[str, Any]]:
    from hushh_mcp.services.drive_sharing_contract import DriveSharingCipher

    cipher = DriveSharingCipher()
    envelopes = (
        get_db()
        .execute_raw(
            """SELECT request_id::TEXT AS request_id, user_id, request_envelope
            FROM drive_share_requests
            WHERE (user_id=:user_id OR recipient_user_id=:user_id)
              AND request_id IN (SELECT CAST(value AS UUID)
                FROM jsonb_array_elements_text(CAST(:ids AS JSONB)))""",
            {"user_id": user_id, "ids": json.dumps(ids)},
        )
        .data
        or []
    )
    found = {str(item["request_id"]): _context_of(cipher, item) for item in envelopes}
    return {request_id: context for request_id, context in found.items() if context}


def with_calendar_request_context(
    get_db: Callable[[], Any], user_id: str, rows: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Add the meeting-file context to this participant's Calendar request rows."""
    ids = _request_ids(rows)
    if not ids:
        return rows
    try:
        context = _contexts(get_db, user_id, ids)
    except Exception as exc:  # presentation must not break Feed availability
        logger.warning("feed.calendar_request_context_unavailable error=%s", type(exc).__name__)
        return rows
    if not context:
        return rows
    result: list[dict[str, Any]] = []
    for row in rows:
        extra = (
            context.get(str(row["metadata"].get("request_id") or ""))
            if _needs_context(row)
            else None
        )
        result.append({**row, "metadata": {**row["metadata"], **extra}} if extra else row)
    return result
