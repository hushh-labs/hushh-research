"""Bounded JSON-feed recovery inside the transitional market-provider adapter.

No HTML, ticker-universe scan or per-symbol quote requests. The owning mover port
and shared public cache enforce session access, single flight and refresh cadence.
"""

import asyncio
from datetime import datetime, timezone

import httpx

from hushh_mcp.market_data.movers import number, select_movers
from hushh_mcp.services.market_insights_cache import market_insights_cache
from hushh_mcp.services.market_provider_telemetry import record_provider_request
from hushh_mcp.services.market_refresh_policy import (
    MarketPriceRefreshPaused,
    market_price_refresh_scope,
)

SCREENER_URL = "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved"
SCREENERS = {"gainers": "day_gainers", "losers": "day_losers", "active": "most_actives"}
SCREENER_LIMIT = 12
COOLDOWN_KEY = "yahoo:market-movers"


def normalize_screener_row(row: dict) -> dict | None:
    if row.get("quoteType") != "EQUITY" or row.get("market", "us_market") != "us_market":
        return None
    observed = number(row.get("regularMarketTime"))
    try:
        quoted_at = (
            datetime.fromtimestamp(observed, tz=timezone.utc).isoformat() if observed else None
        )
    except (ValueError, OverflowError, OSError):
        quoted_at = None
    return {
        "symbol": row.get("symbol"),
        "company_name": row.get("longName") or row.get("shortName") or row.get("symbol"),
        "price": number(row.get("regularMarketPrice")),
        "change_pct": number(row.get("regularMarketChangePercent")),
        "volume": number(row.get("regularMarketVolume")),
        "as_of": quoted_at,
        "quoted_at": quoted_at,
        "source_tags": ["Yahoo Finance Screener"],
        "degraded": False,
    }


async def fetch_mover_recovery(buckets: list[str]) -> dict[str, list[dict]]:
    with market_price_refresh_scope():
        return await _fetch_mover_recovery(buckets)


async def _fetch_mover_recovery(buckets: list[str]) -> dict[str, list[dict]]:
    if market_insights_cache.is_provider_in_cooldown(COOLDOWN_KEY):
        return {}
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(6, connect=3),
        headers={"User-Agent": "Mozilla/5.0"},
        event_hooks={"request": [record_provider_request]},
    ) as client:

        async def fetch(bucket: str) -> tuple[str, list[dict]]:
            try:
                response = await client.get(
                    SCREENER_URL,
                    params={
                        "scrIds": SCREENERS[bucket],
                        "count": SCREENER_LIMIT,
                        "formatted": "false",
                        "region": "US",
                    },
                )
                if not response.is_success:
                    market_insights_cache.mark_provider_cooldown(COOLDOWN_KEY, 300)
                    return bucket, []
                results = response.json().get("finance", {}).get("result") or []
                quotes = results[0].get("quotes", []) if results else []
                rows = [
                    normalized
                    for row in quotes[:SCREENER_LIMIT]
                    if isinstance(row, dict)
                    and (normalized := normalize_screener_row(row)) is not None
                ]
                return bucket, select_movers(rows, bucket)
            except MarketPriceRefreshPaused:
                raise
            except (httpx.HTTPError, ValueError, TypeError, AttributeError, KeyError):
                market_insights_cache.mark_provider_cooldown(COOLDOWN_KEY, 120)
                return bucket, []

        return dict(
            await asyncio.gather(*(fetch(bucket) for bucket in SCREENERS if bucket in buckets))
        )
