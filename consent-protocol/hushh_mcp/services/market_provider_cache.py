"""Shared public L1/L2 reads for analysis; no owner context is persisted."""

from __future__ import annotations

import logging
import time
from typing import Any, Awaitable, Callable

from hushh_mcp.services.market_cache_store import get_market_cache_store_service
from hushh_mcp.services.market_data_provider import MarketDataRequest
from hushh_mcp.services.market_insights_cache import market_insights_cache
from hushh_mcp.services.market_refresh_policy import (
    provider_quote_cache_ttl_seconds,
    us_market_session_opened_at,
)

logger = logging.getLogger(__name__)


async def cached_market_provider_read(
    request: MarketDataRequest,
    *,
    provider_identity: str,
    fetcher: Callable[[], Awaitable[Any]],
) -> Any:
    # Include source configuration and all query dimensions; never include tokens.
    key = (
        f"provider:{provider_identity}:{request.operation}:"
        f"{','.join(request.symbols)}:{request.days_back}:{request.exchange}:"
        f"{int(request.allow_slow_fallbacks)}"
    )
    price_sensitive = request.operation in {"quote", "quotes", "intraday", "session_history"}
    fresh = provider_quote_cache_ttl_seconds(600) if price_sensitive else 21_600
    if request.operation == "news":
        fresh = 900
    stale = max(fresh * 4, 3_600)
    fence = us_market_session_opened_at() if price_sensitive else None
    now = time.time()
    l1 = market_insights_cache.peek(key)
    if l1 and now - l1.fetched_at <= fresh and (fence is None or l1.fetched_at >= fence):
        return l1.value

    store = get_market_cache_store_service()
    try:
        entry = await store.get_entry(key)
        if (
            entry
            and entry.is_stale_servable(now)
            and (l1 is None or entry.updated_at_ts > l1.fetched_at)
        ):
            market_insights_cache.seed_entry(key, entry.payload, entry.updated_at_ts)
    except Exception:
        logger.warning("market_provider_cache_read_failed operation=%s", request.operation)

    async def refresh() -> Any:
        value = await fetcher()
        try:
            await store.set_entry(
                cache_key=key,
                payload=value,
                fresh_ttl_seconds=fresh,
                stale_ttl_seconds=stale,
                provider_status={"provider": provider_identity},
            )
        except Exception:
            logger.warning("market_provider_cache_write_failed operation=%s", request.operation)
        return value

    result = await market_insights_cache.get_or_refresh(
        key,
        fresh_ttl_seconds=fresh,
        stale_ttl_seconds=stale,
        fetcher=refresh,
        serve_stale_while_revalidate=False,
        fresh_after_ts=fence,
    )
    if result.stale and isinstance(result.value, dict):
        return {**result.value, "is_stale": True, "stale_reason": result.stale_reason}
    return result.value
