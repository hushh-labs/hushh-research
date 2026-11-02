"""The owner's own decline reason, kept with the RSVP so every copy can explain it."""

from __future__ import annotations

from typing import Any

# Google keeps an RSVP comment with the attendee; stay well inside its limit.
DECLINE_COMMENT_LIMIT = 500


def clean_decline_reason(reason: object, response_status: str) -> str:
    """One tidy line, and only for a decline."""
    if response_status != "declined":
        return ""
    return " ".join(str(reason or "").split())[:DECLINE_COMMENT_LIMIT]


def patch_with_comment(patch: dict[str, Any], comment: object) -> dict[str, Any]:
    """Return the sealed attendance patch with the owner's reason attached."""
    reason = str(comment or "").strip()
    if not reason:
        return patch
    attendees = [{**item, "comment": reason} for item in patch.get("attendees", [])]
    return {**patch, "attendees": attendees}
