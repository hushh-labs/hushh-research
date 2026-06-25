# tests/test_db_pool_init_race.py
"""
Regression tests for the db/connection.py pool initialisation race condition.

Before the fix, two coroutines that called get_pool() concurrently when
_pool was still None would both enter the create_pool() branch and create
two independent pools.  One pool is silently abandoned, leaking the minimum
number of open DB connections it allocated (min_size=2 by default).

After the fix an asyncio.Lock guards the initialisation block so only one
coroutine runs create_pool(); the others wait and then return the already
created instance.  This test verifies that guarantee without touching a real
database by patching asyncpg.create_pool.
"""

import asyncio
import sys
import types
from unittest.mock import AsyncMock, MagicMock, patch


def _make_fake_pool(pool_id: int) -> MagicMock:
    pool = MagicMock()
    pool.pool_id = pool_id
    pool.get_min_size.return_value = 2
    pool.get_max_size.return_value = 10
    pool.close = AsyncMock()
    return pool


def _fresh_module() -> types.ModuleType:
    """Import a clean copy of db.connection with no cached state."""
    for key in list(sys.modules.keys()):
        if key.startswith("db.connection") or key == "db.connection":
            del sys.modules[key]
    with (
        patch("dotenv.load_dotenv"),
        patch("hushh_mcp.runtime_settings.hydrate_runtime_environment"),
    ):
        import db.connection as mod
    return mod


class TestPoolInitLockPreventsDoublCreate:
    """get_pool() must call create_pool() exactly once under concurrent load."""

    def test_concurrent_callers_share_single_pool(self):
        """
        Ten coroutines racing on get_pool() must all receive the same pool
        object and create_pool() must be called exactly once.
        """
        mod = _fresh_module()

        call_count = 0
        created_pool = _make_fake_pool(1)

        async def fake_create_pool(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            # Yield control to let other coroutines reach the lock.
            await asyncio.sleep(0)
            return created_pool

        async def run():
            with (
                patch.object(mod, "_get_database_url", return_value="postgresql://fake/db"),
                patch.object(mod, "get_database_ssl", return_value=None),
                patch.object(mod, "_get_connect_timeout_seconds", return_value=10),
                patch("asyncpg.create_pool", side_effect=fake_create_pool),
            ):
                tasks = [asyncio.create_task(mod.get_pool()) for _ in range(10)]
                results = await asyncio.gather(*tasks)
            return results

        results = asyncio.run(run())

        assert call_count == 1, (
            f"create_pool() called {call_count} times; expected exactly 1. "
            "Concurrent callers must share the init lock."
        )
        pool_ids = {r.pool_id for r in results}
        assert pool_ids == {1}, "All callers must receive the same pool instance."

    def test_second_call_returns_cached_pool_without_create(self):
        """
        A second call after the pool is already initialised must return the
        cached instance immediately without calling create_pool() again.
        """
        mod = _fresh_module()

        first_pool = _make_fake_pool(1)
        second_pool = _make_fake_pool(2)
        call_count = 0

        async def fake_create_pool(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            return first_pool if call_count == 1 else second_pool

        async def run():
            with (
                patch.object(mod, "_get_database_url", return_value="postgresql://fake/db"),
                patch.object(mod, "get_database_ssl", return_value=None),
                patch.object(mod, "_get_connect_timeout_seconds", return_value=10),
                patch("asyncpg.create_pool", side_effect=fake_create_pool),
            ):
                pool_a = await mod.get_pool()
                pool_b = await mod.get_pool()
            return pool_a, pool_b

        pool_a, pool_b = asyncio.run(run())

        assert call_count == 1, "create_pool() must not be called on the second get_pool() call."
        assert pool_a is pool_b, "Both calls must return the same pool object."

    def test_pool_lock_is_not_none_after_first_get_pool(self):
        """The module-level lock must be created on first use."""
        mod = _fresh_module()

        async def run():
            with (
                patch.object(mod, "_get_database_url", return_value="postgresql://fake/db"),
                patch.object(mod, "get_database_ssl", return_value=None),
                patch.object(mod, "_get_connect_timeout_seconds", return_value=10),
                patch(
                    "asyncpg.create_pool", side_effect=AsyncMock(return_value=_make_fake_pool(1))
                ),
            ):
                await mod.get_pool()
            return mod._pool_lock

        lock = asyncio.run(run())
        assert lock is not None, "_pool_lock must be set after get_pool() is called."
        assert isinstance(lock, asyncio.Lock)
