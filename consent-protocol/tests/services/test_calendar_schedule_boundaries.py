"""Schedule availability respects real instants across local calendar days."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

from hushh_mcp.services.calendar_schedule_service import CalendarScheduleService
from hushh_mcp.services.google_calendar_service import GoogleCalendarService
from hushh_mcp.services.google_connection_service import GoogleConnectionError


class _Db:
    def execute_raw(self, *_: object) -> SimpleNamespace:
        return SimpleNamespace(data=[])


@pytest.mark.parametrize(
    ("day", "start", "end"),
    [
        ("2026-03-08", "2026-03-08T01:30:00-05:00", "2026-03-08T03:30:00-04:00"),
        ("2026-11-01", "2026-11-01T01:30:00-04:00", "2026-11-01T01:30:00-05:00"),
    ],
)
def test_hour_slot_is_sixty_real_minutes_across_dst(
    monkeypatch: pytest.MonkeyPatch, day: str, start: str, end: str
) -> None:
    """A skipped hour and a repeated hour must each yield one real-hour slot."""
    service = GoogleCalendarService(db=_Db(), connections=object())
    zone = ZoneInfo("America/New_York")
    day_start = datetime.fromisoformat(day).replace(tzinfo=zone)
    day_end = day_start.replace(day=day_start.day + 1)
    calls: list[dict[str, object]] = []

    async def freebusy(**kwargs: object) -> dict[str, object]:
        calls.append(kwargs)
        return {
            "time_min": day_start.isoformat(),
            "time_max": day_end.isoformat(),
            "time_zone": zone.key,
            "calendars": {
                "primary": {
                    "busy": [
                        {"start": day_start.isoformat(), "end": start},
                        {"start": end, "end": day_end.isoformat()},
                    ]
                }
            },
        }

    monkeypatch.setattr(service, "freebusy", freebusy)
    result = asyncio.run(
        service.find_openings(
            user_id="owner",
            start_at=day_start.isoformat(),
            end_at=day_end.isoformat(),
            duration_minutes=60,
            calendar_ids=["primary"],
        )
    )

    slot = result["openings"]
    assert len(slot) == 1
    assert slot[0]["start_at"] == datetime.fromisoformat(start).astimezone(UTC).isoformat().replace(
        "+00:00", "Z"
    )
    assert slot[0]["end_at"] == datetime.fromisoformat(end).astimezone(UTC).isoformat().replace(
        "+00:00", "Z"
    )
    assert (
        datetime.fromisoformat(slot[0]["end_at"].replace("Z", "+00:00"))
        - datetime.fromisoformat(slot[0]["start_at"].replace("Z", "+00:00"))
    ).total_seconds() == 3600
    assert calls[0]["calendar_ids"] == ["primary"]


def test_overnight_busy_periods_are_clipped_to_the_requested_day(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = GoogleCalendarService(db=_Db(), connections=object())

    async def freebusy(**_: object) -> dict[str, object]:
        return {
            "time_min": "2026-10-14T00:00:00Z",
            "time_max": "2026-10-15T00:00:00Z",
            "calendars": {
                "primary": {
                    "busy": [
                        {"start": "2026-10-13T22:00:00Z", "end": "2026-10-14T08:00:00Z"},
                        {"start": "2026-10-14T17:00:00Z", "end": "2026-10-15T02:00:00Z"},
                    ]
                },
                "work": {
                    "busy": [
                        {"start": "2026-10-14T08:00:00Z", "end": "2026-10-14T12:00:00Z"},
                        {"start": "2026-10-14T11:00:00Z", "end": "2026-10-14T13:00:00Z"},
                    ]
                },
            },
        }

    monkeypatch.setattr(service, "freebusy", freebusy)
    result = asyncio.run(
        service.find_openings(
            user_id="owner",
            start_at="2026-10-14T00:00:00Z",
            end_at="2026-10-15T00:00:00Z",
            duration_minutes=60,
            calendar_ids=["primary", "work"],
        )
    )

    assert result["openings"] == [
        {
            "start_at": "2026-10-14T13:00:00Z",
            "end_at": "2026-10-14T14:00:00Z",
            "available_until": "2026-10-14T17:00:00Z",
        }
    ]


class _Connections:
    binding = ("owner", "calendar", "google-account", "grant")

    async def read_grant_binding(self, **_: object) -> tuple[str, ...]:
        return self.binding


class _WindowsCalendar:
    _merged_busy_intervals = GoogleCalendarService._merged_busy_intervals
    _utc_iso = staticmethod(GoogleCalendarService._utc_iso)
    _invalid_response = staticmethod(GoogleCalendarService._invalid_response)

    def __init__(self, data: dict[str, object]) -> None:
        self.connections = _Connections()
        self.data = data
        self.calls: list[dict[str, object]] = []

    async def _check_read_binding(self, _: str, binding: tuple[str, ...]) -> None:
        if binding != self.connections.binding:
            raise GoogleConnectionError(
                "Calendar changed", status_code=409, reason_code="calendar_connection_changed"
            )

    async def list_calendars(self, **_: object) -> dict[str, object]:
        return {
            "calendars": [
                {"id": identifier, "name": identifier, "access_role": "owner", "time_zone": "UTC"}
                for identifier in self.data
            ]
        }

    async def freebusy(self, **kwargs: object) -> dict[str, object]:
        self.calls.append(kwargs)
        return {
            "time_min": kwargs["start_at"],
            "time_max": kwargs["end_at"],
            "calendars": {
                identifier: self.data[identifier] for identifier in kwargs["calendar_ids"]
            },
        }


def _freeze_clock(
    monkeypatch: pytest.MonkeyPatch, instant: str = "2026-01-01T00:00:00+00:00"
) -> None:
    from hushh_mcp.services import calendar_schedule_service as module

    class _Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls.fromisoformat(instant).astimezone(tz or UTC)

    monkeypatch.setattr(module, "datetime", _Clock)


def _free_windows(
    calendar: _WindowsCalendar,
    *,
    duration: int = 15,
    day: str = "2026-10-14",
    zone: str = "UTC",
    start: str = "09:00",
    end: str = "17:00",
) -> dict:
    return asyncio.run(
        CalendarScheduleService(calendar=calendar, db=_Db(), mail=object()).free_windows(
            user_id="owner",
            date=day,
            time_zone=zone,
            start_time=start,
            end_time=end,
            duration_minutes=duration,
        )
    )


def test_free_windows_are_maximal_merged_ranges_and_count_all_matches_before_top_three(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _freeze_clock(monkeypatch)
    calendar = _WindowsCalendar(
        {
            "personal": {
                "busy": [
                    {"start": f"2026-10-14T{start}:00Z", "end": f"2026-10-14T{end}:00Z"}
                    for start, end in [
                        ("10:00", "10:30"),
                        ("11:00", "11:45"),
                        ("12:30", "13:30"),
                        ("14:00", "15:00"),
                        ("16:00", "17:00"),
                    ]
                ]
            },
            "work": {"busy": [{"start": "2026-10-14T10:15:00Z", "end": "2026-10-14T10:45:00Z"}]},
        }
    )

    result = _free_windows(calendar)

    assert result["full_count"] == 5
    assert result["requested_duration_minutes"] == 15
    assert result["windows"] == [
        {
            "start_at": "2026-10-14T09:00:00Z",
            "end_at": "2026-10-14T10:00:00Z",
            "duration_minutes": 60,
        },
        {
            "start_at": "2026-10-14T10:45:00Z",
            "end_at": "2026-10-14T11:00:00Z",
            "duration_minutes": 15,
        },
        {
            "start_at": "2026-10-14T11:45:00Z",
            "end_at": "2026-10-14T12:30:00Z",
            "duration_minutes": 45,
        },
    ]
    assert calendar.calls[0]["calendar_ids"] == ["personal", "work"]
    longer = _free_windows(calendar, duration=30)
    assert longer["full_count"] == 4
    assert [window["duration_minutes"] for window in longer["windows"]] == [60, 45, 30]


@pytest.mark.parametrize(("day", "elapsed"), [("2026-03-08", 23 * 60), ("2026-11-01", 25 * 60)])
def test_full_free_windows_use_elapsed_minutes_on_dst_days(
    monkeypatch: pytest.MonkeyPatch, day: str, elapsed: int
) -> None:
    _freeze_clock(monkeypatch)
    result = _free_windows(
        _WindowsCalendar({"personal": {"busy": []}}),
        duration=60,
        day=day,
        zone="America/New_York",
        start="00:00",
        end="24:00",
    )

    assert result["full_count"] == 1
    window = result["windows"][0]
    assert window["duration_minutes"] == elapsed
    assert (
        datetime.fromisoformat(window["end_at"].replace("Z", "+00:00"))
        - datetime.fromisoformat(window["start_at"].replace("Z", "+00:00"))
    ).total_seconds() == elapsed * 60


def test_free_windows_clip_elapsed_time_before_computing_the_current_gap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _freeze_clock(monkeypatch, "2026-10-14T14:17:42+00:00")
    result = _free_windows(_WindowsCalendar({"personal": {"busy": []}}), duration=30)

    assert result["windows"] == [
        {
            "start_at": "2026-10-14T14:18:00Z",
            "end_at": "2026-10-14T17:00:00Z",
            "duration_minutes": 162,
        }
    ]
    assert result["full_count"] == 1


def test_free_windows_batch_every_calendar_without_silently_dropping_the_twenty_first(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _freeze_clock(monkeypatch)
    calendar = _WindowsCalendar({f"calendar-{index}": {"busy": []} for index in range(51)})
    result = _free_windows(calendar)

    assert len(calendar.calls) == 3
    assert all(len(call["calendar_ids"]) <= 20 for call in calendar.calls)
    assert {identifier for call in calendar.calls for identifier in call["calendar_ids"]} == set(
        calendar.data
    )
    assert result["full_count"] == 1
    assert result["windows"][0]["duration_minutes"] == 480


@pytest.mark.parametrize("failure", ["missing", "provider_error", "last_batch_failed"])
def test_one_unavailable_calendar_never_becomes_a_free_window(
    monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    _freeze_clock(monkeypatch)
    calendar = _WindowsCalendar({f"calendar-{index}": {"busy": []} for index in range(21)})
    original = calendar.freebusy

    async def unavailable(**kwargs: object) -> dict[str, object]:
        result = await original(**kwargs)
        if "calendar-20" in kwargs["calendar_ids"]:
            if failure == "last_batch_failed":
                raise GoogleConnectionError(
                    "Subscribed calendar unavailable",
                    status_code=502,
                    reason_code="calendar_invalid_response",
                )
            if failure == "missing":
                result["calendars"].pop("calendar-20")
            else:
                result["calendars"]["calendar-20"] = {"errors": [{"reason": "notFound"}]}
        return result

    monkeypatch.setattr(calendar, "freebusy", unavailable)

    with pytest.raises(GoogleConnectionError):
        _free_windows(calendar)


def test_free_windows_cannot_cross_a_grant_change_during_busy_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _freeze_clock(monkeypatch)
    calendar = _WindowsCalendar({"personal": {"busy": []}})
    original = calendar.freebusy

    async def reconnect(**kwargs: object) -> dict[str, object]:
        result = await original(**kwargs)
        calendar.connections.binding = (
            "owner",
            "calendar",
            "replacement-account",
            "replacement-grant",
        )
        return result

    monkeypatch.setattr(calendar, "freebusy", reconnect)
    with pytest.raises(GoogleConnectionError) as caught:
        _free_windows(calendar)
    assert caught.value.reason_code == "calendar_connection_changed"


def test_large_availability_checks_have_bounded_parallelism():
    class ParallelCalendar(_WindowsCalendar):
        active = 0
        peak = 0

        async def freebusy(self, **kwargs):
            self.active += 1
            self.peak = max(self.peak, self.active)
            try:
                await asyncio.sleep(0)
                return await super().freebusy(**kwargs)
            finally:
                self.active -= 1

    calendar = ParallelCalendar({f"calendar-{i}": {"busy": []} for i in range(100)})
    result = _free_windows(calendar, day="2030-10-14")
    assert result["full_count"] == 1
    assert len(calendar.calls) == 5
    assert calendar.peak == 3
    assert {identifier for call in calendar.calls for identifier in call["calendar_ids"]} == set(
        calendar.data
    )


# Provider-backed regression. The response's failed holiday busy: [] is never
# used as evidence of freedom; selection happens before the provider call.
def _captured_calendar(monkeypatch):
    import copy
    import json
    from pathlib import Path

    fixture = json.loads(
        (Path(__file__).parents[1] / "fixtures/calendar/freebusy_holiday_capture.json").read_text()
    )
    calendar = GoogleCalendarService(db=_Db(), connections=_Connections())
    calls = []

    async def check(*args, **kwargs):
        pass

    async def listing(**kwargs):
        return {"calendars": copy.deepcopy(fixture["inventory"])}

    async def request(**kwargs):
        calls.append(kwargs)
        payload = kwargs["payload"]
        body = fixture["before_response"]
        return {
            **body,
            "calendars": {
                x["id"]: copy.deepcopy(body["calendars"][x["id"]]) for x in payload["items"]
            },
        }

    monkeypatch.setattr(calendar, "_check_read_binding", check)
    monkeypatch.setattr(calendar, "list_calendars", listing)
    monkeypatch.setattr(calendar, "_request", request)
    return calendar, calls, fixture


@pytest.mark.parametrize("duration", [15, 30, 60])
def test_captured_holiday_default_selection_produces_real_windows(monkeypatch, duration):
    _freeze_clock(monkeypatch)
    calendar, calls, fixture = _captured_calendar(monkeypatch)
    result = _free_windows(calendar, duration=duration, day="2030-01-17", zone="Asia/Calcutta")
    assert calls[0]["payload"] == fixture["request"]
    assert result["windows"] == [
        {
            "start_at": "2030-01-17T03:30:00Z",
            "end_at": "2030-01-17T11:30:00Z",
            "duration_minutes": 480,
        }
    ]
    assert result["full_count"] == 1
    assert len(result["calendars"]) == 4
    holiday = next(c for c in result["calendar_options"] if "#holiday@" in c["id"])
    assert holiday["availability_default_included"] is False
    assert holiday["availability_included"] is False
    assert len(result["calendar_options"]) == 5


@pytest.mark.parametrize(
    "overrides,reason",
    [
        ({"en.indian#holiday@group.v.calendar.google.com": True}, "calendar_unreadable"),
        ({"unknown-calendar": False}, "calendar_selection_changed"),
        (
            {"calendar-1": False, "calendar-2": False, "calendar-4": False, "calendar-5": False},
            "calendar_selection_empty",
        ),
    ],
)
def test_explicit_inclusion_and_invalid_selection_fail_closed(monkeypatch, overrides, reason):
    _freeze_clock(monkeypatch)
    calendar, calls, _ = _captured_calendar(monkeypatch)
    service = CalendarScheduleService(calendar=calendar, db=_Db(), mail=object())
    with pytest.raises(GoogleConnectionError) as caught:
        asyncio.run(
            service.free_windows(
                user_id="owner",
                date="2030-01-17",
                time_zone="Asia/Calcutta",
                start_time="09:00",
                end_time="17:00",
                duration_minutes=30,
                calendar_overrides=overrides,
            )
        )
    assert caught.value.reason_code == reason
    assert len(caught.value.calendar_options) == 5
    assert bool(calls) == (reason == "calendar_unreadable")


@pytest.mark.parametrize(
    "identifier,excluded",
    [
        ("en.usa#holiday@group.v.calendar.google.com", True),
        ("ja.japanese#holiday@group.v.calendar.google.com", True),
        ("en-gb.christian#holiday@group.v.calendar.google.com", True),
        ("en.jewish#holiday@group.v.calendar.google.com", True),
        ("team-leave@group.calendar.google.com", False),
        ("shared-work@group.calendar.google.com", False),
        ("owner@example.com", False),
        ("en.usa#holiday@group.v.calendar.google.com.evil.test", False),
        ("#holiday@group.v.calendar.google.com", False),
        ("addressbook#contacts@group.v.calendar.google.com", False),
    ],
)
def test_only_provider_holiday_identity_changes_default(identifier, excluded):
    source = {
        "id": identifier,
        "name": "Holidays and leave",
        "access_role": "reader",
        "selected": True,
    }
    options = CalendarScheduleService._availability_options([source])
    assert options[0]["availability_default_included"] is not excluded
    assert source == {
        "id": identifier,
        "name": "Holidays and leave",
        "access_role": "reader",
        "selected": True,
    }


def test_explicit_exclusion_is_independent_of_display_and_other_calendars(monkeypatch):
    _freeze_clock(monkeypatch)
    calendar, calls, fixture = _captured_calendar(monkeypatch)
    service = CalendarScheduleService(calendar=calendar, db=_Db(), mail=object())
    result = asyncio.run(
        service.free_windows(
            user_id="owner",
            date="2030-01-17",
            time_zone="Asia/Calcutta",
            start_time="09:00",
            end_time="17:00",
            duration_minutes=30,
            calendar_overrides={"calendar-1": False},
        )
    )
    assert [x["id"] for x in calls[0]["payload"]["items"]] == [
        "calendar-2",
        "calendar-4",
        "calendar-5",
    ]
    assert len(result["calendar_options"]) == 5
    assert asyncio.run(service._included_calendars("owner")) == fixture["inventory"]


def test_failed_work_calendar_still_blocks_after_holiday_default_exclusion(monkeypatch):
    _freeze_clock(monkeypatch)
    calendar, calls, fixture = _captured_calendar(monkeypatch)
    fixture["before_response"]["calendars"]["calendar-2"] = {
        "errors": [{"domain": "global", "reason": "notFound"}],
        "busy": [],
    }
    with pytest.raises(GoogleConnectionError) as caught:
        _free_windows(calendar, day="2030-01-17", zone="Asia/Calcutta")
    assert caught.value.reason_code == "calendar_unreadable"
    assert caught.value.status_code == 409
    assert "calendar-2" in [x["id"] for x in calls[0]["payload"]["items"]]


@pytest.mark.parametrize(
    "zone",
    [
        "America/Los_Angeles",
        "America/New_York",
        "America/Phoenix",
        "Europe/London",
        "Asia/Kolkata",
        "Asia/Kathmandu",
    ],
)
@pytest.mark.parametrize("duration,expected", [(15, [20, 40, 90]), (30, [40, 90]), (60, [90])])
def test_shared_work_and_real_leave_block_in_every_zone(monkeypatch, zone, duration, expected):
    _freeze_clock(monkeypatch)
    local = ZoneInfo(zone)

    def instant(clock):
        return datetime.fromisoformat(f"2026-11-02T{clock}:00").replace(tzinfo=local).isoformat()

    # Three gaps of 20, 40 and 90 minutes; real leave blocks the rest of the day.
    calendar = _WindowsCalendar(
        {
            "personal": {"busy": []},
            "shared-work@group.calendar.google.com": {
                "busy": [
                    {"start": instant("09:20"), "end": instant("10:00")},
                    {"start": instant("10:40"), "end": instant("11:00")},
                ]
            },
            "team-leave@group.calendar.google.com": {
                "busy": [{"start": instant("12:30"), "end": instant("17:00")}]
            },
        }
    )
    result = _free_windows(calendar, day="2026-11-02", zone=zone, duration=duration)
    assert [window["duration_minutes"] for window in result["windows"]] == expected
    assert result["full_count"] == len(expected)
    assert set(calendar.calls[0]["calendar_ids"]) == set(calendar.data)


@pytest.mark.parametrize(
    "zone,day,hours",
    [
        ("America/New_York", "2026-03-08", 23),
        ("America/New_York", "2026-11-01", 25),
        ("America/Los_Angeles", "2026-03-08", 23),
        ("America/Los_Angeles", "2026-11-01", 25),
        ("America/Phoenix", "2026-03-08", 24),
        ("Asia/Kolkata", "2026-03-08", 24),
        ("Europe/London", "2026-03-29", 23),
        ("Europe/London", "2026-10-25", 25),
        ("Asia/Kathmandu", "2026-03-08", 24),
        ("America/Santiago", "2026-09-06", 23),
        ("America/Havana", "2026-11-01", 25),
    ],
)
def test_full_day_defaults_query_civil_boundaries_in_worldwide_zones(monkeypatch, zone, day, hours):
    _freeze_clock(monkeypatch)
    calendar = _WindowsCalendar({"personal": {"busy": []}, "shared": {"busy": []}})
    result = asyncio.run(
        CalendarScheduleService(calendar=calendar, db=_Db(), mail=object()).free_windows(
            user_id="owner", date=day, time_zone=zone, duration_minutes=60
        )
    )
    start = datetime.fromisoformat(result["time_min"].replace("Z", "+00:00"))
    end = datetime.fromisoformat(result["time_max"].replace("Z", "+00:00"))
    assert start.astimezone(ZoneInfo(zone)).date().isoformat() == day
    assert (start - timedelta(microseconds=1)).astimezone(ZoneInfo(zone)).date().isoformat() < day
    assert (end - timedelta(microseconds=1)).astimezone(ZoneInfo(zone)).date().isoformat() == day
    assert end.astimezone(ZoneInfo(zone)).date().isoformat() > day
    assert calendar.calls[0]["start_at"] == GoogleCalendarService._utc_iso(start)
    assert calendar.calls[0]["end_at"] == GoogleCalendarService._utc_iso(end)
    assert result["time_min"] == calendar.calls[0]["start_at"]
    assert result["time_max"] == calendar.calls[0]["end_at"]
    assert result["windows"] == [
        {
            "start_at": result["time_min"],
            "end_at": result["time_max"],
            "duration_minutes": hours * 60,
        }
    ]
    assert result["full_count"] == 1


@pytest.mark.parametrize("duration,expected", [(15, [20, 40, 60]), (30, [40, 60]), (60, [60])])
def test_full_day_merges_overnight_busy_and_filters_early_late_gaps(
    monkeypatch, duration, expected
):
    _freeze_clock(monkeypatch)
    # Free gaps: 00:30–00:50, 08:00–08:40, 22:00–23:00. Overnight
    # meetings clip both boundaries; adjacent/overlapping shared busy merges.
    calendar = _WindowsCalendar(
        {
            "personal": {
                "busy": [
                    {"start": "2026-10-13T23:00:00Z", "end": "2026-10-14T00:30:00Z"},
                    {"start": "2026-10-14T00:50:00Z", "end": "2026-10-14T08:00:00Z"},
                    {"start": "2026-10-14T08:40:00Z", "end": "2026-10-14T17:00:00Z"},
                    {"start": "2026-10-14T23:00:00Z", "end": "2026-10-15T02:00:00Z"},
                ]
            },
            "shared-work": {
                "busy": [{"start": "2026-10-14T16:30:00Z", "end": "2026-10-14T18:00:00Z"}]
            },
            "leave": {"busy": [{"start": "2026-10-14T18:00:00Z", "end": "2026-10-14T22:00:00Z"}]},
        }
    )
    result = _free_windows(calendar, duration=duration, start="00:00", end="24:00")
    assert [w["duration_minutes"] for w in result["windows"]] == expected
    assert result["full_count"] == len(expected)
    assert result["windows"][-1]["start_at"] == "2026-10-14T22:00:00Z"
    assert calendar.calls[0]["end_at"] == "2026-10-15T00:00:00Z"


@pytest.mark.parametrize(
    "now,expected",
    [
        ("2026-10-14T14:17:42+00:00", 569),
        ("2026-10-14T23:59:20+00:00", None),
        ("2026-10-15T01:00:00+00:00", None),
    ],
)
def test_full_day_today_queries_elapsed_hours_but_only_offers_remaining_time(
    monkeypatch, now, expected
):
    _freeze_clock(monkeypatch, now)
    calendar = _WindowsCalendar(
        {"work": {"busy": [{"start": "2026-10-14T13:00:00Z", "end": "2026-10-14T14:31:00Z"}]}}
    )
    result = _free_windows(calendar, start="00:00", end="24:00")
    assert calendar.calls[0]["start_at"] == "2026-10-14T00:00:00Z"
    assert calendar.calls[0]["end_at"] == "2026-10-15T00:00:00Z"
    assert result["time_min"] == "2026-10-14T00:00:00Z"
    assert [w["duration_minutes"] for w in result["windows"]] == (
        [] if expected is None else [expected]
    )


def test_full_day_all_day_leave_blocks_and_adjacent_dates_do_not(monkeypatch):
    _freeze_clock(monkeypatch)
    calendar = _WindowsCalendar(
        {"leave": {"busy": [{"start": "2026-10-14T00:00:00Z", "end": "2026-10-15T00:00:00Z"}]}}
    )
    assert _free_windows(calendar, start="00:00", end="24:00")["windows"] == []
    result = _free_windows(calendar, day="2026-10-15", start="00:00", end="24:00")
    assert result["windows"][0]["duration_minutes"] == 1440
    assert result["windows"][0]["start_at"] == "2026-10-15T00:00:00Z"


@pytest.mark.parametrize("duration,count", [(15, 2), (30, 2), (60, 1)])
def test_full_day_explorer_capture_subtracts_actual_late_evening_busy(monkeypatch, duration, count):
    import json
    from pathlib import Path

    _freeze_clock(monkeypatch)
    calendar, calls, _ = _captured_calendar(monkeypatch)
    evidence = json.loads(
        (Path(__file__).parents[1] / "fixtures/calendar/freebusy_full_day_capture.json").read_text()
    )

    async def request(**kwargs):
        assert kwargs["payload"] == evidence["request"]
        calls.append(kwargs)
        return evidence["response"]

    monkeypatch.setattr(calendar, "_request", request)
    result = _free_windows(
        calendar,
        duration=duration,
        day="2030-01-17",
        zone="Asia/Calcutta",
        start="00:00",
        end="24:00",
    )
    assert result["full_count"] == count
    assert result["windows"][0] == {
        "start_at": "2030-01-16T18:30:00Z",
        "end_at": "2030-01-17T17:30:00Z",
        "duration_minutes": 1380,
    }
    if count == 2:
        assert result["windows"][1] == {
            "start_at": "2030-01-17T18:00:00Z",
            "end_at": "2030-01-17T18:30:00Z",
            "duration_minutes": 30,
        }


@pytest.mark.parametrize(
    "day,zone",
    [("9999-12-31", "UTC"), ("0001-01-01", "Asia/Kolkata"), ("2011-12-30", "Pacific/Apia")],
)
def test_full_day_unrepresentable_dates_fail_with_validation_error(day, zone):
    from hushh_mcp.services.calendar_schedule_service import local_day_window

    with pytest.raises(GoogleConnectionError) as caught:
        local_day_window(day, zone)
    assert caught.value.status_code == 422
