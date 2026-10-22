"""Compatibility counters and guarded shared-runtime HTTP transport adapters."""

from functools import lru_cache

import httpx

from hushh_mcp.observability.market_provider_calls import (  # noqa: F401
    ProviderCallCounts,
    degraded_provider_resources,
    finish_provider_call_counts,
    record_provider_degradation,
    record_provider_url,
    start_provider_call_counts,
)


async def record_provider_request(request: httpx.Request) -> None:
    from hushh_mcp.services.market_refresh_policy import ensure_market_price_request_allowed

    ensure_market_price_request_allowed()
    record_provider_url(str(request.url))


@lru_cache(maxsize=1)
def yahoo_counted_session():
    from curl_cffi.requests import Session

    class CountedSession(Session):
        def request(self, method, url, *args, **kwargs):
            from hushh_mcp.services.market_refresh_policy import ensure_market_price_request_allowed

            ensure_market_price_request_allowed()
            record_provider_url(str(url))
            return super().request(method, url, *args, **kwargs)

    return CountedSession(impersonate="chrome")
