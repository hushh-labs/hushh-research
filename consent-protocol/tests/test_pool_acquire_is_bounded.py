"""The asyncpg pool must never wait forever for a free connection.

On 2026-08-23 UAT phone verification was down for six hours because
``Pool.acquire()`` has no default deadline: asyncpg's ``Pool._acquire`` takes
the unbounded ``await self._queue.get()`` branch whenever ``timeout is None``,
and not one of this repo's call sites passed a timeout. Requests queued until
Cloud Run killed them at its 3600s request timeout, each holding a concurrency
slot for the full hour, so the service could not drain.

These tests drive asyncpg's REAL ``Pool._acquire`` against a genuinely empty
connection queue — the same starvation the outage hit — and assert it now fails
fast with a 503 instead of hanging.
"""

from __future__ import annotations

import asyncio
import time

import asyncpg
import pytest

from db.connection import (
    DatabaseUnavailableError,
    _get_acquire_timeout_seconds,
    _install_bounded_acquire,
)


class _StarvedPool:
    """A pool whose every connection is checked out.

    Only what asyncpg's real ``Pool._acquire`` touches: an empty queue it will
    block on, plus the two guards it checks first. ``_acquire`` is the genuine
    asyncpg implementation, so the unbounded-wait branch is exercised for real.
    """

    def __init__(self) -> None:
        self._closing = False
        self._queue: asyncio.Queue = asyncio.Queue()  # empty == fully starved
        self.released: list = []

    def _check_init(self) -> None:
        return None

    async def release(self, connection, *, timeout=None):  # noqa: ARG002
        """asyncpg's PoolAcquireContext.__aexit__ releases through the pool."""
        self.released.append(connection)

    _acquire = asyncpg.pool.Pool._acquire
    acquire = asyncpg.pool.Pool.acquire


@pytest.fixture(autouse=True)
def _fast_timeout(monkeypatch):
    """Keep the suite quick; the mechanism is identical at any deadline."""
    monkeypatch.setenv("DB_POOL_ACQUIRE_TIMEOUT_SECONDS", "0.25")


async def _elapsed(coro) -> tuple[BaseException | None, float]:
    started = time.monotonic()
    try:
        await coro
    except BaseException as exc:  # noqa: BLE001 - the test inspects it
        return exc, time.monotonic() - started
    return None, time.monotonic() - started


@pytest.mark.asyncio
async def test_starved_pool_raises_instead_of_hanging_async_with():
    """`async with pool.acquire()` must give up, not queue forever."""
    pool = _StarvedPool()

    async def _use():
        async with pool.acquire():
            pytest.fail("acquired a connection from a fully starved pool")

    exc, elapsed = await _elapsed(_use())

    assert isinstance(exc, DatabaseUnavailableError), f"got {exc!r}"
    assert exc.status_code == 503
    # The whole point: bounded. Before the fix this ran until Cloud Run's 3600s.
    assert elapsed < 5, f"took {elapsed:.2f}s — that is a hang, not a deadline"


@pytest.mark.asyncio
async def test_starved_pool_raises_instead_of_hanging_bare_await():
    """`conn = await pool.acquire()` is used too (ria_iam_service._conn)."""
    pool = _StarvedPool()

    exc, elapsed = await _elapsed(pool.acquire())

    assert isinstance(exc, DatabaseUnavailableError), f"got {exc!r}"
    assert exc.status_code == 503
    assert elapsed < 5, f"took {elapsed:.2f}s — that is a hang, not a deadline"


@pytest.mark.asyncio
async def test_pool_execute_is_bounded_too():
    """Pool.execute/fetch/fetchval funnel through acquire, so they inherit the bound.

    94 call sites in this repo use `pool.execute(...)` directly rather than
    acquiring first; bounding acquire is what covers them.
    """
    pool = _StarvedPool()

    exc, elapsed = await _elapsed(asyncpg.pool.Pool.execute(pool, "SELECT 1"))

    assert isinstance(exc, DatabaseUnavailableError), f"got {exc!r}"
    assert elapsed < 5, f"took {elapsed:.2f}s — that is a hang, not a deadline"


@pytest.mark.asyncio
async def test_an_explicit_caller_timeout_still_wins():
    """Only the unbounded default is replaced; a caller's own deadline is kept."""
    pool = _StarvedPool()

    async def _use():
        async with pool.acquire(timeout=0.05):
            pytest.fail("acquired a connection from a fully starved pool")

    exc, elapsed = await _elapsed(_use())

    assert isinstance(exc, DatabaseUnavailableError)
    # Honoured the caller's 0.05s rather than the 0.25s env default.
    assert elapsed < 0.2, f"caller timeout ignored; took {elapsed:.2f}s"


@pytest.mark.asyncio
async def test_a_healthy_pool_still_hands_back_its_connection():
    """The guardrail must not change the happy path, in either call shape."""
    sentinel = object()

    class _HealthyPool(_StarvedPool):
        async def _acquire(self, timeout):  # noqa: ARG002 - signature parity
            return sentinel

    pool = _HealthyPool()

    async with pool.acquire() as conn:
        assert conn is sentinel

    # __aexit__ must delegate, or connections leak until the pool starves again.
    assert pool.released == [sentinel]

    assert await pool.acquire() is sentinel


@pytest.mark.asyncio
async def test_an_error_inside_the_block_still_propagates():
    """__aexit__ must not swallow what the body raised."""
    sentinel = object()

    class _HealthyPool(_StarvedPool):
        async def _acquire(self, timeout):  # noqa: ARG002 - signature parity
            return sentinel

    pool = _HealthyPool()

    with pytest.raises(ValueError, match="from inside the block"):
        async with pool.acquire():
            raise ValueError("from inside the block")


def test_the_guardrail_is_actually_installed():
    """Importing db.connection must leave every asyncpg pool bounded."""
    assert asyncpg.pool.Pool.acquire.__module__ == "db.connection", (
        "asyncpg.pool.Pool.acquire is not the bounded version — the guardrail "
        "is not installed, and every acquire in the process can hang forever"
    )


def test_installing_twice_does_not_stack_wrappers():
    """Re-import or an explicit re-install must be a no-op."""
    before = asyncpg.pool.Pool.acquire
    _install_bounded_acquire()
    _install_bounded_acquire()
    assert asyncpg.pool.Pool.acquire is before


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("0.25", 0.25),
        ("30", 30.0),
        ("not-a-number", 10.0),  # falls back to the default
        ("0", 10.0),  # zero would mean "never wait"
        ("-5", 10.0),  # negative is nonsense
    ],
)
def test_the_deadline_is_env_tunable_and_rejects_nonsense(monkeypatch, raw, expected):
    monkeypatch.setenv("DB_POOL_ACQUIRE_TIMEOUT_SECONDS", raw)
    assert _get_acquire_timeout_seconds() == expected


def test_the_default_stays_under_the_tightest_proxy_timeout(monkeypatch):
    """A starved pool must surface as a clean 503, not a proxy gateway timeout.

    The Next.js proxy's tightest per-route deadline is 20s; if the pool waited
    longer than that the caller would see a 500/504 from the proxy instead of
    the real reason.
    """
    monkeypatch.delenv("DB_POOL_ACQUIRE_TIMEOUT_SECONDS", raising=False)
    assert _get_acquire_timeout_seconds() < 20
