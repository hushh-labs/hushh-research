"""A person's thumbs on their own agent's answers, kept in their own agent.

The hub stores ratings in ``one_agent_message_feedback`` for Shared owners. For an
owner whose agent runs in their own cloud the hub refuses that route, so the rating
is recorded here instead: one record per change in the pod's sealed commit log,
folded newest-wins per (conversation, message). Like the hub table it carries ids
and two closed enums only, never a prompt, an answer or any free text.

Contract:

* **Owner-bound.** The pod has one owner; every record names that owner and this
  pod's ``hushh_id``, and a record for anyone else is ignored on read.
* **Existing conversations only.** A rating names a conversation the pod's own
  encrypted conversation store holds, checked against the ciphertext projection
  without decrypting it.
* **Bounded.** Ids are length-capped and charset-checked; a conversation keeps at
  most ``MAX_RATINGS_PER_CONVERSATION`` ratings on read.
* **Reads fail open.** An opinion about a turn is not part of the turn, so a read
  failure returns no ratings rather than stopping a conversation from loading.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from hushh_mcp.services.message_feedback_service import (
    VALID_RATINGS,
    VALID_REPORT_REASONS,
    MessageFeedbackError,
)

logger = logging.getLogger(__name__)

POD_FEEDBACK_KIND = "pod.one.feedback.v1"
MAX_RATINGS_PER_CONVERSATION = 500
_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,200}$")


def _clean_id(value: str | None, *, code: str, label: str) -> str:
    text = str(value or "").strip()
    if not _ID.fullmatch(text):
        raise MessageFeedbackError(f"{label} is required.", code=code)
    return text


def normalize_feedback(
    *, conversation_ref: str, message_ref: str, rating: str | None, report_reason: str | None
) -> tuple[str, str, str | None, str | None]:
    """Validate exactly as the hub service does; a report is always a ``down``."""
    conversation = _clean_id(conversation_ref, code="CONVERSATION_REQUIRED", label="A conversation")
    message = _clean_id(message_ref, code="MESSAGE_REQUIRED", label="A message")
    reason = str(report_reason or "").strip().lower() or None
    if reason is not None:
        if reason not in VALID_REPORT_REASONS:
            raise MessageFeedbackError(
                "Report reason is not recognised.", code="REPORT_REASON_INVALID"
            )
        rating = "down"
    normalized = str(rating or "").strip().lower() or None
    if normalized is not None and normalized not in VALID_RATINGS:
        raise MessageFeedbackError("Rating is not recognised.", code="RATING_INVALID")
    return conversation, message, normalized, reason


def fold_ratings(
    records: list[dict[str, Any]], *, owner: str, hushh_id: str, conversation: str
) -> dict[str, str]:
    """Newest-wins ratings for one conversation; a cleared rating drops out."""
    ratings: dict[str, str] = {}
    for record in records or []:
        if (record or {}).get("kind") != POD_FEEDBACK_KIND:
            continue
        payload = record.get("payload")
        if (
            not isinstance(payload, dict)
            or payload.get("owner") != owner
            or payload.get("hushhId") != hushh_id
            or payload.get("conversation") != conversation
        ):
            continue
        message = payload.get("message")
        if not isinstance(message, str) or not _ID.fullmatch(message):
            continue
        rating = payload.get("rating")
        ratings.pop(message, None)
        if rating in VALID_RATINGS:
            ratings[message] = rating
    while len(ratings) > MAX_RATINGS_PER_CONVERSATION:
        ratings.pop(next(iter(ratings)))
    return ratings


async def conversation_exists(app_name: str, conversation: str) -> bool:
    """Whether the pod's encrypted conversation store holds this conversation."""
    from hushh_mcp.one_adk import pod_agui_context

    projection = pod_agui_context._projection
    if projection is None:
        return False
    _, entries = await projection.snapshot()
    row = entries.get((app_name, conversation))
    return bool(row) and not row.get("deleted")


async def record_feedback(
    log: Any,
    *,
    owner: str,
    hushh_id: str,
    conversation: str,
    message: str,
    rating: str | None,
    report_reason: str | None,
) -> dict[str, Any]:
    payload = {
        "format": 1,
        "owner": owner,
        "hushhId": hushh_id,
        "conversation": conversation,
        "message": message,
        "rating": rating,
        **({"reportReason": report_reason} if report_reason else {}),
    }
    await log.append(POD_FEEDBACK_KIND, payload)
    recorded: dict[str, Any] = {
        "conversation_id": conversation,
        "message_id": message,
        "rating": rating,
    }
    if report_reason:
        # Ids and the reason enum only, in the owner's own agent log.
        logger.warning(
            "pod_agent_response_reported reason=%s conversation=%s message=%s",
            report_reason,
            conversation,
            message,
        )
        recorded["reported"] = True
        recorded["report_reason"] = report_reason
    return recorded


async def read_feedback(log: Any, *, owner: str, hushh_id: str, conversation: str) -> dict:
    clean = str(conversation or "").strip()
    if not _ID.fullmatch(clean):
        return {"conversation_id": clean, "ratings": {}}
    try:
        records = await log.replay()
    except Exception:  # noqa: BLE001 - an opinion never stops a conversation loading
        logger.warning("pod_agent_feedback_read_failed")
        return {"conversation_id": clean, "ratings": {}}
    return {
        "conversation_id": clean,
        "ratings": fold_ratings(records, owner=owner, hushh_id=hushh_id, conversation=clean),
    }


__all__ = [
    "MAX_RATINGS_PER_CONVERSATION",
    "POD_FEEDBACK_KIND",
    "conversation_exists",
    "fold_ratings",
    "normalize_feedback",
    "read_feedback",
    "record_feedback",
]
