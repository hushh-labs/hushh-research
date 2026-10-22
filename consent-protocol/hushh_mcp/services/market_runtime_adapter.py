"""Shared-runtime composition of market providers, public cache and transport."""

from typing import Any, Awaitable, Callable

from hushh_mcp.market_data.ports import MarketDataRequest, get_bound_market_data_provider
from hushh_mcp.services import market_provider_cache, market_provider_telemetry
from hushh_mcp.services.legacy_market_data_adapter import LegacyMarketDataAdapter
from hushh_mcp.services.market_refresh_policy import PRICE_MARKET_OPERATIONS


class SharedMarketRuntime:
    async def fetch(self, request: MarketDataRequest, *, cached: bool = False) -> Any:
        provider = get_bound_market_data_provider() or LegacyMarketDataAdapter()
        if (cached or request.operation in PRICE_MARKET_OPERATIONS) and provider.name != "fixture":
            identity = provider.name
            if identity == "legacy":
                from hushh_mcp.operons.kai import fetchers

                identity += f":fh{int(bool(fetchers._finnhub_api_key()))}:fmp{int(bool(fetchers._pmp_api_key()))}"
            return await market_provider_cache.cached_market_provider_read(
                request, provider_identity=identity, fetcher=lambda: provider.fetch(request)
            )
        return await provider.fetch(request)

    async def public_information(
        self, key: str, *, fresh: int, stale: int, fetcher: Callable[[], Awaitable[Any]]
    ) -> Any:
        return await market_provider_cache.cached_public_information(
            key, fresh=fresh, stale=stale, fetcher=fetcher
        )

    def yahoo_session(self) -> Any:
        return market_provider_telemetry.yahoo_counted_session()


shared_market_runtime = SharedMarketRuntime()
