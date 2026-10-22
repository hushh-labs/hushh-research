"""Compatibility facade for market-provider contracts and route composition."""

from typing import Any, Awaitable, Callable

from hushh_mcp.market_data.ports import (  # noqa: F401
    FixtureMarketDataProvider,
    MarketDataProvider,
    MarketDataRequest,
    MarketDataUnavailable,
    MarketOperation,
    MarketQuote,
    bind_market_data_provider,
    get_bound_market_data_provider,
)


async def fetch_with_market_provider(
    request: MarketDataRequest, legacy_fetch: Callable[[], Awaitable[Any]]
) -> Any:
    """Transitional route seam: existing adapter remains until explicit cutover."""
    provider = get_bound_market_data_provider()
    from hushh_mcp.services.market_refresh_policy import (
        PRICE_MARKET_OPERATIONS,
        market_price_refresh_scope,
    )

    async def fetch():
        return await provider.fetch(request) if provider is not None else await legacy_fetch()

    if request.operation in PRICE_MARKET_OPERATIONS and (
        provider is None or provider.name != "fixture"
    ):
        with market_price_refresh_scope(request.exchange):
            return await fetch()
    return await fetch()
