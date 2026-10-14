"""Schedule availability respects real instants across local calendar days."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
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
