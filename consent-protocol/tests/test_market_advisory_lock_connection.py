"""Market refresh must not starve the request pool during provider calls."""

from contextlib import asynccontextmanager

import pytest

from hushh_mcp.services import market_cache_store


@pytest.mark.asyncio
async def test_market_refresh_releases_dedicated_lock_after_provider_failure(monkeypatch):
    events: list[str] = []

    class Connection:
        async def fetchval(self, query: str, _key: int) -> bool:
            assert query.startswith("SELECT pg_try_advisory_lock")
            events.append("lock")
            return True

        async def execute(self, query: str, _key: int) -> None:
            assert query.startswith("SELECT pg_advisory_unlock")
            events.append("unlock")

    @asynccontextmanager
    async def dedicated():
        events.append("connect")
        try:
            yield Connection()
        finally:
            events.append("close")

    async def provider_call() -> None:
        events.append("provider")
        raise RuntimeError("provider unavailable")

    monkeypatch.setattr(market_cache_store, "dedicated_connection", dedicated)

    async def request_pool_is_forbidden():
        raise AssertionError("market refresh reserved a request-pool connection")

    monkeypatch.setattr(market_cache_store, "get_pool", request_pool_is_forbidden)
    with pytest.raises(RuntimeError, match="provider unavailable"):
        await market_cache_store.MarketCacheStoreService().try_with_advisory_lock(
            lock_key=42, callback=provider_call
        )

    assert events == ["connect", "lock", "provider", "unlock", "close"]
