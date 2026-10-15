"""Connected Schedule boundaries are independent of Google and Mail adapters."""

from __future__ import annotations

import asyncio
import copy
from datetime import UTC, datetime

import pytest

from hushh_mcp.services.calendar_schedule_service import CalendarScheduleService
from hushh_mcp.services.google_calendar_service import GoogleCalendarService
from hushh_mcp.services.google_connection_service import GoogleConnectionError


@pytest.mark.parametrize(
    ("date", "zone", "start", "end", "hours"),
    [
        (
            "2026-10-14",
            "Asia/Kolkata",
            "2026-10-13T18:30:00+00:00",
            "2026-10-14T18:30:00+00:00",
            24,
        ),
        (
            "2026-03-08",
            "America/New_York",
            "2026-03-08T05:00:00+00:00",
            "2026-03-09T04:00:00+00:00",
            23,
        ),
        (
            "2026-11-01",
            "America/New_York",
            "2026-11-01T04:00:00+00:00",
            "2026-11-02T05:00:00+00:00",
            25,
        ),
        (
            "2026-03-08",
            "America/Los_Angeles",
            "2026-03-08T08:00:00+00:00",
            "2026-03-09T07:00:00+00:00",
            23,
        ),
        (
            "2026-11-01",
            "America/Los_Angeles",
            "2026-11-01T07:00:00+00:00",
            "2026-11-02T08:00:00+00:00",
            25,
        ),
        (
            "2026-03-08",
            "America/Phoenix",
            "2026-03-08T07:00:00+00:00",
            "2026-03-09T07:00:00+00:00",
            24,
        ),
        (
            "2026-03-29",
            "Europe/London",
            "2026-03-29T00:00:00+00:00",
            "2026-03-29T23:00:00+00:00",
            23,
        ),
        (
            "2026-10-25",
            "Europe/London",
            "2026-10-24T23:00:00+00:00",
            "2026-10-26T00:00:00+00:00",
            25,
        ),
        (
            "2026-10-14",
            "Asia/Kathmandu",
            "2026-10-13T18:15:00+00:00",
            "2026-10-14T18:15:00+00:00",
            24,
        ),
    ],
)
def test_selected_day_uses_local_midnights_not_a_fixed_24_hour_offset(
    date: str, zone: str, start: str, end: str, hours: int
) -> None:
    left, right = CalendarScheduleService.day_window(date, zone)

    assert left.tzinfo == UTC
    assert right.tzinfo == UTC
    assert left.isoformat() == start
    assert right.isoformat() == end
    assert (right - left).total_seconds() == hours * 3600


def test_editable_window_is_resolved_in_the_selected_zone() -> None:
    left, right = CalendarScheduleService.day_window("2026-10-14", "Asia/Kolkata", "09:00", "17:30")

    assert left.isoformat() == "2026-10-14T03:30:00+00:00"
    assert right.isoformat() == "2026-10-14T12:00:00+00:00"


@pytest.mark.parametrize(
    ("date", "zone", "start", "end"),
    [
        ("2026-03-08", "America/New_York", "02:30", "04:00"),
        ("2026-11-01", "America/New_York", "01:30", "03:00"),
        ("2026-10-14", "Unknown/Zone", "09:00", "17:00"),
        ("2026-02-30", "UTC", "09:00", "17:00"),
        ("2026-10-14", "UTC", "17:00", "09:00"),
        ("2026-10-14", "UTC", "09:00", "09:00"),
    ],
)
def test_invalid_or_ambiguous_window_cannot_be_reported_as_free(
    date: str, zone: str, start: str, end: str
) -> None:
    with pytest.raises(GoogleConnectionError):
        CalendarScheduleService.day_window(date, zone, start, end)


def _invitation() -> dict[str, object]:
    return {
        "id": "live-event",
        "status": "confirmed",
        "etag": '"current"',
        "summary": "Partner review",
        "organizer": {"email": "organizer@example.com"},
        "start": {"dateTime": "2026-10-14T10:00:00Z"},
        "end": {"dateTime": "2026-10-14T11:00:00Z"},
        "attendees": [
            {"email": "organizer@example.com", "responseStatus": "accepted", "organizer": True},
            {"email": "owner@example.com", "responseStatus": "accepted", "self": True},
            {"email": "guest@example.com", "responseStatus": "tentative", "optional": True},
        ],
    }


def test_decline_patch_changes_only_the_current_users_response() -> None:
    event = _invitation()
    original = copy.deepcopy(event)

    patch = CalendarScheduleService.attendance_patch(event)

    assert patch == {
        "attendeesOmitted": True,
        "attendees": [{"email": "owner@example.com", "responseStatus": "declined"}],
    }
    assert event == original
    assert set(patch) == {"attendees", "attendeesOmitted"}


@pytest.mark.parametrize("boundary", ["organizer", "no_self", "cancelled", "partial_attendees"])
def test_decline_refuses_events_without_an_attendee_only_authority(boundary: str) -> None:
    event = _invitation()
    if boundary == "organizer":
        event["organizer"] = {"email": "owner@example.com", "self": True}
    elif boundary == "no_self":
        event["attendees"] = [{"email": "owner@example.com", "responseStatus": "accepted"}]
    elif boundary == "cancelled":
        event["status"] = "cancelled"
    else:
        event["attendeesOmitted"] = True

    with pytest.raises(GoogleConnectionError):
        CalendarScheduleService.attendance_patch(event)


class _Connections:
    def __init__(self) -> None:
        self.binding = ("owner", "calendar", "google-account", "grant-generation")

    async def read_grant_binding(self, **_: object) -> tuple[str, ...]:
        return self.binding


class _BoundCalendar:
    def __init__(self) -> None:
        self.connections = _Connections()

    async def _check_read_binding(self, _: str, expected: tuple[str, ...]) -> None:
        if expected != self.connections.binding:
            raise GoogleConnectionError(
                "Calendar connection changed",
                status_code=409,
                reason_code="calendar_connection_changed",
            )

    async def list_calendars(self, **_: object) -> dict[str, object]:
        return {
            "calendars": [
                {
                    "id": "owner@example.com",
                    "name": "Personal",
                    "primary": True,
                    "access_role": "owner",
                    "time_zone": "UTC",
                }
            ],
            "truncated": False,
        }


class _Calendar(_BoundCalendar):
    def __init__(self, listing: object) -> None:
        super().__init__()
        self.listing = listing
        self.opening_calls: list[dict[str, object]] = []

    async def list_calendars(self, **_: object) -> object:
        if isinstance(self.listing, Exception):
            raise self.listing
        return self.listing

    async def find_openings(self, **kwargs: object) -> dict[str, object]:
        self.opening_calls.append(kwargs)
        return {"openings": [], "duration_minutes": kwargs["duration_minutes"]}


class _Db:
    def execute_raw(self, *_: object) -> object:
        raise AssertionError("Availability must not persist private Calendar contents")


def _check_availability(service: CalendarScheduleService) -> object:
    return asyncio.run(
        service.availability(
            user_id="owner",
            date="2026-10-14",
            time_zone="Asia/Kolkata",
            start_time="09:00",
            end_time="17:00",
            duration_minutes=30,
        )
    )


def test_availability_checks_every_calendar_including_freebusy_only_access() -> None:
    calendar = _Calendar(
        {
            "calendars": [
                {"id": "owner@example.com", "primary": True, "access_role": "owner"},
                {"id": "work@example.com", "access_role": "reader"},
                {"id": "busy-only@example.com", "access_role": "freeBusyReader"},
            ],
            "truncated": False,
        }
    )
    service = CalendarScheduleService(calendar=calendar, db=_Db(), mail=object())

    _check_availability(service)

    assert len(calendar.opening_calls) == 1
    call = calendar.opening_calls[0]
    assert call["user_id"] == "owner"
    assert set(call["calendar_ids"]) == {
        "owner@example.com",
        "work@example.com",
        "busy-only@example.com",
    }
    assert call["duration_minutes"] == 30
    assert call["start_at"] == "2026-10-14T03:30:00Z"
    assert call["end_at"] == "2026-10-14T11:30:00Z"


@pytest.mark.parametrize(
    "listing",
    [
        {},
        {"calendars": []},
        {"calendars": [{"id": "primary"}], "truncated": True},
        {"calendars": [{"id": "primary"}], "next_page_token": "more-calendars"},
        {"calendars": [{"id": "primary"}, {"name": "Unreadable ID"}]},
    ],
)
def test_incomplete_calendar_inventory_never_becomes_known_free_time(listing: object) -> None:
    calendar = _Calendar(listing)
    service = CalendarScheduleService(calendar=calendar, db=_Db(), mail=object())

    with pytest.raises(GoogleConnectionError):
        _check_availability(service)

    assert calendar.opening_calls == []


def test_missing_calendar_list_permission_requires_an_action_specific_upgrade() -> None:
    calendar = _Calendar(
        GoogleConnectionError(
            "Allow Calendar list access to check availability.",
            status_code=403,
            reason_code="calendar_list_permission_required",
        )
    )
    service = CalendarScheduleService(calendar=calendar, db=_Db(), mail=object())

    with pytest.raises(GoogleConnectionError) as caught:
        _check_availability(service)

    assert caught.value.reason_code == "calendar_list_permission_required"
    assert calendar.opening_calls == []


def test_today_loads_every_daily_page_and_orders_timed_events_by_instant() -> None:
    class _DailyCalendar(_BoundCalendar):
        def __init__(self) -> None:
            super().__init__()
            self.calls: list[dict[str, object]] = []

        async def list_events(self, **kwargs: object) -> dict[str, object]:
            self.calls.append(kwargs)
            if kwargs.get("page_token") is None:
                return {
                    "events": [
                        {
                            "id": "later",
                            "title": "Later",
                            "start": {"dateTime": "2026-10-14T09:00:00Z"},
                            "end": {"dateTime": "2026-10-14T10:00:00Z"},
                        },
                        {
                            "id": "cancelled",
                            "status": "cancelled",
                            "start": {"dateTime": "2026-10-14T06:00:00Z"},
                        },
                    ],
                    "truncated": True,
                    "next_page_token": "page-two",
                }
            return {
                "events": [
                    {
                        "id": "earlier",
                        "title": "Earlier",
                        "start": {"dateTime": "2026-10-14T12:00:00+05:30"},
                        "end": {"dateTime": "2026-10-14T12:30:00+05:30"},
                    },
                ],
                "truncated": False,
            }

    calendar = _DailyCalendar()
    service = CalendarScheduleService(calendar=calendar, db=_Db(), mail=object())
    result = asyncio.run(
        service.today(user_id="owner", date="2026-10-14", time_zone="Asia/Kolkata")
    )

    assert [event["id"] for event in result["events"]] == ["earlier", "later"]
    assert len(calendar.calls) == 2
    assert calendar.calls[1]["page_token"] == "page-two"
    assert result["time_zone"] == "Asia/Kolkata"


def test_daily_pages_cannot_mix_calendar_accounts_during_a_reconnect() -> None:
    class _ReconnectingCalendar(_BoundCalendar):
        async def list_events(self, **_: object) -> dict[str, object]:
            self.connections.binding = (
                "owner",
                "calendar",
                "replacement-google-account",
                "new-grant",
            )
            return {
                "events": [{"id": "old-owner-page", "start": {"dateTime": "2026-10-14T09:00:00Z"}}],
                "next_page_token": "second-page",
                "truncated": True,
            }

    calendar = _ReconnectingCalendar()
    service = CalendarScheduleService(calendar=calendar, db=_Db(), mail=object())

    with pytest.raises(GoogleConnectionError) as caught:
        asyncio.run(service.today(user_id="owner", date="2026-10-14", time_zone="UTC"))

    assert caught.value.reason_code == "calendar_connection_changed"


@pytest.mark.parametrize("reconnect_phase", ["inventory", "slots"])
def test_availability_inventory_and_slots_share_one_google_grant(
    monkeypatch: pytest.MonkeyPatch, reconnect_phase: str
) -> None:
    calendar = _Calendar({"calendars": [{"id": "old-owner-calendar"}]})
    service = CalendarScheduleService(calendar=calendar, db=_Db(), mail=object())
    original = calendar.list_calendars if reconnect_phase == "inventory" else calendar.find_openings

    async def reconnect(**kwargs: object) -> object:
        response = await original(**kwargs)
        calendar.connections.binding = (
            "owner",
            "calendar",
            "replacement-google-account",
            "new-grant",
        )
        return response

    monkeypatch.setattr(
        calendar, "list_calendars" if reconnect_phase == "inventory" else "find_openings", reconnect
    )

    with pytest.raises(GoogleConnectionError) as caught:
        _check_availability(service)

    assert caught.value.reason_code == "calendar_connection_changed"
    if reconnect_phase == "inventory":
        assert calendar.opening_calls == []


def test_today_rescheduling_keeps_the_future_part_of_an_otherwise_free_day(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from hushh_mcp.services import calendar_schedule_service as module

    class _Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2030, 10, 14, 14, 17, 42, tzinfo=UTC).astimezone(tz or UTC)

    class _AvailableCalendar(_Calendar):
        find_openings = GoogleCalendarService.find_openings
        _merged_busy_intervals = GoogleCalendarService._merged_busy_intervals
        _utc_iso = staticmethod(GoogleCalendarService._utc_iso)

        async def freebusy(self, **kwargs: object) -> dict[str, object]:
            return {
                "time_min": kwargs["start_at"],
                "time_max": kwargs["end_at"],
                "calendars": {"primary": {"busy": []}},
            }

    monkeypatch.setattr(module, "datetime", _Clock)
    calendar = _AvailableCalendar({"calendars": [{"id": "primary"}]})
    service = CalendarScheduleService(calendar=calendar, db=_Db(), mail=object())
    result = asyncio.run(
        service.availability(
            user_id="owner",
            date="2030-10-14",
            time_zone="UTC",
            start_time="09:00",
            end_time="17:00",
            duration_minutes=30,
            future_only=True,
        )
    )

    assert result["openings"][0]["start_at"] == "2030-10-14T14:18:00Z"
    assert result["openings"][0]["end_at"] == "2030-10-14T14:48:00Z"


def _timed(identifier: str, start: str, end: str, **details: object) -> dict[str, object]:
    return {
        "id": identifier,
        "title": identifier,
        "status": "confirmed",
        "start": {"dateTime": start},
        "end": {"dateTime": end},
        **details,
    }


def test_selected_day_loads_all_inventory_and_event_pages_without_merging_shared_ids() -> None:
    class _Calendars(_BoundCalendar):
        def __init__(self) -> None:
            super().__init__()
            self.inventory_pages: list[str | None] = []
            self.event_pages: list[tuple[str, str | None]] = []

        async def list_calendars(self, **kwargs: object) -> dict[str, object]:
            page = kwargs.get("page_token")
            self.inventory_pages.append(page)
            if not page:
                return {
                    "calendars": [
                        {
                            "id": "owner@example.com",
                            "name": "Personal",
                            "primary": True,
                            "access_role": "owner",
                            "time_zone": "UTC",
                            "background_color": "#4285f4",
                        }
                    ],
                    "next_page_token": "second-inventory",
                    "truncated": True,
                }
            return {
                "calendars": [
                    {
                        "id": "work@example.com",
                        "name": "Work",
                        "access_role": "reader",
                        "time_zone": "UTC",
                        "background_color": "#0b8043",
                    },
                    {
                        "id": "busy-only@example.com",
                        "name": "Shared busy calendar",
                        "access_role": "freeBusyReader",
                        "time_zone": "UTC",
                    },
                ],
                "truncated": False,
            }

        async def list_events(self, **kwargs: object) -> dict[str, object]:
            calendar_id, page = str(kwargs["calendar_id"]), kwargs.get("page_token")
            source_id = "owner@example.com" if calendar_id == "primary" else calendar_id
            self.event_pages.append((source_id, page))
            assert source_id != "busy-only@example.com", (
                "Private free/busy access cannot grant event-detail reads"
            )
            if not page:
                return {
                    "events": [
                        _timed(
                            "shared-provider-id",
                            "2026-10-14T10:00:00Z",
                            "2026-10-14T10:30:00Z",
                            can_decline=True,
                        )
                    ],
                    "next_page_token": "second-events",
                    "truncated": True,
                }
            return {
                "events": [
                    _timed(
                        f"recurrence-instance-{source_id}",
                        "2026-10-14T18:00:00Z",
                        "2026-10-14T19:00:00Z",
                        can_decline=True,
                    )
                ],
                "truncated": False,
            }

    calendar = _Calendars()
    result = asyncio.run(
        CalendarScheduleService(calendar=calendar, db=_Db(), mail=object()).today(
            user_id="owner", date="2026-10-14", time_zone="UTC"
        )
    )

    assert calendar.inventory_pages == [None, "second-inventory"]
    assert set(calendar.event_pages) == {
        (source, page)
        for source in ("owner@example.com", "work@example.com")
        for page in (None, "second-events")
    }
    assert len(result["events"]) == 4
    duplicate_ids = [event for event in result["events"] if event["id"] == "shared-provider-id"]
    assert len(duplicate_ids) == 2
    assert {event["source_calendar_id"] for event in duplicate_ids} == {
        "owner@example.com",
        "work@example.com",
    }
    primary = next(
        event for event in duplicate_ids if event["source_calendar_id"] == "owner@example.com"
    )
    secondary = next(
        event for event in duplicate_ids if event["source_calendar_id"] == "work@example.com"
    )
    assert primary["calendar_id"] == "primary"
    assert primary["calendar_name"] == "Personal"
    assert primary["can_decline"] is True
    assert secondary["calendar_name"] == "Work"
    assert secondary["can_decline"] is False
    assert {item["id"] for item in result["unreadable_calendars"]} == {"busy-only@example.com"}


def test_all_day_civil_dates_survive_the_widest_source_and_selected_zone_difference() -> None:
    calls: list[dict[str, object]] = []

    class _Calendar(_BoundCalendar):
        async def list_calendars(self, **_: object) -> dict[str, object]:
            return {
                "calendars": [
                    {
                        "id": "island",
                        "name": "Island",
                        "access_role": "reader",
                        "time_zone": "Pacific/Kiritimati",
                    }
                ]
            }

        async def list_events(self, **kwargs: object) -> dict[str, object]:
            calls.append(kwargs)
            left = datetime.fromisoformat(str(kwargs["start_at"]).replace("Z", "+00:00"))
            right = datetime.fromisoformat(str(kwargs["end_at"]).replace("Z", "+00:00"))
            assert left <= datetime(2030, 1, 1, 10, tzinfo=UTC)
            assert right >= datetime(2030, 1, 3, 12, tzinfo=UTC)
            return {
                "events": [
                    {
                        "id": "floating-day",
                        "title": "Floating day",
                        "start": {"date": "2030-01-02"},
                        "end": {"date": "2030-01-03"},
                    },
                    {
                        "id": "spanning-days",
                        "title": "Spanning days",
                        "start": {"date": "2030-01-01"},
                        "end": {"date": "2030-01-03"},
                    },
                    {
                        "id": "ended-at-midnight",
                        "title": "Past all-day",
                        "start": {"date": "2030-01-01"},
                        "end": {"date": "2030-01-02"},
                    },
                    {
                        "id": "tomorrow",
                        "title": "Tomorrow",
                        "start": {"date": "2030-01-03"},
                        "end": {"date": "2030-01-04"},
                    },
                    _timed("inside-selected-day", "2030-01-02T13:00:00Z", "2030-01-02T14:00:00Z"),
                    _timed("overlap-midnight", "2030-01-02T11:00:00Z", "2030-01-02T13:00:00Z"),
                    _timed("outside-expanded-day", "2030-01-01T08:00:00Z", "2030-01-01T09:00:00Z"),
                ],
                "truncated": False,
            }

    result = asyncio.run(
        CalendarScheduleService(calendar=_Calendar(), db=_Db(), mail=object()).today(
            user_id="owner", date="2030-01-02", time_zone="Etc/GMT+12"
        )
    )

    assert calls
    assert {event["id"] for event in result["events"]} == {
        "floating-day",
        "spanning-days",
        "inside-selected-day",
        "overlap-midnight",
    }


def test_one_unavailable_readable_calendar_cannot_be_misreported_as_an_empty_day() -> None:
    class _Unavailable(_BoundCalendar):
        async def list_calendars(self, **_: object) -> dict[str, object]:
            return {
                "calendars": [
                    {"id": "personal", "access_role": "owner"},
                    {"id": "work", "access_role": "reader"},
                ]
            }

        async def list_events(self, **kwargs: object) -> dict[str, object]:
            if kwargs["calendar_id"] == "work":
                raise GoogleConnectionError(
                    "Work events are unavailable",
                    status_code=502,
                    reason_code="calendar_invalid_response",
                )
            return {"events": [], "truncated": False}

    with pytest.raises(GoogleConnectionError):
        asyncio.run(
            CalendarScheduleService(calendar=_Unavailable(), db=_Db(), mail=object()).today(
                user_id="owner", date="2030-01-02", time_zone="UTC"
            )
        )


def test_provider_expands_recurring_instances_and_preserves_real_event_and_meeting_links(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calendar = GoogleCalendarService(db=_Db(), connections=object())
    calls: list[dict[str, object]] = []

    async def request(**kwargs: object) -> dict[str, object]:
        calls.append(kwargs)
        return {
            "kind": "calendar#events",
            "items": [
                {
                    "id": "weekly_20300102",
                    "summary": "Weekly review",
                    "recurringEventId": "weekly",
                    "start": {"dateTime": "2030-01-02T10:00:00Z"},
                    "end": {"dateTime": "2030-01-02T10:30:00Z"},
                    "htmlLink": "https://calendar.google.com/calendar/event?eid=real-instance",
                    "conferenceData": {
                        "entryPoints": [
                            {
                                "entryPointType": "video",
                                "uri": "https://meet.google.com/abc-defg-hij",
                            }
                        ]
                    },
                },
                {
                    "id": "weekly_20300102_exception",
                    "summary": "Moved recurring review",
                    "start": {"dateTime": "2030-01-02T18:00:00Z"},
                    "end": {"dateTime": "2030-01-02T19:00:00Z"},
                },
            ],
            "nextPageToken": "next-instance-page",
        }

    monkeypatch.setattr(calendar, "_request", request)
    pagination_cursor = "previous-page"
    result = asyncio.run(
        calendar.list_events(
            user_id="owner",
            start_at="2030-01-02T00:00:00Z",
            end_at="2030-01-03T00:00:00Z",
            calendar_id="team/calendar@example.com",
            page_token=pagination_cursor,
            max_results=250,
        )
    )

    assert calls[0]["path"] == "/calendars/team%2Fcalendar%40example.com/events"
    assert calls[0]["params"]["singleEvents"] == "true"
    assert calls[0]["params"]["pageToken"] == "previous-page"
    assert result["next_page_token"] == "next-instance-page"
    assert [event["id"] for event in result["events"]] == [
        "weekly_20300102",
        "weekly_20300102_exception",
    ]
    assert (
        result["events"][0]["html_link"]
        == "https://calendar.google.com/calendar/event?eid=real-instance"
    )
    assert result["events"][0]["conference_url"] == "https://meet.google.com/abc-defg-hij"


@pytest.mark.parametrize(
    ("details", "url", "provider"),
    [
        (
            {"hangoutLink": "https://meet.google.com/abc-defg-hij"},
            "https://meet.google.com/abc-defg-hij",
            "Google Meet",
        ),
        (
            {"description": '<a href="https://meet.google.com/abc-defg-hij">Join call</a>'},
            "https://meet.google.com/abc-defg-hij",
            "Google Meet",
        ),
        (
            {"location": "https://acme.zoom.us/j/123456789?pwd=qa-token"},
            "https://acme.zoom.us/j/123456789?pwd=qa-token",
            "Zoom Meeting",
        ),
        (
            {"description": "Join: https://zoom.us/j/123456789?pwd=qa-token"},
            "https://zoom.us/j/123456789?pwd=qa-token",
            "Zoom Meeting",
        ),
        (
            {
                "description": '<a href="https://teams.microsoft.com/l/meetup-join/19%3ameeting_qa/0?context=qa">Teams</a>'
            },
            "https://teams.microsoft.com/l/meetup-join/19%3ameeting_qa/0?context=qa",
            "Microsoft Teams",
        ),
    ],
)
def test_google_events_expose_real_provider_links_from_live_meeting_metadata(
    details: dict, url: str, provider: str
) -> None:
    summary = GoogleCalendarService._event_summary(
        {"id": "event", "summary": "Live event", **details}
    )

    assert summary["conference_url"] == url
    assert summary["conference_name"] == provider
    if "location" in details:
        assert summary["location"] == details["location"]


@pytest.mark.parametrize(
    "url",
    [
        "javascript:alert(1)",
        "https://meet.google.com.attacker.example/abc-defg-hij",
        "https://attacker.example/zoom.us/j/123456789",
        "https://owner:secret@meet.google.com/abc-defg-hij",
        "https://calendar.google.com/calendar/appointments/schedules/qa-booking",
        "https://meet.google.com/",
        "https://zoom.us/signin",
    ],
)
def test_nonmeeting_or_unsafe_links_cannot_be_exposed_as_join_actions(url: str) -> None:
    summary = GoogleCalendarService._event_summary(
        {
            "id": "event",
            "summary": "Live event",
            "description": f'<a href="{url}">Join</a>',
            "location": url,
            "conferenceData": {"entryPoints": [{"entryPointType": "video", "uri": url}]},
        }
    )

    assert summary["conference_url"] is None


def test_real_event_color_override_takes_precedence_over_the_source_calendar_color() -> None:
    class _Colored(_BoundCalendar):
        def __init__(self) -> None:
            super().__init__()
            self.color_reads = 0

        async def list_calendars(self, **_: object) -> dict[str, object]:
            return {
                "calendars": [
                    {
                        "id": "owner@example.com",
                        "name": "Personal",
                        "primary": True,
                        "access_role": "owner",
                        "time_zone": "UTC",
                        "background_color": "#4285f4",
                    }
                ]
            }

        async def list_events(self, **_: object) -> dict[str, object]:
            return {
                "events": [
                    _timed(
                        "override", "2030-01-02T10:00:00Z", "2030-01-02T10:30:00Z", color_id="5"
                    ),
                    _timed("calendar-default", "2030-01-02T18:00:00Z", "2030-01-02T19:00:00Z"),
                ]
            }

        async def event_colors(self, **kwargs: object) -> dict[str, str]:
            self.color_reads += 1
            assert kwargs["user_id"] == "owner"
            assert kwargs["expected_binding"] == self.connections.binding
            return {"5": "#f6bf26"}

    calendar = _Colored()
    result = asyncio.run(
        CalendarScheduleService(calendar=calendar, db=_Db(), mail=object()).today(
            user_id="owner", date="2030-01-02", time_zone="UTC"
        )
    )

    assert calendar.color_reads == 1
    events = {event["id"]: event for event in result["events"]}
    assert events["override"]["event_color"] == "#f6bf26"
    assert events["calendar-default"]["event_color"] == "#4285f4"
    assert events["override"]["calendar_color"] == "#4285f4"


@pytest.mark.parametrize(
    "palette", [{"7": {"background": "#123456"}}, {"5": {"background": "blue"}}]
)
def test_missing_or_malformed_referenced_event_colors_are_not_replaced_with_invented_colors(
    monkeypatch: pytest.MonkeyPatch, palette: dict
) -> None:
    class _Colored(_BoundCalendar):
        event_colors = GoogleCalendarService.event_colors
        _invalid_response = staticmethod(GoogleCalendarService._invalid_response)

        async def list_events(self, **_: object) -> dict[str, object]:
            return {
                "events": [
                    _timed("override", "2030-01-02T10:00:00Z", "2030-01-02T10:30:00Z", color_id="5")
                ]
            }

        async def _request(self, **_: object) -> dict[str, object]:
            return {"event": palette}

    calendar = _Colored()
    with pytest.raises(GoogleConnectionError):
        asyncio.run(
            CalendarScheduleService(calendar=calendar, db=_Db(), mail=object()).today(
                user_id="owner", date="2030-01-02", time_zone="UTC"
            )
        )


def test_source_calendar_midnight_dst_transition_keeps_selected_day_loadable():
    class Calendar(_BoundCalendar):
        async def list_calendars(self, **kwargs):
            return {
                "calendars": [
                    {
                        "id": "source",
                        "name": "Source",
                        "access_role": "reader",
                        "time_zone": "America/Santiago",
                    }
                ]
            }

        async def list_events(self, **kwargs):
            assert kwargs["start_at"] == "2026-09-04T00:00:00+00:00"
            assert kwargs["end_at"] == "2026-09-09T00:00:00+00:00"
            return {
                "events": [
                    {
                        "id": "all-day",
                        "title": "All day",
                        "start": {"date": "2026-09-06"},
                        "end": {"date": "2026-09-07"},
                    }
                ]
            }

    result = asyncio.run(
        CalendarScheduleService(calendar=Calendar(), db=_Db()).today(
            user_id="owner", date="2026-09-06", time_zone="UTC"
        )
    )
    assert [event["id"] for event in result["events"]] == ["all-day"]
