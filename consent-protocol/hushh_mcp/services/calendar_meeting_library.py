"""Bounded selected-day meeting discovery with explicit incomplete states."""

from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from hushh_mcp.services.calendar_schedule_service import local_day_window
from hushh_mcp.services.google_connection_service import GoogleConnectionError


@dataclass
class LibraryScan:
    insights: object
    user_id: str
    date: str
    time_zone: str
    query: str
    kind: str
    start: datetime
    end: datetime
    deadline: float
    grant: object
    calendars: list
    context: dict
    position: dict
    artifacts: object
    rows: dict = field(default_factory=dict)
    limits: set = field(default_factory=set)
    pages: int = 0
    checked: int = 0
    file_preflight_error: str | None = None
    calendar_incomplete: bool = False


def _position(index):
    return {"calendar_index": index, "page_token": None, "offset": 0, "page_hash": None}


async def _prepare(insights, *, user_id, date, time_zone, cursor, query, kind):
    if kind not in {"all", "recording", "notes"}:
        raise GoogleConnectionError("Choose a valid meeting filter.", status_code=422)
    query = " ".join(query.split())[:120]
    start, end = local_day_window(date, time_zone)
    deadline = asyncio.get_running_loop().time() + 32
    try:
        async with asyncio.timeout_at(deadline - 2):
            grant = await insights.grant(user_id)
            calendars = await insights.schedule._included_calendars(user_id, binding=grant.binding)
    except TimeoutError as exc:
        raise GoogleConnectionError(
            "Calendar account check timed out. Try again.", status_code=504
        ) from exc
    from hushh_mcp.services.calendar_insights_service import _grant_id

    context = {
        "user_id": user_id,
        "account_id": insights.account_id,
        "date": date,
        "time_zone": time_zone,
        "query": query,
        "kind": kind,
        "grant_id": _grant_id(grant.binding),
        "calendar_ids": [item["id"] for item in calendars],
    }
    position = _position(0)
    if cursor:
        saved = insights.schedule._open(cursor, "calendar-meeting-page-v1")
        if any(saved.get(key) != value for key, value in context.items()):
            raise GoogleConnectionError(
                "Calendar or search changed. Refresh this day.", status_code=409
            )
        position = {key: saved.get(key) for key in position}
        if not isinstance(position["calendar_index"], int) or not 0 <= position[
            "calendar_index"
        ] <= len(calendars):
            raise GoogleConnectionError("Meeting page is invalid.", status_code=422)
    from hushh_mcp.services.calendar_meeting_artifacts import CalendarMeetingArtifacts

    return LibraryScan(
        insights,
        user_id,
        date,
        time_zone,
        query,
        kind,
        start,
        end,
        deadline,
        grant,
        calendars,
        context,
        position,
        CalendarMeetingArtifacts(insights=insights),
    )


async def _preflight(scan):
    from hushh_mcp.services import calendar_meeting_artifacts as provider

    try:
        async with asyncio.timeout_at(scan.deadline - 2):
            await scan.artifacts._selected_token(scan.user_id, scan.grant)
    except provider.ArtifactUnavailable as error:
        return error.state, "missing" if error.state == "permission_required" else "unverified"
    except TimeoutError:
        return "temporarily_unavailable", "unverified"
    return None, "ready"


async def _scan_event(scan, event, calendar_id):
    if event.get("status") == "cancelled":
        return
    raw_start = (event.get("start") or {}).get("dateTime")
    raw_end = (event.get("end") or {}).get("dateTime")
    if not raw_start or not raw_end:
        return
    try:
        begin = datetime.fromisoformat(raw_start.replace("Z", "+00:00"))
        finish = datetime.fromisoformat(raw_end.replace("Z", "+00:00"))
    except ValueError as exc:
        raise GoogleConnectionError("Meeting time could not be verified.", status_code=502) from exc
    if begin.tzinfo is None or finish.tzinfo is None or not (scan.start <= begin < scan.end):
        return
    scan.checked += 1
    if scan.query.casefold() not in event.get("title", "").casefold():
        return
    occurrence = scan.insights._occurrence_id_for_event(event, calendar_id, summarized=True)
    source = {"calendar_id": calendar_id, "event_id": event["id"]}
    row = scan.rows.get(occurrence)
    if row is None:
        row = {
            **event,
            "calendar_id": calendar_id,
            "account_id": scan.insights.account_id,
            "occurrence_id": occurrence,
            "grant_id": scan.context["grant_id"],
            "sources": [],
            "artifact_kinds": [],
            "availability": {},
            "discovery": "unverified",
            "file_state": "unknown",
        }
        scan.rows[occurrence] = row
    if source not in row["sources"]:
        row["sources"].append(source)
    now = datetime.now(UTC)
    if begin > now:
        row["file_state"] = "upcoming"
        return
    if finish > now:
        row["file_state"] = "in_progress"
        return
    if scan.file_preflight_error:
        if not row["artifact_kinds"]:
            row["file_state"] = scan.file_preflight_error
            row["discovery"] = scan.file_preflight_error
        return
    if not event.get("conference_id") and not event.get("artifact_refs"):
        if not row["artifact_kinds"]:
            row["file_state"] = "unknown"
        return
    try:
        remaining = scan.deadline - asyncio.get_running_loop().time()
        async with asyncio.timeout(min(20, remaining)):
            detail = await scan.artifacts.detail(
                user_id=scan.user_id,
                calendar_id=calendar_id,
                event_id=event["id"],
                expected_grant=scan.context["grant_id"],
                occurrence_id=occurrence,
                content=False,
            )
    except TimeoutError:
        scan.limits.add("temporarily_unavailable")
        row["file_state"] = "temporarily_unavailable"
        return
    if not detail["complete"]:
        scan.limits.add(
            detail["discovery"] if detail["discovery"] != "checked" else "files_incomplete"
        )
    kinds = {
        item["kind"]
        for item in detail["artifacts"]
        if item["state"] == "available" and item["kind"] in {"recording", "notes"}
    }
    row["artifact_kinds"] = sorted(set(row["artifact_kinds"]) | kinds)
    row["discovery"] = detail["discovery"]
    for kind in ("recording", "notes"):
        available = kind in row["artifact_kinds"]
        state = (detail.get("availability") or {}).get(kind)
        if not state:
            state = next(
                (item["state"] for item in detail["artifacts"] if item["kind"] == kind),
                detail["discovery"],
            )
        if available:
            row["availability"][kind] = "available"
        elif row["availability"].get(kind) != "available":
            row["availability"][kind] = state
    if row["artifact_kinds"]:
        row["file_state"] = "available"
    elif any(state == "processing" for state in row["availability"].values()):
        row["file_state"] = "processing"
    elif any(
        state in {"resource_denied", "permission_required", "provider_policy"}
        for state in row["availability"].values()
    ):
        row["file_state"] = "access_required"
    elif any(
        state in {"temporarily_unavailable", "provider_configuration"}
        for state in row["availability"].values()
    ):
        row["file_state"] = "temporarily_unavailable"
    else:
        row["file_state"] = "unknown"


def _advance(scan, page, events, offset, page_hash):
    if offset < len(events):
        scan.position = {**scan.position, "offset": offset, "page_hash": page_hash}
        return True
    next_token = page.get("next_page_token")
    if next_token:
        if (
            not isinstance(next_token, str)
            or len(next_token) > 2048
            or next_token == scan.position["page_token"]
        ):
            raise GoogleConnectionError("Meeting pagination is invalid.", status_code=502)
        scan.position = {**scan.position, "page_token": next_token, "offset": 0, "page_hash": None}
    else:
        if page.get("truncated"):
            scan.limits.add("calendar_incomplete")
            scan.calendar_incomplete = True
        scan.position = _position(scan.position["calendar_index"] + 1)
    return False


async def _scan_page(scan, source):
    remaining = scan.deadline - asyncio.get_running_loop().time()
    try:
        async with asyncio.timeout(min(remaining, 8)):
            page = await scan.insights.calendar.list_events(
                user_id=scan.user_id,
                start_at=scan.start.isoformat(),
                end_at=scan.end.isoformat(),
                calendar_id=source["id"],
                max_results=50,
                page_token=scan.position["page_token"],
                expected_binding=scan.grant.binding,
            )
    except TimeoutError:
        scan.limits.add("temporarily_unavailable")
        scan.calendar_incomplete = True
        return True
    scan.pages += 1
    events = page.get("events")
    if not isinstance(events, list) or not all(
        isinstance(item, dict) and item.get("id") for item in events
    ):
        raise GoogleConnectionError("Meeting events could not be verified.", status_code=502)
    page_hash = hashlib.sha256(json.dumps([item["id"] for item in events]).encode()).hexdigest()
    if scan.position["page_hash"] and scan.position["page_hash"] != page_hash:
        raise GoogleConnectionError("Meeting page changed. Refresh this day.", status_code=409)
    offset = scan.position["offset"]
    if not isinstance(offset, int) or offset < 0 or offset > len(events):
        raise GoogleConnectionError("Meeting page is invalid.", status_code=422)
    while offset < len(events) and scan.checked < 12:
        if scan.deadline - asyncio.get_running_loop().time() < 2:
            scan.limits.add("request_budget")
            break
        event = events[offset]
        offset += 1
        await _scan_event(scan, event, source["id"])
    return _advance(scan, page, events, offset, page_hash)


async def _scan(scan):
    if scan.start < datetime.now(UTC) - timedelta(days=30):
        scan.limits.add("provider_retention")
    while (
        scan.position["calendar_index"] < len(scan.calendars)
        and scan.pages < 8
        and scan.checked < 12
    ):
        if scan.deadline - asyncio.get_running_loop().time() < 2:
            scan.limits.add("request_budget")
            break
        source = scan.calendars[scan.position["calendar_index"]]
        if source.get("access_role") not in {
            "owner",
            "writer",
            "reader",
            "writerWithoutPrivateAccess",
        }:
            scan.limits.add("calendar_unreadable")
            scan.calendar_incomplete = True
            scan.position = _position(scan.position["calendar_index"] + 1)
            continue
        if await _scan_page(scan, source):
            break
    await scan.insights.calendar._check_read_binding(scan.user_id, scan.grant.binding)


def _result(scan, *, meeting_file_access="ready"):
    more = scan.position["calendar_index"] < len(scan.calendars)
    next_cursor = (
        scan.insights.schedule._seal(
            {
                **scan.context,
                **scan.position,
                "expires": (datetime.now(UTC) + timedelta(minutes=10)).timestamp(),
            },
            "calendar-meeting-page-v1",
        )
        if more
        else None
    )
    meetings = sorted(scan.rows.values(), key=lambda row: row["start"]["dateTime"], reverse=True)
    return {
        "complete": not more and not scan.limits,
        "calendar_complete": not more and not scan.calendar_incomplete,
        "next_cursor": next_cursor,
        "meetings": meetings,
        "date": scan.date,
        "time_zone": scan.time_zone,
        "account_id": scan.insights.account_id,
        "limitations": sorted(scan.limits),
        "checked_events": scan.checked,
        "meeting_file_access": meeting_file_access,
    }


async def meeting_library(insights, *, user_id, date, time_zone, cursor=None, query="", kind="all"):
    """Scan one bounded selected-day slice; the encrypted cursor resumes sparse pages."""
    scan = await _prepare(
        insights,
        user_id=user_id,
        date=date,
        time_zone=time_zone,
        cursor=cursor,
        query=query,
        kind=kind,
    )
    error, meeting_file_access = await _preflight(scan)
    if error:
        scan.file_preflight_error = error
        scan.limits.add(error)
    await _scan(scan)
    return _result(scan, meeting_file_access=meeting_file_access)
