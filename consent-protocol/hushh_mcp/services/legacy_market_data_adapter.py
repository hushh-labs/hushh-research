"""Temporary adapter retaining the current source wiring during migration.

This is not a licensing declaration. Retire this adapter only after the chosen
licensed adapter passes the same offline contracts and display rights review.
"""

from __future__ import annotations

from typing import Any

from hushh_mcp.services.market_data_provider import MarketDataRequest, MarketDataUnavailable


class LegacyMarketDataAdapter:
    name = "legacy"

    async def fetch(self, request: MarketDataRequest) -> Any:
        from hushh_mcp.operons.kai import fetchers

        symbol = request.symbols[0] if request.symbols else ""
        if request.operation == "quote":
            return await fetchers._legacy_fetch_market_data(
                symbol, "market-public", allow_slow_fallbacks=request.allow_slow_fallbacks
            )
        if request.operation == "quotes":
            return await fetchers._legacy_fetch_market_data_batch(
                list(request.symbols), "market-public"
            )
        if request.operation == "ratios":
            return await fetchers._legacy_fetch_market_company_facts(symbol)
        if request.operation == "session_history":
            return await fetchers._legacy_fetch_market_session_history(list(request.symbols))
        if request.operation == "news":
            return await fetchers._legacy_fetch_market_news(
                symbol, "market-public", None, request.days_back
            )
        if request.operation == "peers":
            return await fetchers._legacy_fetch_peer_symbols(symbol)
        raise MarketDataUnavailable(f"legacy_capability_unavailable:{request.operation}")
