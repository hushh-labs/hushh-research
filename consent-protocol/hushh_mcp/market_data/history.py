"""Observed daily bars for an explicitly opened stock detail, never spot quotes."""

import math
from datetime import datetime, timezone
from typing import Any

from .ports import MarketDataRequest, MarketDataUnavailable
from .runtime import get_market_runtime


def daily_history_snapshot(points: list[dict[str, Any]], *, source: str) -> dict[str, Any]:
    observed = {
        float(point["t"]): float(point["p"])
        for point in points
        if all(
            isinstance(point.get(key), (int, float))
            and not isinstance(point[key], bool)
            and math.isfinite(point[key])
            and point[key] > 0
            for key in ("t", "p")
        )
    }
    if len(observed) < 2:
        raise MarketDataUnavailable("insufficient_observations")
    return {
        "points": [
            {"t": timestamp, "p": observed[timestamp]} for timestamp in sorted(observed)[-32:]
        ],
        "source": source,
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
    }


async def fetch_daily_history(symbol: str) -> dict[str, Any]:
    # The history route's existing public L1/L2 cache owns freshness and single
    # flight. Do not create a second cache or enter the live-price refresh scope.
    return await get_market_runtime().fetch(
        MarketDataRequest("daily_history", (symbol,), days_back=30), cached=False
    )
