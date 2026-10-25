"""Temporary adapter retaining the current source wiring during migration.

This is not a licensing declaration. Retire this adapter only after the chosen
licensed adapter passes the same offline contracts and display rights review.
"""

from __future__ import annotations

import math
from typing import Any

from hushh_mcp.services.market_data_provider import MarketDataRequest, MarketDataUnavailable


class LegacyMarketDataAdapter:
    name = "legacy"

    async def fetch(self, request: MarketDataRequest) -> Any:
        from hushh_mcp.operons.kai import fetchers

        symbol = request.symbols[0] if request.symbols else ""
        if request.operation == "quote":
            quote = await fetchers._legacy_fetch_market_data(
                symbol, "market-public", allow_slow_fallbacks=request.allow_slow_fallbacks
            )
            return _nullable_quote(quote)
        if request.operation == "quotes":
            quotes = await fetchers._legacy_fetch_market_data_batch(
                list(request.symbols), "market-public"
            )
            return {symbol: _nullable_quote(row) for symbol, row in quotes.items()}
        if request.operation == "ratios":
            return await fetchers._legacy_fetch_market_company_facts(symbol)
        if request.operation == "session_history":
            return await fetchers._legacy_fetch_market_session_history(list(request.symbols))
        if request.operation == "daily_history":
            from hushh_mcp.market_data.history import daily_history_snapshot

            history = await fetchers._legacy_fetch_market_session_history([symbol])
            return daily_history_snapshot(history.get(symbol, []), source="Yahoo Chart (Batch)")
        if request.operation == "news":
            return await fetchers._legacy_fetch_market_news(
                symbol, "market-public", None, request.days_back
            )
        if request.operation == "peers":
            return await fetchers._legacy_fetch_peer_symbols(symbol)
        if request.operation == "price_targets":
            return {"status": "unavailable", "reason": "legacy_consensus_not_supported"}
        raise MarketDataUnavailable(f"legacy_capability_unavailable:{request.operation}")


def _nullable_quote(quote: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(quote)
    for name in (
        "market_cap",
        "pe_ratio",
        "pb_ratio",
        "forward_pe",
        "ps_ratio",
        "ev_ebitda",
        "52w_low",
        "52w_high",
        "enterprise_value",
    ):
        value = quote.get(name)
        normalized[name] = (
            float(value)
            if isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(value)
            and value != 0
            else None
        )
    # The old price-only adapters manufacture zero yield without measuring it.
    if quote.get("source") in {"Finnhub", "PMP/FMP", "Yahoo Chart (Batch)"}:
        normalized["dividend_yield"] = None
    normalized.setdefault("dividend_yield", None)
    return normalized
