"""An attendee's meeting links, read from the organizer's own copy of the exact occurrence."""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime
from urllib.parse import quote

from hushh_mcp.services.google_connection_contract import GoogleConnectionError

logger = logging.getLogger(__name__)

_ORGANIZER_COPY_SECONDS = 6


def conference_code(event):
    conference = event.get("conferenceData") or {}
    code = conference.get("conferenceId", "")
    if (conference.get("conferenceSolution") or {}).get("key", {}).get(
        "type"
    ) != "hangoutsMeet" or not re.fullmatch(r"[a-z]{3}-[a-z]{4}-[a-z]{3}", code):
        return None
    return code


def _domain(email):
    return email.rsplit("@", 1)[1].casefold() if isinstance(email, str) and "@" in email else ""


def _instant(value):
    try:
        moment = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo is not None else None


def _selected_email(event, calendar_id):
    """The selected account, as Google itself marks it on this event's guest list."""
    for guest in event.get("attendees") or []:
        if isinstance(guest, dict) and guest.get("self") is True:
            return str(guest.get("email") or "")
    return calendar_id if "@" in str(calendar_id) else ""


# Only what identifies the occurrence and links its files: nothing else of the organizer's
# calendar (guests, description, location) is requested.
_COPY_FIELDS = (
    "items(iCalUID,status,start,end,organizer(email),"
    "conferenceData(conferenceId,conferenceSolution(key(type))),"
    "attachments(fileId,fileUrl,title,mimeType))"
)


def _organizer_email(event):
    return str((event.get("organizer") or {}).get("email") or "").casefold()


def _is_same_occurrence(copy, event, code):
    """Same meeting and same occurrence, judged only by facts that identify them.

    Event ids can differ between copies of one event, so identity is the iCalUID together
    with the exact start instant (which tells the occurrences of a recurring series apart),
    the Meet code and the organizer. Anything less is not used.
    """
    if not isinstance(copy, dict) or copy.get("status") == "cancelled":
        return False
    start = _instant((copy.get("start") or {}).get("dateTime"))
    return bool(
        copy.get("iCalUID")
        and copy.get("iCalUID") == event.get("iCalUID")
        and start is not None
        and start == _instant((event.get("start") or {}).get("dateTime"))
        and conference_code(copy) == code
        and _organizer_email(copy)
        and _organizer_email(copy) == _organizer_email(event)
    )


# What Google's refusal of the organizer's calendar means, named for the log only. It never
# changes what is claimed: every outcome other than "found" claims nothing.
_REFUSAL_REASONS = {
    "calendar_unreadable": "unreadable",
    "calendar_permission_required": "unreadable",
    "calendar_not_found": "not_found",
    "calendar_timeout": "timeout",
}


def _refusal_outcome(error):
    if isinstance(error, TimeoutError):
        return "timeout"
    if isinstance(error, GoogleConnectionError):
        return _REFUSAL_REASONS.get(error.reason_code or "", "error")
    return "error"


async def _organizer_copy_refs(service, user_id, grant, event, calendar_id, code, link_refs):
    """Exact Calendar links on the organizer's own copy of this occurrence, with the outcome.

    An attendee's copy can lack the links Meet added for the organizer. Only for a colleague
    on the same Workspace domain are the organizer's events in this occurrence's own time
    window listed, with the selected account's authority. Google decides whether that is
    allowed, so a refusal (403, 404, timeout) means only "not readable" and claims nothing.
    The domain decides whether to ask, never what is trusted: exactly one event must match
    the occurrence's identity, and an ambiguous or absent match is ignored.

    The outcome names the stage that stopped, so a missing file can be told apart from an
    unreadable organizer calendar; it carries no identifiers and is never shown as a claim.
    Each name stays under 24 characters: the log redactor masks longer identifier-shaped values.
    """
    organizer = event.get("organizer") or {}
    email = organizer.get("email")
    start, end = ((event.get(key) or {}).get("dateTime") for key in ("start", "end"))
    selected = _selected_email(event, calendar_id)
    if (
        organizer.get("self") is True
        or not isinstance(email, str)
        or not (start and end)
        or not _domain(email)
        or _domain(email) != _domain(selected)
    ):
        return [], "not_attempted"
    try:
        async with asyncio.timeout(_ORGANIZER_COPY_SECONDS):
            page = await service.insights.calendar._request(
                user_id=user_id,
                method="GET",
                path=f"/calendars/{quote(email.casefold(), safe='')}/events",
                access="read",
                params={
                    "timeMin": start,
                    "timeMax": end,
                    "singleEvents": "true",
                    "maxResults": "50",
                    "fields": _COPY_FIELDS,
                },
                expected_binding=grant.binding,
            )
    except Exception as error:  # not shared with this account, gone, or slow: nothing is claimed
        return [], _refusal_outcome(error)
    items = page.get("items") if isinstance(page, dict) else None
    matches = [item for item in items or [] if _is_same_occurrence(item, event, code)]
    if len(matches) != 1:
        return [], "ambiguous" if matches else "no_match"
    attachments = matches[0].get("attachments") or []
    found = link_refs(matches[0])
    if found:
        return found, "found"
    return [], "other_attachments" if attachments else "no_attachments"


async def with_organizer_copy(
    service, user_id, grant, event, calendar_id, code, refs, *, link_refs
):
    if {"recording", "notes"} <= {ref["kind"] for ref in refs}:
        return refs
    found, outcome = await _organizer_copy_refs(
        service, user_id, grant, event, calendar_id, code, link_refs
    )
    # Counts and a stage name only: no addresses, titles or file ids reach the log.
    logger.info(
        "calendar_meeting_discovery channel=organizer_copy outcome=%s found=%d "
        "own_attachments=%d own_links=%d",
        outcome,
        len(found),
        len(event.get("attachments") or []),
        len(refs),
    )
    merged = {(ref["file_id"], ref["kind"]): ref for ref in [*refs, *found]}
    return list(merged.values())[:26]
