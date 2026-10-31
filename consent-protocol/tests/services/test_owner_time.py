"""A send time the person names is theirs, never the server's.

Every case runs against one frozen clock: Monday 2026-10-05 14:06:55 UTC,
which is 19:36:55 in Kolkata and 10:06:55 in New York.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from hushh_mcp.services import owner_time
from hushh_mcp.services.owner_time import (
    ScheduleTimeError,
    check_send_at,
    format_schedule_echo,
    owner_zone,
    render_time_block,
    resolve_send_at,
    send_at_after_minutes,
    spoken_schedule_time,
)

NOW = datetime(2026, 10, 5, 14, 6, 55, tzinfo=timezone.utc)


def _utc(*args: int) -> datetime:
    return datetime(*args, tzinfo=timezone.utc)


@pytest.mark.parametrize(
    ("raw", "zone", "expected"),
    [
        # An explicit offset is honoured whatever the owner's zone.
        ("2026-10-06T09:00:00+05:30", "America/New_York", _utc(2026, 10, 6, 3, 30)),
        ("2026-10-06T03:30:00Z", "Asia/Kolkata", _utc(2026, 10, 6, 3, 30)),
        # No offset: the owner's wall clock, not UTC (the bug this module exists for).
        ("2026-10-06T09:00:00", "Asia/Kolkata", _utc(2026, 10, 6, 3, 30)),
        ("2026-10-06T09:00:00", "America/New_York", _utc(2026, 10, 6, 13, 0)),
        # Negative control: the same naive time for a UTC owner is 09:00 UTC.
        ("2026-10-06T09:00:00", "UTC", _utc(2026, 10, 6, 9, 0)),
        # An unusable zone hint degrades to UTC rather than failing.
        ("2026-10-06T09:00:00", "Mars/Olympus_Mons", _utc(2026, 10, 6, 9, 0)),
    ],
)
def test_send_at_resolves_to_utc_from_the_owner_wall_clock(raw, zone, expected):
    resolved = resolve_send_at(raw, owner_zone=zone, now=NOW)
    assert resolved == expected
    assert resolved.tzinfo == timezone.utc


@pytest.mark.parametrize(
    ("raw", "code"),
    [
        ("tomorrow 9am", "schedule_time_unparseable"),
        ("kal subah", "schedule_time_unparseable"),
        ("2026-10-06", "schedule_time_unparseable"),  # a date is not a send time
        ("", "schedule_time_unparseable"),
        ("2026-10-05T14:06:55Z", "schedule_time_in_past"),  # exactly now is past
        ("2026-10-05T09:00:00Z", "schedule_time_in_past"),
        ("2026-10-05T14:07:55Z", "schedule_time_too_soon"),  # exactly the 60 s lead
        ("2026-11-04T14:06:56Z", "schedule_time_too_far"),  # one second past 30 days
    ],
)
def test_unschedulable_times_are_refused_with_a_spoken_reason(raw, code):
    with pytest.raises(ScheduleTimeError) as refused:
        resolve_send_at(raw, owner_zone="Asia/Kolkata", now=NOW)
    assert refused.value.code == code
    assert refused.value.spoken.strip()


def test_the_lead_and_horizon_boundaries_are_inclusive_where_promised():
    lead = NOW + timedelta(seconds=owner_time.SCHEDULE_MIN_LEAD_SECONDS + 1)
    horizon = NOW + timedelta(days=owner_time.SCHEDULE_HORIZON_DAYS)
    assert resolve_send_at(lead.isoformat(), owner_zone="UTC", now=NOW) == lead
    assert resolve_send_at(horizon.isoformat(), owner_zone="UTC", now=NOW) == horizon


@pytest.mark.parametrize(
    ("send_at", "zone", "echo", "spoken"),
    [
        (
            _utc(2026, 10, 6, 3, 30),
            "Asia/Kolkata",
            "Tomorrow, 9:00 AM IST",
            "tomorrow at 9:00 AM IST",
        ),
        (
            _utc(2026, 10, 6, 3, 30),
            "Asia/Calcutta",
            "Tomorrow, 9:00 AM IST",
            "tomorrow at 9:00 AM IST",
        ),
        (
            _utc(2026, 10, 5, 22, 0),
            "America/New_York",
            "Today, 6:00 PM EDT",
            "today at 6:00 PM EDT",
        ),
        (
            _utc(2026, 10, 9, 3, 15),
            "Asia/Kathmandu",
            "Friday, 9:00 AM UTC+5:45",
            "on Friday at 9:00 AM UTC+5:45",
        ),
        (_utc(2026, 10, 30, 12, 0), "UTC", "30 Oct, 12:00 PM UTC", "on 30 Oct at 12:00 PM UTC"),
    ],
)
def test_the_owner_hears_and_sees_their_own_local_time(send_at, zone, echo, spoken):
    assert format_schedule_echo(send_at, zone, now=NOW) == echo
    assert spoken_schedule_time(send_at, zone, now=NOW) == spoken


def test_winter_new_york_is_est_not_edt():
    january = datetime(2027, 1, 4, 12, 0, tzinfo=timezone.utc)
    send_at = january + timedelta(days=1)
    assert format_schedule_echo(send_at, "America/New_York", now=january) == "Tomorrow, 7:00 AM EST"


def test_a_naive_time_across_a_dst_change_keeps_the_owners_wall_clock():
    """New York leaves daylight saving on 2026-11-01. Today's offset (-04:00)
    pinned onto a date past the change sends an hour off; the owner's zone,
    applied by the server to a naive time, does not."""
    after_change = resolve_send_at("2026-11-02T09:00:00", owner_zone="America/New_York", now=NOW)
    assert after_change == _utc(2026, 11, 2, 14, 0)  # 9:00 AM EST
    assert format_schedule_echo(after_change, "America/New_York", now=NOW) == ("2 Nov, 9:00 AM EST")
    # Negative control: what the old rule asked for (today's offset) is 8:00 AM EST.
    stale_offset = resolve_send_at(
        "2026-11-02T09:00:00-04:00", owner_zone="America/New_York", now=NOW
    )
    assert stale_offset == _utc(2026, 11, 2, 13, 0)


@pytest.mark.parametrize(
    ("raw", "zone"),
    [
        ("0001-01-01T00:00:00", "Asia/Kolkata"),  # naive, east of UTC: year 0
        ("0001-01-01T00:00:00+05:30", "UTC"),
        ("9999-12-31T23:00:00-05:00", "UTC"),  # west of UTC: year 10000
        ("9999-12-31T23:59:59", "America/New_York"),
    ],
)
def test_a_year_that_overflows_in_conversion_is_unparseable_not_a_crash(raw, zone):
    with pytest.raises(ScheduleTimeError) as refused:
        resolve_send_at(raw, owner_zone=zone, now=NOW)
    assert refused.value.code == "schedule_time_unparseable"


def test_a_duration_is_counted_from_the_server_clock_and_checked_like_a_time():
    assert send_at_after_minutes(30, now=NOW) == NOW + timedelta(minutes=30)
    assert send_at_after_minutes(43200, now=NOW) == NOW + timedelta(days=30)
    for minutes, code in ((1, "schedule_time_too_soon"), (43201, "schedule_time_too_far")):
        with pytest.raises(ScheduleTimeError) as refused:
            send_at_after_minutes(minutes, now=NOW)
        assert refused.value.code == code
    # A pinned instant is re-checked against a later clock, never recomputed.
    pinned = NOW + timedelta(minutes=30)
    assert check_send_at(pinned, now=NOW + timedelta(minutes=10)) == pinned
    with pytest.raises(ScheduleTimeError) as late:
        check_send_at(pinned, now=NOW + timedelta(minutes=29, seconds=30))
    assert late.value.code == "schedule_time_too_soon"


def test_instruction_clock_names_server_time_owner_time_and_the_wall_clock_rule():
    block = render_time_block(timezone_name="Asia/Calcutta", now=NOW)
    assert block.startswith(
        "Current time: 2026-10-05T14:06:55+00:00 (UTC). The owner's local time is "
        "2026-10-05 19:36:55 Asia/Calcutta — Monday, 2026-10-05."
    )
    assert "never against UTC" in block
    # The example is the owner's own tomorrow at 9 on their wall clock, with no
    # offset: the server applies the zone, daylight saving included.
    assert "e.g. 2026-10-06T09:00:00;" in block
    assert "2026-10-06T09:00:00+" not in block
    assert "without a UTC offset" in block
    assert "including daylight-saving changes" in block
    # A duration is counted by the server, not from this (possibly stale) clock.
    assert "pass send_in_minutes instead and leave send_at out" in block


@pytest.mark.parametrize("zone", [None, "", "Not/AZone"])
def test_instruction_clock_falls_back_to_utc_when_the_zone_is_missing(zone):
    block = render_time_block(timezone_name=zone, now=NOW)
    assert "The owner's local time is 2026-10-05 14:06:55 UTC — Monday, 2026-10-05." in block
    assert "e.g. 2026-10-06T09:00:00;" in block
    assert owner_zone(zone).key == "UTC"
