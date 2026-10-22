"""Weekly challenge cutoff computation. Pure function, no database, no clock."""

from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from hushh_mcp.operons.referral_scoring.weekly_cutoff import next_weekly_cutoff

SCHEDULE = {"timezone": "Asia/Kolkata", "cutoff_day_of_week": 1, "cutoff_time": "00:00:00"}
KOLKATA = ZoneInfo("Asia/Kolkata")


def test_unset_schedule_returns_none():
    assert next_weekly_cutoff(datetime.now(timezone.utc), {"timezone": None}) is None
    assert next_weekly_cutoff(datetime.now(timezone.utc), {}) is None


def test_unknown_timezone_returns_none():
    schedule = {**SCHEDULE, "timezone": "Not/A_Zone"}
    assert next_weekly_cutoff(datetime.now(timezone.utc), schedule) is None


def test_malformed_cutoff_time_returns_none():
    schedule = {**SCHEDULE, "cutoff_time": "not-a-time"}
    assert next_weekly_cutoff(datetime.now(timezone.utc), schedule) is None


def test_naive_now_is_rejected():
    import pytest

    with pytest.raises(ValueError):
        next_weekly_cutoff(datetime(2026, 1, 1), SCHEDULE)  # noqa: DTZ001


def test_thursday_is_day_four_and_refresh_keeps_same_window():
    now = datetime(2026, 10, 8, 10, 0, tzinfo=KOLKATA)
    window = next_weekly_cutoff(now, SCHEDULE)
    assert window is not None
    assert window.week_started_at.astimezone(KOLKATA) == datetime(2026, 10, 5, tzinfo=KOLKATA)
    assert window.cutoff_at.astimezone(KOLKATA) == datetime(2026, 10, 12, tzinfo=KOLKATA)
    assert (now - window.week_started_at).days + 1 == 4
    assert next_weekly_cutoff(now, SCHEDULE) == window


def test_all_of_sunday_belongs_to_current_week():
    now = datetime(2026, 10, 11, 23, 59, 59, tzinfo=KOLKATA)
    window = next_weekly_cutoff(now, SCHEDULE)
    assert window is not None
    assert window.cutoff_at.astimezone(KOLKATA) == datetime(2026, 10, 12, tzinfo=KOLKATA)
    assert (window.cutoff_at - now).total_seconds() == 1


def test_exact_monday_midnight_rolls_to_next_week():
    now = datetime(2026, 10, 12, tzinfo=KOLKATA)
    window = next_weekly_cutoff(now, SCHEDULE)
    assert window is not None
    assert window.week_started_at == now
    assert window.cutoff_at.astimezone(KOLKATA) == datetime(2026, 10, 19, tzinfo=KOLKATA)


def test_week_start_is_exactly_seven_days_before_cutoff():
    now = datetime(2026, 10, 7, 10, 0, tzinfo=KOLKATA).astimezone(timezone.utc)
    window = next_weekly_cutoff(now, SCHEDULE)

    assert window is not None
    assert (window.cutoff_at - window.week_started_at).days == 7


def test_now_always_falls_strictly_inside_the_returned_window():
    for hour in (0, 6, 12, 18, 23):
        now = datetime(2026, 10, 9, hour, tzinfo=KOLKATA).astimezone(timezone.utc)
        window = next_weekly_cutoff(now, SCHEDULE)
        assert window is not None
        assert window.week_started_at <= now < window.cutoff_at
