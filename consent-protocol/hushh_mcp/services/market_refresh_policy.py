"""Shared market-session cache cadence for provider-backed quote data.

The offline exchange calendar controls cache cadence, including holidays and
early closes. Provider market status remains the preferred displayed source.
"""

from __future__ import annotations

import math
import time
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

US_MARKET_OPEN_CACHE_TTL_SECONDS = 120
US_MARKET_CLOSED_CACHE_TTL_SECONDS = 1_800
PRICE_MARKET_OPERATIONS = frozenset(
    {"quote", "quotes", "intraday", "session_history", "movers", "most_active", "sector_rotation"}
)
_price_refresh_exchange: ContextVar[str | None] = ContextVar("price_refresh_exchange", default=None)


def _eastern_now(now: datetime | None = None) -> datetime:
    zone = ZoneInfo("America/New_York")
    return (now or datetime.fromtimestamp(time.time(), tz=zone)).astimezone(zone)


class MarketPriceRefreshPaused(RuntimeError):
    """A closed exchange forbids a provider refresh, not a failed provider."""


def ensure_market_price_request_allowed() -> None:
    if _price_refresh_exchange.get() == "US" and not us_market_is_open():
        raise MarketPriceRefreshPaused("market_closed_no_price_refresh")


@contextmanager
def market_price_refresh_scope(exchange: str = "US"):
    """Rechecked by each HTTP/SDK send, including work continued in a thread."""
    token = _price_refresh_exchange.set(exchange.upper())
    try:
        ensure_market_price_request_allowed()
        yield
        # A refresh may finish with partial results after queued sends were
        # paused at closing. Preserve the previous complete cached snapshot.
        ensure_market_price_request_allowed()
    finally:
        _price_refresh_exchange.reset(token)


def us_market_session_window(now: datetime | None = None) -> tuple[float, float] | None:
    """Offline XNYS calendar includes exchange holidays and shortened sessions."""
    import exchange_calendars

    eastern_now = _eastern_now(now)
    calendar = exchange_calendars.get_calendar("XNYS")
    day = eastern_now.date().isoformat()
    if not calendar.is_session(day):
        return None
    return calendar.session_open(day).timestamp(), calendar.session_close(day).timestamp()


def us_market_session_opened_at(now: datetime | None = None) -> float | None:
    moment = _eastern_now(now)
    window = us_market_session_window(moment)
    timestamp = moment.timestamp()
    return window[0] if window and window[0] <= timestamp < window[1] else None


def seconds_until_us_market_open(now: datetime | None = None) -> float:
    eastern_now = _eastern_now(now)
    for offset in range(15):
        candidate = eastern_now + timedelta(days=offset)
        window = us_market_session_window(candidate)
        if window and window[0] > eastern_now.timestamp():
            return window[0] - eastern_now.timestamp()
    raise ValueError("exchange_calendar_has_no_upcoming_session")


def us_market_is_open(now: datetime | None = None) -> bool:
    return us_market_session_opened_at(now) is not None


def price_cache_retention_seconds(base: int, now: datetime | None = None) -> int:
    """Keep the last session through weekends/holidays without making it fresh."""
    return max(
        base, math.ceil(seconds_until_us_market_open(now)) + US_MARKET_OPEN_CACHE_TTL_SECONDS
    )


def closed_price_snapshot_usable(fetched_at: float, now: datetime | None = None) -> bool:
    moment = _eastern_now(now)
    for offset in range(15):
        window = us_market_session_window(moment - timedelta(days=offset))
        if window and window[1] <= moment.timestamp():
            return window[0] <= fetched_at <= moment.timestamp()
    return False


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
