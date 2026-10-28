"""Meet record and generated-file association for one verified Calendar occurrence."""

from __future__ import annotations

import re
from datetime import datetime

import httpx

from hushh_mcp.services.calendar_meeting_common import ArtifactUnavailable
from hushh_mcp.services.google_drive_adapter import FILE_ID


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


def _conference_code(event):
    conference = event.get("conferenceData") or {}
    code = conference.get("conferenceId", "")
    if (conference.get("conferenceSolution") or {}).get("key", {}).get(
        "type"
    ) != "hangoutsMeet" or not re.fullmatch(r"[a-z]{3}-[a-z]{4}-[a-z]{3}", code):
        return None
    return code


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


async def _generated_files(service, token, name, check, refs, states):
    for resource, kind, destination, key in [
        ("recordings", "recording", "driveDestination", "file"),
        ("smartNotes", "notes", "docsDestination", "document"),
        ("transcripts", "transcript", "docsDestination", "document"),
    ]:
        try:
            items = await service._meet_pages(token, f"{name}/{resource}", resource)
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
            states[kind] = error.state
        except (ValueError, TypeError, AttributeError):
            states[kind] = "temporarily_unavailable"


async def _discover(
    service, user_id, grant, event, calendar_id, code, refs, states, inspect_token, meet_scopes
):
    calendar = service.insights.calendar

    async def check():
        await calendar._check_read_binding(user_id, grant.binding)

    await check()
    token = await calendar.connections.access_token(
        user_id=user_id, service="calendar", access_level="read"
    )
    scopes = await inspect_token(token, grant.provider_subject)
    await check()
    if not scopes & meet_scopes:
        raise ArtifactUnavailable("permission_required")
    begin, finish = _event_window(event)
    matches = await service._meet_pages(
        token,
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
    await _generated_files(service, token, name, check, refs, states)
    return next(
        (
            state
            for state in (
                "permission_required",
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
    refs = _attachment_refs(event) if for_chat else []
    states = {}
    code = _conference_code(event)
    if not code:
        return refs, "unavailable", states
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
        return (
            list({(ref["file_id"], ref["kind"]): ref for ref in refs}.values()),
            discovery,
            states,
        )
    except ArtifactUnavailable as error:
        return refs, error.state, states
    except (httpx.HTTPError, ValueError, TypeError, AttributeError):
        return refs, "temporarily_unavailable", states
