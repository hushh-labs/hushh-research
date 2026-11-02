"""Meet record and generated-file association for one verified Calendar occurrence."""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime
from urllib.parse import parse_qs, quote, urlparse

import httpx

from hushh_mcp.services.calendar_meeting_common import ArtifactUnavailable
from hushh_mcp.services.google_drive_adapter import FILE_ID, RESOURCE_KEY

logger = logging.getLogger(__name__)

# The Meet API lists conference records only for the meeting organizer, so an attendee's own
# check can come back empty or denied for a meeting that has files. These two outcomes are
# the only ones that leave an attendee relying on the event's Calendar links.
_ATTENDEE_LIMITED = frozenset({"attendee_discovery_limited", "meet_discovery_denied"})
_ORGANIZER_COPY_SECONDS = 6


def _attachment_refs(event):
    refs = []
    for attachment in event.get("attachments", []):
        if not isinstance(attachment, dict) or not FILE_ID.fullmatch(
            str(attachment.get("fileId", ""))
        ):
            continue
        mime = attachment.get("mimeType", "")
        kind = (
            "recording"
            if mime.startswith("video/")
            else "notes"
            if mime in {"application/vnd.google-apps.document", "text/plain"}
            else None
        )
        if kind:
            refs.append(
                {
                    "file_id": attachment["fileId"],
                    "kind": kind,
                    "association": "calendar_attachment",
                    "linked_only": True,
                }
            )
    return refs


def library_attachment_refs(event):
    """Exact occurrence links, admitted only with a provider-style file label.

    Calendar permits arbitrary attachments, so an ordinary Doc or video must
    not be represented as a generated meeting artifact. These references keep
    Calendar provenance; Meet resource references remain the stronger proof.
    """
    refs = []
    for attachment in event.get("attachments") or []:
        if not isinstance(attachment, dict):
            continue
        file_id = attachment.get("fileId")
        if not isinstance(file_id, str) or not FILE_ID.fullmatch(file_id):
            continue
        title = str(attachment.get("title") or "").casefold()
        mime = attachment.get("mimeType")
        notes_label = "notes by gemini" in title or "meeting notes" in title
        recording_label = "recording" in title
        if mime == "application/vnd.google-apps.document" and notes_label:
            kind = "notes"
        elif isinstance(mime, str) and mime.startswith("video/") and recording_label:
            kind = "recording"
        elif mime == "application/vnd.google-apps.shortcut" and (notes_label or recording_label):
            kind = "notes" if notes_label else "recording"
        else:
            continue
        ref = {
            "file_id": file_id,
            "kind": kind,
            "association": "calendar_attachment",
            "provenance": "calendar_linked",
        }
        file_url = attachment.get("fileUrl")
        if isinstance(file_url, str):
            try:
                parsed = urlparse(file_url)
                key = parse_qs(parsed.query).get("resourcekey", [None])[0]
                if (
                    parsed.scheme == "https"
                    and parsed.hostname in {"drive.google.com", "docs.google.com"}
                    and isinstance(key, str)
                    and RESOURCE_KEY.fullmatch(key)
                ):
                    ref["resource_key"] = key
            except ValueError:
                pass
        refs.append(ref)
    # Keep one sentinel so a provider response beyond the bounded file budget
    # cannot be reported as a complete empty or complete partial result.
    return refs[:26]


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
        and _conference_code(copy) == code
        and _organizer_email(copy)
        and _organizer_email(copy) == _organizer_email(event)
    )


async def _organizer_copy_refs(service, user_id, grant, event, calendar_id, code):
    """Exact Calendar links on the organizer's own copy of this occurrence.

    An attendee's copy can lack the links Meet added for the organizer. Only for a colleague
    on the same Workspace domain are the organizer's events in this occurrence's own time
    window listed, with the selected account's authority. Google decides whether that is
    allowed, so a refusal (403, 404, timeout) means only "not readable" and claims nothing.
    The domain decides whether to ask, never what is trusted: exactly one event must match
    the occurrence's identity, and an ambiguous or absent match is ignored.
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
        return []
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
    except Exception:  # not shared with this account, gone, or slow: nothing is claimed
        return []
    items = page.get("items") if isinstance(page, dict) else None
    matches = [item for item in items or [] if _is_same_occurrence(item, event, code)]
    return library_attachment_refs(matches[0]) if len(matches) == 1 else []


async def _with_organizer_copy(service, user_id, grant, event, calendar_id, code, refs):
    if {"recording", "notes"} <= {ref["kind"] for ref in refs}:
        return refs
    found = await _organizer_copy_refs(service, user_id, grant, event, calendar_id, code)
    logger.info("calendar_meeting_discovery channel=organizer_copy found=%d", len(found))
    merged = {(ref["file_id"], ref["kind"]): ref for ref in [*refs, *found]}
    return list(merged.values())[:26]


def _conference_code(event):
    conference = event.get("conferenceData") or {}
    code = conference.get("conferenceId", "")
    if (conference.get("conferenceSolution") or {}).get("key", {}).get(
        "type"
    ) != "hangoutsMeet" or not re.fullmatch(r"[a-z]{3}-[a-z]{4}-[a-z]{3}", code):
        return None
    return code


def _has_meet_link(event):
    conference = event.get("conferenceData")
    solution = conference.get("conferenceSolution") if isinstance(conference, dict) else None
    key = solution.get("key") if isinstance(solution, dict) else None
    if isinstance(key, dict) and key.get("type") == "hangoutsMeet":
        return True
    link = event.get("hangoutLink")
    if not isinstance(link, str):
        return False
    try:
        parsed = urlparse(link)
        return parsed.scheme == "https" and parsed.hostname == "meet.google.com"
    except ValueError:
        return False


def _event_window(event):
    start, end = ((event.get(k) or {}).get("dateTime") for k in ("start", "end"))
    if not start or not end:
        raise ArtifactUnavailable("unverified")
    begin, finish = (datetime.fromisoformat(v.replace("Z", "+00:00")) for v in (start, end))
    if begin.tzinfo is None or finish.tzinfo is None:
        raise ArtifactUnavailable("unverified")
    return begin, finish


async def _missing_record_state(service, user_id, grant, event, check):
    organizer = event.get("organizer") or {}
    account = await service.insights.calendar.connections.status(
        user_id=user_id, service="calendar"
    )
    await check()
    owned = organizer.get("self") is True or (
        isinstance(organizer.get("email"), str)
        and isinstance(account.get("google_email"), str)
        and organizer["email"].casefold() == account["google_email"].casefold()
    )
    return "unavailable" if owned else "attendee_discovery_limited"


async def _verify_record(service, user_id, code, event, calendar_id, record, begin, finish):
    name = record.get("name", "")
    if not re.fullmatch(r"conferenceRecords/[A-Za-z0-9_-]+", name):
        raise ArtifactUnavailable("unverified")
    try:
        record_start = datetime.fromisoformat(record["startTime"].replace("Z", "+00:00"))
        record_end = datetime.fromisoformat(record["endTime"].replace("Z", "+00:00"))
        if not (record_start < finish and record_end > begin):
            raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise ArtifactUnavailable("unverified") from None
    candidates, complete = await service.insights.events(
        user_id=user_id, start=min(begin, record_start), end=max(finish, record_end)
    )
    if not complete:
        raise ArtifactUnavailable("unverified")
    target = service.insights._occurrence_id_for_event(event, calendar_id)
    matching = set()
    for candidate in candidates:
        if candidate.get("conference_id") != code:
            continue
        candidate_start = (candidate.get("start") or {}).get("dateTime")
        candidate_end = (candidate.get("end") or {}).get("dateTime")
        if not candidate_start or not candidate_end:
            continue
        left = datetime.fromisoformat(candidate_start.replace("Z", "+00:00"))
        right = datetime.fromisoformat(candidate_end.replace("Z", "+00:00"))
        if left.tzinfo is None or right.tzinfo is None:
            raise ArtifactUnavailable("unverified")
        if left < record_end and right > record_start:
            matching.add(
                service.insights._occurrence_id_for_event(
                    candidate, candidate.get("calendar_id", ""), summarized=True
                )
            )
    if matching != {target}:
        raise ArtifactUnavailable("unverified")
    return name


async def _generated_files(service, meet_pages, name, check, refs, states):
    for resource, kind, destination, key in [
        ("recordings", "recording", "driveDestination", "file"),
        ("smartNotes", "notes", "docsDestination", "document"),
        ("transcripts", "transcript", "docsDestination", "document"),
    ]:
        try:
            items = await meet_pages(f"{name}/{resource}", resource)
            await check()
            states[kind] = "not_generated"
            for item in items:
                if not re.fullmatch(
                    rf"{re.escape(name)}/{resource}/[A-Za-z0-9_-]+", str(item.get("name", ""))
                ):
                    raise ArtifactUnavailable("temporarily_unavailable")
                state = item.get("state")
                if state in {"STARTED", "ENDED"}:
                    states[kind] = "processing"
                elif state == "FILE_GENERATED":
                    identifier = (item.get(destination) or {}).get(key, "")
                    if not FILE_ID.fullmatch(identifier):
                        raise ArtifactUnavailable("temporarily_unavailable")
                    refs.append(
                        {"file_id": identifier, "kind": kind, "association": item.get("name")}
                    )
                    if states[kind] != "processing":
                        states[kind] = "available"
                else:
                    raise ArtifactUnavailable("temporarily_unavailable")
        except ArtifactUnavailable as error:
            states[kind] = (
                "temporarily_unavailable" if error.state == "token_rejected" else error.state
            )
        except (ValueError, TypeError, AttributeError):
            states[kind] = "temporarily_unavailable"


async def _initial_meet_token(calendar, user_id, grant, check, inspect_token, meet_scopes):
    token = await calendar.connections.access_token(
        user_id=user_id, service="calendar", access_level="read"
    )
    refreshed = False
    try:
        scopes = await inspect_token(token, grant.provider_subject)
    except ArtifactUnavailable as error:
        if error.state != "token_rejected":
            raise
        refreshed = True
        token = await calendar.connections.access_token(
            user_id=user_id, service="calendar", access_level="read", force_refresh=True
        )
        try:
            scopes = await inspect_token(token, grant.provider_subject)
        except ArtifactUnavailable as second:
            raise ArtifactUnavailable(
                "temporarily_unavailable" if second.state == "token_rejected" else second.state
            ) from None
    await check()
    if not scopes & meet_scopes:
        raise ArtifactUnavailable("permission_required")
    return token, refreshed


def _meet_discovery_state(state):
    if state == "token_rejected":
        return "temporarily_unavailable"
    return "meet_discovery_denied" if state == "resource_denied" else state


async def _discover(
    service, user_id, grant, event, calendar_id, code, refs, states, inspect_token, meet_scopes
):
    calendar = service.insights.calendar

    async def check():
        await calendar._check_read_binding(user_id, grant.binding)

    await check()
    token, refreshed = await _initial_meet_token(
        calendar, user_id, grant, check, inspect_token, meet_scopes
    )

    async def meet_pages(path, field, params=None, *, page_size=100):
        nonlocal token, refreshed
        try:
            return await service._meet_pages(token, path, field, params, page_size=page_size)
        except ArtifactUnavailable as error:
            if error.state != "token_rejected" or refreshed:
                raise ArtifactUnavailable(_meet_discovery_state(error.state)) from None
        refreshed = True
        token = await calendar.connections.access_token(
            user_id=user_id, service="calendar", access_level="read", force_refresh=True
        )
        try:
            scopes = await inspect_token(token, grant.provider_subject)
        except ArtifactUnavailable as error:
            raise ArtifactUnavailable(_meet_discovery_state(error.state)) from None
        await check()
        if not scopes & meet_scopes:
            raise ArtifactUnavailable("permission_required")
        try:
            return await service._meet_pages(token, path, field, params, page_size=page_size)
        except ArtifactUnavailable as error:
            raise ArtifactUnavailable(_meet_discovery_state(error.state)) from None

    begin, finish = _event_window(event)
    matches = await meet_pages(
        "conferenceRecords",
        "conferenceRecords",
        {
            "filter": f'space.meeting_code = "{code}" AND end_time > "{begin.isoformat()}" AND start_time < "{finish.isoformat()}"'
        },
        page_size=100,
    )
    await check()
    if len(matches) > 1:
        raise ArtifactUnavailable("unverified")
    if not matches:
        return await _missing_record_state(service, user_id, grant, event, check)
    name = await _verify_record(
        service, user_id, code, event, calendar_id, matches[0], begin, finish
    )
    await _generated_files(service, meet_pages, name, check, refs, states)
    return next(
        (
            state
            for state in (
                "permission_required",
                "account_mismatch",
                "provider_configuration",
                "provider_policy",
                "meet_discovery_denied",
                "resource_denied",
                "temporarily_unavailable",
                "processing",
                "unavailable",
            )
            if state in states.values()
        ),
        "checked",
    )


async def meeting_references(
    service, user_id, grant, event, calendar_id, *, for_chat, inspect_token, meet_scopes
):
    refs = _attachment_refs(event) if for_chat else library_attachment_refs(event)
    attachment_truncated = not for_chat and len(refs) > 25
    if attachment_truncated:
        refs = refs[:25]
    states = {}
    code = _conference_code(event)
    if not code:
        return (
            refs,
            "files_incomplete"
            if attachment_truncated
            else "unverified"
            if _has_meet_link(event)
            else "unavailable",
            states,
        )
    try:
        discovery = await _discover(
            service,
            user_id,
            grant,
            event,
            calendar_id,
            code,
            refs,
            states,
            inspect_token,
            meet_scopes,
        )
        refs = list({(ref["file_id"], ref["kind"]): ref for ref in refs}.values())
        if attachment_truncated and discovery in {"checked", "unavailable"}:
            discovery = "files_incomplete"
    except ArtifactUnavailable as error:
        discovery = error.state
    except (httpx.HTTPError, ValueError, TypeError, AttributeError):
        discovery = "temporarily_unavailable"
    if not for_chat and discovery in _ATTENDEE_LIMITED:
        refs = await _with_organizer_copy(service, user_id, grant, event, calendar_id, code, refs)
    return refs, discovery, states
