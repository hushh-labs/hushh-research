"""Pure chart measurements; transport and provider fallback remain with the caller."""

import math
from datetime import datetime, timezone, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def add_chart_history(row: dict, chart: dict, range_period: str) -> None:
    quotes = (chart.get("indicators") or {}).get("quote") or [{}]
    closes = quotes[0].get("close") or []
    points = [
        {"t": timestamp, "p": float(close)}
        for timestamp, close in zip(chart.get("timestamp") or [], closes, strict=False)
        if isinstance(timestamp, (int, float))
        and math.isfinite(timestamp)
        and isinstance(close, (int, float))
        and not isinstance(close, bool)
        and math.isfinite(close)
        and close > 0
    ]
    points.sort(key=lambda point: point["t"])
    if range_period != "1d":
        # Yahoo can append a second live bar for the same daily
        # session. Count sessions, not rows, for 1D/1W returns.
        exchange_zone: tzinfo
        try:
            exchange_zone = ZoneInfo((chart.get("meta") or {}).get("exchangeTimezoneName") or "UTC")
        except (ZoneInfoNotFoundError, ValueError):
            exchange_zone = timezone.utc
        sessions = {}
        for point in points:
            session = datetime.fromtimestamp(point["t"], tz=exchange_zone).date()
            sessions[session] = point
        points = list(sessions.values())
    row["sparkline_points"] = points
    row["sparkline"] = [point["p"] for point in points]
    if range_period != "1d":
        # A multi-session chart's chartPreviousClose is the range
        # boundary, not yesterday. Keep its quote change honest too.
        row["change_percent"] = (
            (points[-1]["p"] / points[-2]["p"] - 1) * 100 if len(points) >= 2 else None
        )
