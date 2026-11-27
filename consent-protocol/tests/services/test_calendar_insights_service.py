"""Weekly Insights uses civil dates and real elapsed meeting durations."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.calendar_insights_service import CalendarInsightsService
from hushh_mcp.services.calendar_schedule_service import day_window, local_day_window
from hushh_mcp.services.google_connection_service import GoogleConnectionError


def _event(start, end, **fields):
    return {"start": {"dateTime": start}, "end": {"dateTime": end}, **fields}


def _overview(date, zone, events=(), *, complete=True):
    service = CalendarInsightsService(SimpleNamespace(calendar=object()))
    reader = AsyncMock(return_value=(events, complete))
    service.events = reader
    result = asyncio.run(service.overview(user_id="synthetic-owner", date=date, time_zone=zone))
    return result, reader.await_args.kwargs


def test_audit_havana_week_is_valid_with_the_installed_timezone_rules():
    # Keep the exact audit input, plus historical transitions below so future
    # timezone legislation cannot remove the midnight-transition coverage.
    result, read = _overview("2026-10-28", "America/Havana")
    assert [day["date"] for day in result["days"]] == [
        "2026-10-26",
        "2026-10-27",
        "2026-10-28",
        "2026-10-29",
        "2026-10-30",
        "2026-10-31",
        "2026-11-01",
    ]
    assert (read["start"], read["end"]) == (
        local_day_window("2026-10-26", "America/Havana")[0],
        local_day_window("2026-11-01", "America/Havana")[1],
    )
    assert result["meeting_count"] == result["meeting_minutes"] == 0
    assert result["complete"] is True


@pytest.mark.parametrize(
    ("date", "zone", "start", "end", "minutes"),
    [
        ("2026-10-28", "UTC", "2026-10-28T00:00:00Z", "2026-10-29T00:00:00Z", 1440),
        ("2026-10-28", "Asia/Kolkata", "2026-10-27T18:30:00Z", "2026-10-28T18:30:00Z", 1440),
        # Repeated/skipped midnight, independent of future timezone legislation.
        ("2025-11-02", "America/Havana", "2025-11-02T04:00:00Z", "2025-11-03T05:00:00Z", 1500),
        ("2025-03-09", "America/Havana", "2025-03-09T05:00:00Z", "2025-03-10T04:00:00Z", 1380),
        ("2018-11-04", "America/Sao_Paulo", "2018-11-04T03:00:00Z", "2018-11-05T02:00:00Z", 1380),
        # A Monday transition exercises the start of the entire query week.
        ("1990-10-01", "America/Asuncion", "1990-10-01T04:00:00Z", "1990-10-02T03:00:00Z", 1380),
        # Interior midnight exercises daily bins independently of week bounds.
        ("2014-08-01", "Africa/Cairo", "2014-07-31T22:00:00Z", "2014-08-01T21:00:00Z", 1380),
        ("2026-03-08", "America/New_York", "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z", 1380),
        ("2026-11-01", "America/New_York", "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z", 1500),
    ],
)
def test_whole_civil_day_counts_elapsed_minutes_once(date, zone, start, end, minutes):
    result, read = _overview(date, zone, [_event(start, end)])
    day_index = datetime.fromisoformat(date).weekday()
    assert [day["minutes"] for day in result["days"]] == [
        minutes if index == day_index else 0 for index in range(7)
    ]
    assert [day["meetings"] for day in result["days"]] == [
        int(index == day_index) for index in range(7)
    ]
    assert result["meeting_count"] == 1
    assert result["meeting_minutes"] == minutes
    assert read["start"] == local_day_window(result["days"][0]["date"], zone)[0]
    assert read["end"] == local_day_window(result["days"][-1]["date"], zone)[1]


@pytest.mark.parametrize(
    ("date", "start", "end"),
    [
        ("2025-11-02", "2025-11-02T00:30:00-04:00", "2025-11-02T00:30:00-05:00"),
        ("2025-03-09", "2025-03-08T23:30:00-05:00", "2025-03-09T01:30:00-04:00"),
    ],
)
def test_meetings_across_midnight_transitions_use_elapsed_time(date, start, end):
    result, _ = _overview(date, "America/Havana", [_event(start, end)])
    assert result["meeting_count"] == 1
    assert result["meeting_minutes"] == 60
    assert [day["minutes"] for day in result["days"]][-2:] == (
        [0, 60] if date == "2025-11-02" else [30, 30]
    )


@pytest.mark.parametrize(
    ("zone", "date", "week_start", "week_end"),
    [
        ("UTC", "2026-10-28", "2026-10-26T00:00:00Z", "2026-11-02T00:00:00Z"),
        ("Asia/Kolkata", "2026-10-28", "2026-10-25T18:30:00Z", "2026-11-01T18:30:00Z"),
        ("America/Havana", "2025-10-29", "2025-10-27T04:00:00Z", "2025-11-03T05:00:00Z"),
    ],
)
def test_events_crossing_day_and_week_edges_are_clipped_with_exclusive_ends(
    zone, date, week_start, week_end
):
    start, end = (datetime.fromisoformat(value) for value in (week_start, week_end))
    half_hour = timedelta(minutes=30)
    first_midnight = start + timedelta(days=1)
    recurring = {"calendar_id": "primary", "recurring_event_id": "weekly", "title": "Review"}
    result, read = _overview(
        date,
        zone,
        [
            _event((start - half_hour).isoformat(), (start + half_hour).isoformat(), **recurring),
            _event(
                (first_midnight - half_hour).isoformat(), (first_midnight + half_hour).isoformat()
            ),
            _event((end - half_hour).isoformat(), (end + half_hour).isoformat(), **recurring),
        ],
    )
    assert (read["start"], read["end"]) == (start, end)
    assert [day["minutes"] for day in result["days"]] == [60, 30, 0, 0, 0, 0, 30]
    assert [day["meetings"] for day in result["days"]] == [2, 1, 0, 0, 0, 0, 1]
    assert result["meeting_count"] == 3
    assert result["meeting_minutes"] == 120
    assert result["recurring"] == [{"title": "Review", "minutes": 60}]


@pytest.mark.parametrize(("transparency", "has_focus"), [("opaque", False), ("transparent", True)])
def test_all_day_events_keep_focus_safety_and_totals_remain_per_meeting(transparency, has_focus):
    result, _ = _overview(
        "2026-10-28",
        "UTC",
        [
            {
                "start": {"date": "2026-10-28"},
                "end": {"date": "2026-10-29"},
                "transparency": transparency,
            },
            _event("2026-10-28T10:00:00Z", "2026-10-28T11:00:00Z"),
            _event("2026-10-28T10:30:00Z", "2026-10-28T11:30:00Z"),
        ],
    )
    assert result["meeting_count"] == 2
    assert result["meeting_minutes"] == result["days"][2]["minutes"] == 120
    assert result["overlaps"] == 1
    assert bool(result["focus"]) is has_focus


@pytest.mark.parametrize(
    ("date", "zone", "start", "end"),
    [
        ("2025-11-02", "America/Havana", "00:00", "01:00"),
        ("2025-03-09", "America/Havana", "00:00", "01:00"),
        ("2026-11-01", "America/New_York", "01:30", "02:30"),
        ("2026-03-08", "America/New_York", "02:30", "03:30"),
    ],
)
def test_editable_meeting_boundaries_still_reject_repeated_and_skipped_times(
    date, zone, start, end
):
    with pytest.raises(GoogleConnectionError, match="skipped or repeated"):
        day_window(date, zone, start, end)
