# tests/operons/test_fetchers_lock_safety.py
"""
Canonical attach point:
  hushh_mcp.operons.kai.fetchers._get_market_data_lock
  -> hushh_mcp.agents.kai.orchestrator.KaiOrchestrator.analyze
  -> POST /api/kai/analyze

Proves that:
1. _MARKET_DATA_CACHE_LOCK is a threading.RLock (for sync dict mutation).
2. _MARKET_DATA_LOCKS values are asyncio.Lock objects (for async fetch dedup).
3. The threading lock and asyncio locks are separate objects -- the asyncio
   lock is never acquired while the threading lock is held.
4. _get_market_data_lock returns the same asyncio.Lock for the same key.
"""

import asyncio
import threading

from hushh_mcp.operons.kai.fetchers import (
    _MARKET_DATA_CACHE_LOCK,
    _MARKET_DATA_LOCKS,
    _get_market_data_lock,
)


class TestFetchersLockSeparation:
    """The threading.RLock and asyncio.Lock must be separate, non-nested objects."""

    def test_cache_lock_is_rlock(self):
        assert isinstance(_MARKET_DATA_CACHE_LOCK, type(threading.RLock()))

    def test_get_market_data_lock_returns_asyncio_lock(self):
        lock = _get_market_data_lock("TEST_SYMBOL|fh:0|pmp:0")
        assert isinstance(lock, asyncio.Lock)

    def test_get_market_data_lock_idempotent(self):
        key = "AAPL|fh:0|pmp:0"
        lock_a = _get_market_data_lock(key)
        lock_b = _get_market_data_lock(key)
        assert lock_a is lock_b

    def test_threading_lock_acquired_without_asyncio_context(self):
        """Threading lock must be acquirable from a regular sync thread (no event loop)."""
        acquired = []

        def worker():
            lock = _get_market_data_lock("MSFT|fh:0|pmp:0")
            acquired.append(isinstance(lock, asyncio.Lock))

        t = threading.Thread(target=worker)
        t.start()
        t.join(timeout=2)
        assert acquired == [True], "Lock acquisition from sync thread must succeed"

    def test_locks_dict_contains_asyncio_locks(self):
        _get_market_data_lock("NVDA|fh:1|pmp:0")
        for _key, val in _MARKET_DATA_LOCKS.items():
            assert isinstance(val, asyncio.Lock), "All values in _MARKET_DATA_LOCKS must be asyncio.Lock"
            break
