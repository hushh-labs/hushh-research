"""Read-only Calendar insights. No persistence, inferred artifacts or scheduling writes."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta
from urllib.parse import quote

from hushh_mcp.services.calendar_invitations import occurrence_key
from hushh_mcp.services.calendar_schedule_service import (
    day_window,
    get_calendar_schedule_service,
    local_day_window,
)
from hushh_mcp.services.google_connection_service import GoogleConnectionError


def _occurrence_id(event):
    return hashlib.sha256(json.dumps(occurrence_key(event), sort_keys=True).encode()).hexdigest()


def _grant_id(binding):
    return hashlib.sha256(json.dumps(binding).encode()).hexdigest()


class CalendarInsightsService:
    def __init__(self, schedule=None, *, account_id="default"):
        self.schedule = schedule or get_calendar_schedule_service()
        self.calendar = self.schedule.calendar
        self.account_id = account_id

    async def grant(self, user_id):
        identity = await self.calendar.connections.read_calendar_grant_identity(user_id=user_id)
        if not identity or identity.account_id != self.account_id:
            raise GoogleConnectionError("Reconnect the selected Calendar account.", status_code=403)
        return identity

    def _occurrence_id_for_event(self, event, calendar_id, *, summarized=False):
        summary = event if summarized else self.calendar._event_summary(event)
        return _occurrence_id({**summary, "calendar_id": calendar_id})

    async def events(self, *, user_id, start, end):
        binding = await self.schedule._read_binding(user_id)
        calendars = await self.schedule._included_calendars(user_id, binding=binding)
        events, complete = [], True
        for source in calendars:
            if source.get("access_role") not in {
                "owner",
                "writer",
                "reader",
                "writerWithoutPrivateAccess",
            }:
                complete = False
                continue
            token, seen = None, set()
            for _ in range(20):
                page = await self.calendar.list_events(
                    user_id=user_id,
                    start_at=start.isoformat(),
                    end_at=end.isoformat(),
                    calendar_id=source["id"],
                    max_results=250,
                    page_token=token,
                    expected_binding=binding,
                )
                events.extend(
                    {
                        **event,
                        "availability_default_included": source.get(
                            "availability_default_included", True
                        ),
                    }
                    for event in page["events"]
                )
                token = page.get("next_page_token")
                if not token:
                    if page.get("truncated"):
                        complete = False
                    break
                if token in seen:
                    raise GoogleConnectionError(
                        "Calendar pagination changed. Refresh Insights.", status_code=502
                    )
                seen.add(token)
            else:
                complete = False
        await self.calendar._check_read_binding(user_id, binding)
        # A shared invitation can appear on multiple included calendars.
        # Provider iCalUID plus occurrence identity is authoritative; titles are not.
        unique = {}
        for event in events:
            occurrence = event.get("original_start_time") or event.get("start") or {}
            occurrence_id = occurrence.get("date")
            if occurrence.get("dateTime"):
                occurrence_id = (
                    datetime.fromisoformat(occurrence["dateTime"].replace("Z", "+00:00"))
                    .astimezone(UTC)
                    .isoformat()
                )
            key = (
                ("ical", event["ical_uid"], occurrence_id)
                if event.get("ical_uid")
                else ("event", event.get("calendar_id"), event.get("id"))
            )
            if key not in unique or (
                event.get("availability_default_included")
                and not unique[key].get("availability_default_included")
            ):
                unique[key] = event
        return list(unique.values()), complete

    async def overview(self, *, user_id, date, time_zone):
        first = datetime.fromisoformat(date).date()
        first -= timedelta(days=first.weekday())
        start, _ = day_window(first.isoformat(), time_zone)
        _, end = day_window((first + timedelta(days=6)).isoformat(), time_zone)
        events, complete = await self.events(user_id=user_id, start=start, end=end)
        days = [
            {"date": (first + timedelta(days=i)).isoformat(), "minutes": 0, "meetings": 0}
            for i in range(7)
        ]
        timed, recurring = [], {}
        focus_safe = complete
        for event in events:
            if (
                not event.get("availability_default_included", True)
                or event.get("status") == "cancelled"
                or any(
                    a.get("self") and a.get("response_status") == "declined"
                    for a in event.get("attendees", [])
                )
            ):
                continue
            if (event.get("start") or {}).get("date") and event.get(
                "transparency"
            ) != "transparent":
                focus_safe = False
            raw_start, raw_end = ((event.get(k) or {}).get("dateTime") for k in ("start", "end"))
            if not raw_start or not raw_end:
                continue
            begin, finish = (
                datetime.fromisoformat(v.replace("Z", "+00:00")) for v in (raw_start, raw_end)
            )
            if begin.tzinfo is None or finish.tzinfo is None or finish <= begin:
                continue
            for day in days:
                left, right = day_window(day["date"], time_zone)
                minutes = max(0, (min(finish, right) - max(begin, left)).total_seconds() / 60)
                day["minutes"] += minutes
                if minutes:
                    day["meetings"] += 1
            timed.append((begin, finish, event))
            if event.get("recurring_event_id"):
                key = (event.get("calendar_id"), event["recurring_event_id"])
                row = recurring.setdefault(key, {"title": event["title"], "minutes": 0})
                row["minutes"] += max(
                    0, (min(finish, end) - max(begin, start)).total_seconds() / 60
                )
        timed.sort(key=lambda entry: entry[0])
        busy = [entry for entry in timed if entry[2].get("transparency") != "transparent"]
        overlaps = sum(
            a[0] < b[1] and b[0] < a[1] for i, a in enumerate(busy) for b in busy[i + 1 :]
        )
        back_to_back = sum(a[1] == b[0] for i, a in enumerate(busy) for b in busy[i + 1 :])
        focus = []
        if focus_safe:
            for day in days[:5]:
                left, right = day_window(day["date"], time_zone, "09:00", "17:00")
                cursor = left
                for begin, finish, _ in busy:
                    if finish <= left or begin >= right:
                        continue
                    if begin - cursor >= timedelta(hours=1):
                        focus.append(
                            {
                                "start_at": cursor.isoformat(),
                                "end_at": min(begin, right).isoformat(),
                            }
                        )
                    cursor = max(cursor, min(finish, right))
                if right - cursor >= timedelta(hours=1):
                    focus.append({"start_at": cursor.isoformat(), "end_at": right.isoformat()})
        return {
            "complete": complete,
            "days": days,
            "meeting_count": len(timed),
            "meeting_minutes": sum(d["minutes"] for d in days),
            "overlaps": overlaps,
            "back_to_back": back_to_back,
            "recurring": list(recurring.values()),
            "focus": focus[:6],
            "time_zone": time_zone,
        }

    async def library(self, *, user_id, date, time_zone, cursor=None, query="", kind="all"):
        from hushh_mcp.services.calendar_meeting_library import meeting_library

        return await meeting_library(
            self,
            user_id=user_id,
            date=date,
            time_zone=time_zone,
            cursor=cursor,
            query=query,
            kind=kind,
        )

    async def raw_event(
        self,
        *,
        user_id,
        calendar_id,
        event_id,
        expected_account_email=None,
        expected_grant=None,
        occurrence_id=None,
        date=None,
        time_zone=None,
    ):
        grant = await self.grant(user_id)
        binding = grant.binding
        if expected_grant and expected_grant != _grant_id(binding):
            raise GoogleConnectionError(
                "Calendar grant changed. Refresh this day.", status_code=409
            )
        if expected_account_email is not None:
            status = await self.calendar.connections.status(user_id=user_id, service="calendar")
            if (status.get("google_email") or "").casefold() != expected_account_email.casefold():
                raise GoogleConnectionError(
                    "Calendar account changed. Refresh Calendar.", status_code=409
                )
            await self.calendar._check_read_binding(user_id, binding)
        event = await self.calendar._request(
            user_id=user_id,
            method="GET",
            path=f"/calendars/{quote(calendar_id, safe='')}/events/{quote(event_id, safe='')}",
            access="read",
            expected_binding=binding,
        )
        if event.get("id") != event_id or event.get("status") == "cancelled":
            raise GoogleConnectionError("Meeting is unavailable", status_code=404)
        if (
            occurrence_id
            and _occurrence_id({**self.calendar._event_summary(event), "calendar_id": calendar_id})
            != occurrence_id
        ):
            raise GoogleConnectionError(
                "Meeting occurrence changed. Refresh this day.", status_code=409
            )
        if date or time_zone:
            if not date or not time_zone:
                raise GoogleConnectionError("Choose a meeting day and refresh.", status_code=422)
            start, end = local_day_window(date, time_zone)
            event_start = (event.get("start") or {}).get("dateTime")
            try:
                actual_start = datetime.fromisoformat(event_start.replace("Z", "+00:00"))
            except (AttributeError, ValueError) as exc:
                raise GoogleConnectionError(
                    "Meeting time changed. Refresh this day.", status_code=409
                ) from exc
            if actual_start.tzinfo is None or not start <= actual_start < end:
                raise GoogleConnectionError(
                    "Meeting day changed. Refresh this day.", status_code=409
                )
        return grant, event
