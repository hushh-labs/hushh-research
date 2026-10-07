"""Weekly challenge cutoff computation. Pure function, no database, no clock."""

from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from hushh_mcp.operons.referral_scoring.weekly_cutoff import next_weekly_cutoff

SCHEDULE = {"timezone": "Asia/Kolkata", "cutoff_day_of_week": 7, "cutoff_time": "23:59:00"}
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


def test_midweek_resolves_to_this_coming_sunday():
    # Wednesday 10:00 IST -> the cutoff is this coming Sunday 23:59 IST.
    now = datetime(2026, 10, 7, 10, 0, tzinfo=KOLKATA).astimezone(timezone.utc)
    window = next_weekly_cutoff(now, SCHEDULE)

    assert window is not None
    cutoff_local = window.cutoff_at.astimezone(KOLKATA)
    assert cutoff_local.date() == datetime(2026, 10, 11).date()
    assert cutoff_local.isoweekday() == 7
    assert (cutoff_local.hour, cutoff_local.minute) == (23, 59)


def test_sunday_before_cutoff_still_resolves_to_today():
    # Sunday 12:00 IST, before the 23:59 cutoff -- the round closes later today.
    now = datetime(2026, 10, 11, 12, 0, tzinfo=KOLKATA).astimezone(timezone.utc)
    window = next_weekly_cutoff(now, SCHEDULE)

    assert window is not None
    cutoff_local = window.cutoff_at.astimezone(KOLKATA)
    assert cutoff_local.date() == datetime(2026, 10, 11).date()


def test_sunday_after_cutoff_rolls_to_next_sunday():
    # Sunday 23:59:30 IST, just past the 23:59:00 cutoff -- rolls a full week.
    now = datetime(2026, 10, 11, 23, 59, 30, tzinfo=KOLKATA).astimezone(timezone.utc)
    window = next_weekly_cutoff(now, SCHEDULE)

    assert window is not None
    cutoff_local = window.cutoff_at.astimezone(KOLKATA)
    assert cutoff_local.date() == datetime(2026, 10, 18).date()


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
