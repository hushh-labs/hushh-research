"""Background locks must not starve the request pool during provider calls."""

import asyncio
from contextlib import asynccontextmanager

import pytest

from hushh_mcp.services import market_cache_store


@pytest.mark.asyncio
async def test_market_refresh_leaves_last_request_connection_available(monkeypatch):
    """Listeners and another borrower leave one slot; L2 reads must still finish."""
    available = asyncio.Semaphore(1)
    reads: list[str] = []

    class Connection:
        async def fetchval(self, _query, _key):
            return True

        async def fetchrow(self, _query, key):
            reads.append(key)
            return None

        async def execute(self, _query, _key):
            return None

    class Pool:
        @asynccontextmanager
        async def acquire(self):
            async with available:
                yield Connection()

    async def request_pool():
        return Pool()

    @asynccontextmanager
    async def dedicated():
        yield Connection()

    monkeypatch.setattr(market_cache_store, "get_pool", request_pool)
    monkeypatch.setattr(market_cache_store, "dedicated_connection", dedicated, raising=False)
    store = market_cache_store.MarketCacheStoreService()

    async def refresh():
        for key in ("macro", "movers", "sectors"):
            assert await store.get_entry(key) is None

    acquired = await asyncio.wait_for(
        store.try_with_advisory_lock(lock_key=42, callback=refresh), timeout=0.5
    )
    assert acquired is True
    assert reads == ["macro", "movers", "sectors"]
    assert not available.locked()


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


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["success", "failure", "cancelled", "contended"])
async def test_scheduled_sync_keeps_last_request_slot_and_releases_lock(monkeypatch, outcome):
    """A legacy LISTEN budget leaves one request slot; sync must not take it."""
    from hushh_mcp.services import gmail_receipts_service as gmail

    available = asyncio.Semaphore(1)
    events = []

    class Connection:
        async def fetchval(self, query, key):
            events.append("lock")
            return outcome != "contended"

        async def execute(self, query, key):
            events.append("unlock")

    class Pool:
        @asynccontextmanager
        async def acquire(self):
            async with available:
                yield Connection()

    async def request_pool():
        return Pool()

    @asynccontextmanager
    async def dedicated():
        events.append("connect")
        try:
            yield Connection()
        finally:
            events.append("close")

    async def sync():
        async with (await request_pool()).acquire():
            events.append("request")
        if outcome == "failure":
            raise RuntimeError("provider unavailable")
        if outcome == "cancelled":
            raise asyncio.CancelledError

    monkeypatch.setattr(gmail, "get_pool", request_pool)
    monkeypatch.setattr(gmail, "dedicated_connection", dedicated, raising=False)
    service = gmail.GmailReceiptsService()
    monkeypatch.setattr(service, "_run_scheduled_sync_once", sync)
    operation = service._run_scheduled_sync_with_lock()
    if outcome == "cancelled":
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(operation, 0.5)
    else:
        await asyncio.wait_for(operation, 0.5)
    assert events == (
        ["connect", "lock", "close"]
        if outcome == "contended"
        else ["connect", "lock", "request", "unlock", "close"]
    )
    assert not available.locked()
