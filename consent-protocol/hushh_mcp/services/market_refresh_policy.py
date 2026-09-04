"""Shared market-session cache cadence for provider-backed quote data.

The policy is deliberately schedule-based rather than a market-status source:
it controls request cadence only, so an exchange holiday can at worst produce a
shorter cache window. It has no bearing on the market status presented to a
person.
"""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

US_MARKET_OPEN_CACHE_TTL_SECONDS = 120
US_MARKET_CLOSED_CACHE_TTL_SECONDS = 1_800


def us_market_is_open(now: datetime | None = None) -> bool:
    """Return whether the US regular session is currently scheduled open."""
    try:
        eastern_now = (
            now.astimezone(ZoneInfo("America/New_York"))
            if now is not None
            else datetime.now(ZoneInfo("America/New_York"))
        )
    except Exception:
        return False

    if eastern_now.weekday() >= 5:
        return False
    minute_of_day = eastern_now.hour * 60 + eastern_now.minute
    return 9 * 60 + 30 <= minute_of_day < 16 * 60


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
