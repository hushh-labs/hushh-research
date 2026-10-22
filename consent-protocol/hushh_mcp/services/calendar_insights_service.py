"""Read-only Calendar insights. No persistence, inferred artifacts or scheduling writes."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from urllib.parse import quote

from hushh_mcp.services.calendar_schedule_service import day_window, get_calendar_schedule_service


class CalendarInsightsService:
    def __init__(self, schedule=None):
        self.schedule = schedule or get_calendar_schedule_service()
        self.calendar = self.schedule.calendar

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
            page = await self.calendar.list_events(
                user_id=user_id,
                start_at=start.isoformat(),
                end_at=end.isoformat(),
                calendar_id=source["id"],
                max_results=250,
                expected_binding=binding,
            )
            complete = complete and not page.get("truncated", False)
            events.extend(
                {
                    **event,
                    "availability_default_included": source.get(
                        "availability_default_included", True
                    ),
                }
                for event in page["events"]
            )
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

    async def library(self, *, user_id, date, time_zone, page=0):
        binding = await self.schedule._read_binding(user_id)
        _, end = day_window(date, time_zone)
        end = min(end, datetime.now(UTC))
        events, complete = await self.events(
            user_id=user_id, start=end - timedelta(days=30), end=end
        )
        candidates = [
            e
            for e in events
            if e.get("id")
            and e.get("status") != "cancelled"
            and (e.get("conference_id") or e.get("artifact_refs"))
            and (e.get("end") or {}).get("dateTime")
            and datetime.fromisoformat(e["end"]["dateTime"].replace("Z", "+00:00")) <= end
        ]
        candidates.sort(
            key=lambda e: datetime.fromisoformat(e["end"]["dateTime"].replace("Z", "+00:00")),
            reverse=True,
        )
        from hushh_mcp.services.calendar_meeting_artifacts import CalendarMeetingArtifacts

        artifacts = CalendarMeetingArtifacts(insights=self)
        semaphore = asyncio.Semaphore(3)

        async def enrich(event):
            async with semaphore:
                try:
                    async with asyncio.timeout(12):
                        detail = await artifacts.detail(
                            user_id=user_id,
                            calendar_id=event["calendar_id"],
                            event_id=event["id"],
                            content=False,
                        )
                    return {
                        **event,
                        "artifact_kinds": sorted(
                            {
                                a["kind"]
                                for a in detail["artifacts"]
                                if a["state"] == "available" and not a.get("linked_only")
                            }
                        ),
                        "artifact_status": next(
                            (
                                state
                                for state in (
                                    "permission_required",
                                    "temporarily_unavailable",
                                    "processing",
                                    "unavailable",
                                )
                                if state in detail.get("availability", {}).values()
                            ),
                            "not_generated"
                            if set(detail.get("availability", {}).values()) == {"not_generated"}
                            else detail["discovery"],
                        ),
                    }
                except TimeoutError:
                    return {
                        **event,
                        "artifact_kinds": [],
                        "artifact_status": "temporarily_unavailable",
                    }

        # Bounded provider fan-out; never claim older or unchecked files are absent.
        offset = page * 6
        meetings = await asyncio.gather(
            *(enrich(event) for event in candidates[offset : offset + 6])
        )
        await self.calendar._check_read_binding(user_id, binding)
        return {
            "complete": complete,
            "next_page": page + 1 if len(candidates) > offset + 6 else None,
            "window_days": 30,
            "meetings": meetings,
        }

    async def raw_event(self, *, user_id, calendar_id, event_id, expected_account_email=None):
        binding = await self.schedule._read_binding(user_id)
        if expected_account_email is not None:
            status = await self.calendar.connections.status(user_id=user_id, service="calendar")
            if (status.get("google_email") or "").casefold() != expected_account_email.casefold():
                from hushh_mcp.services.google_connection_service import GoogleConnectionError

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
            from hushh_mcp.services.google_connection_service import GoogleConnectionError

            raise GoogleConnectionError("Meeting is unavailable", status_code=404)
        return binding, event
