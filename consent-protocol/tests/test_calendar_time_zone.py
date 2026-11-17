from datetime import UTC, datetime

import pytest

from hushh_mcp.services.calendar_schedule_service import day_window
from hushh_mcp.services.calendar_time_zone import normalize_time_zone
from hushh_mcp.services.google_connection_service import GoogleConnectionError


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        ("Asia/Calcutta", "Asia/Kolkata"),
        ("Europe/Kiev", "Europe/Kyiv"),
        ("Asia/Katmandu", "Asia/Kathmandu"),
        ("America/New_York", "America/New_York"),
        ("Australia/Lord_Howe", "Australia/Lord_Howe"),
        (" UTC ", "UTC"),
        ("", "UTC"),
        (None, "UTC"),
    ],
)
def test_normalize_time_zone_uses_current_tzdb_names(given, expected):
    assert normalize_time_zone(given) == expected


@pytest.mark.parametrize("given", ["Mars/Olympus", "../etc/passwd", "UTC+5"])
def test_normalize_time_zone_refuses_unknown_zones(given):
    with pytest.raises(GoogleConnectionError) as error:
        normalize_time_zone(given)
    assert error.value.status_code == 422


def test_zone_without_default_is_refused():
    with pytest.raises(GoogleConnectionError):
        normalize_time_zone("", default="")


@pytest.mark.parametrize(
    ("date", "zone", "hours"),
    [
        ("2026-03-08", "America/New_York", 23),  # spring forward
        ("2026-11-01", "America/New_York", 25),  # fall back
        ("2026-10-25", "Europe/London", 25),
        ("2026-10-04", "Australia/Sydney", 23),  # southern hemisphere spring forward
        ("2026-04-05", "Australia/Lord_Howe", 24.5),  # 30-minute fall back
        ("2026-11-02", "Asia/Kolkata", 24),  # no daylight saving
    ],
)
def test_local_day_follows_each_zones_daylight_saving(date, zone, hours):
    start, end = day_window(date, zone)
    assert start.tzinfo is not None and start.astimezone(UTC).tzinfo == UTC
    assert (end - start).total_seconds() / 3600 == hours
    assert isinstance(start, datetime)
