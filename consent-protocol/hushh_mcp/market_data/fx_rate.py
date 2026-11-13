"""USD to INR reference rate for the India display mode.

One keyless Yahoo chart read (`INR=X`), the same provider and throttling posture as the
India market view: a bounded client, one request, and no retry on a 429 or 5xx. The caller
owns caching, so a provider failure serves the last good rate. A rate is never guessed.
"""

import math
from datetime import UTC, datetime
from typing import Any

import httpx

USD_INR_SYMBOL = "INR=X"
USD_INR_URL = f"https://query1.finance.yahoo.com/v8/finance/chart/{USD_INR_SYMBOL}"
# Rupees per dollar has stayed well inside this band; a value outside it is a bad quote.
USD_INR_MIN = 20.0
USD_INR_MAX = 500.0


class FxRateUnavailable(RuntimeError):
    """The provider returned nothing usable; the caller falls back to its cached rate."""


def parse_usd_inr_chart(chart: dict[str, Any]) -> dict[str, Any] | None:
    """Rupees per US dollar and the day the quote belongs to, or None for an unusable chart."""
    meta = chart.get("meta") or {}
    price = meta.get("regularMarketPrice")
    stamp = meta.get("regularMarketTime")
    if isinstance(price, bool) or not isinstance(price, (int, float)) or not math.isfinite(price):
        return None
    if not (USD_INR_MIN <= price <= USD_INR_MAX):
        return None
    quoted = (
        datetime.fromtimestamp(stamp, tz=UTC)
        if isinstance(stamp, (int, float)) and not isinstance(stamp, bool) and stamp > 0
        else None
    )
    if quoted is None:
        return None
    return {
        "base": "USD",
        "quote": "INR",
        "rate": float(price),
        "as_of": quoted.date().isoformat(),
        "quoted_at": quoted.isoformat(),
        "source": "Yahoo Finance",
    }


async def fetch_usd_inr_rate() -> dict[str, Any]:
    from hushh_mcp.operons.kai.fetchers import record_provider_request

    timeout = httpx.Timeout(connect=4.0, read=8.0, write=8.0, pool=4.0)
    headers = {"User-Agent": "Hushh-Research/1.0 (eng@hush1one.com)"}
    async with httpx.AsyncClient(
        event_hooks={"request": [record_provider_request]}, timeout=timeout, headers=headers
    ) as client:
        response = await client.get(USD_INR_URL, params={"range": "5d", "interval": "1d"})
    if response.status_code >= 400:
        raise FxRateUnavailable(f"fx_provider_status_{response.status_code}")
    results = (response.json().get("chart") or {}).get("result") or []
    parsed = parse_usd_inr_chart(results[0]) if results else None
    if parsed is None:
        raise FxRateUnavailable("fx_rate_unusable")
    return parsed
