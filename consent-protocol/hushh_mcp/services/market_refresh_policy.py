"""Shared market-session cache cadence for provider-backed quote data.

The offline exchange calendar controls cache cadence, including holidays and
early closes. Provider market status remains the preferred displayed source.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

US_MARKET_OPEN_CACHE_TTL_SECONDS = 120
US_MARKET_CLOSED_CACHE_TTL_SECONDS = 1_800


def us_market_session_window(now: datetime | None = None) -> tuple[float, float] | None:
    """Offline XNYS calendar includes exchange holidays and shortened sessions."""
    import exchange_calendars

    eastern_now = (now or datetime.now(ZoneInfo("America/New_York"))).astimezone(
        ZoneInfo("America/New_York")
    )
    calendar = exchange_calendars.get_calendar("XNYS")
    day = eastern_now.date().isoformat()
    if not calendar.is_session(day):
        return None
    return calendar.session_open(day).timestamp(), calendar.session_close(day).timestamp()


def us_market_session_opened_at(now: datetime | None = None) -> float | None:
    window = us_market_session_window(now)
    timestamp = (now or datetime.now(ZoneInfo("America/New_York"))).timestamp()
    return window[0] if window and window[0] <= timestamp < window[1] else None


def seconds_until_us_market_open(now: datetime | None = None) -> float:
    eastern_now = (now or datetime.now(ZoneInfo("America/New_York"))).astimezone(
        ZoneInfo("America/New_York")
    )
    for offset in range(15):
        candidate = eastern_now + timedelta(days=offset)
        window = us_market_session_window(candidate)
        if window and window[0] > eastern_now.timestamp():
            return window[0] - eastern_now.timestamp()
    raise ValueError("exchange_calendar_has_no_upcoming_session")


def us_market_is_open(now: datetime | None = None) -> bool:
    return us_market_session_opened_at(now) is not None


def provider_quote_cache_ttl_seconds(
    base_ttl_seconds: int,
    *,
    now: datetime | None = None,
) -> int:
    """Tighten quote TTL during the session and relax it while it is closed."""
    base_ttl = max(60, int(base_ttl_seconds))
    if us_market_is_open(now):
        return min(base_ttl, US_MARKET_OPEN_CACHE_TTL_SECONDS)
    return max(base_ttl, US_MARKET_CLOSED_CACHE_TTL_SECONDS)
