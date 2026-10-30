"""Cache completed historical bars across closures, revalidate at session edges."""

from datetime import datetime, timedelta

from hushh_mcp.services.market_refresh_policy import (
    US_MARKET_OPEN_CACHE_TTL_SECONDS,
    us_market_session_opened_at,
    us_market_session_window,
)


def daily_history_cache_window(moment: datetime) -> tuple[int, float]:
    opened = us_market_session_opened_at(moment)
    if opened is not None:
        return US_MARKET_OPEN_CACHE_TTL_SECONDS, opened
    for offset in range(15):
        window = us_market_session_window(moment - timedelta(days=offset))
        if window and window[1] <= moment.timestamp():
            return 7 * 24 * 60 * 60, window[1]
    raise ValueError("exchange_calendar_has_no_completed_session")
