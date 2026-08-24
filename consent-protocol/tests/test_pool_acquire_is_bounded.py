"""The asyncpg pool must never wait forever for a free connection.

On 2026-08-23 UAT phone verification was down for six hours because
``Pool.acquire()`` has no default deadline: asyncpg's ``Pool._acquire`` takes
the unbounded ``await self._queue.get()`` branch whenever ``timeout is None``,
and not one of this repo's call sites passed a timeout. Requests queued until
Cloud Run killed them at its 3600s request timeout, each holding a concurrency
slot for the full hour, so the service could not drain.

These tests drive asyncpg's REAL ``Pool._acquire`` against a genuinely empty
connection queue — the same starvation the outage hit — and assert it now fails
fast. They also pin the three things the deadline must NOT do: cap
``Pool.release()``, blame pool exhaustion for a connection failure, or bind a
caller that explicitly asked to wait.
"""

from __future__ import annotations

import asyncio
import time

import asyncpg
import pytest

from db.connection import (
    _DEFAULT_ACQUIRE_TIMEOUT_SECONDS,
    DatabaseUnavailableError,
    _get_acquire_timeout_seconds,
    _install_bounded_acquire,
)

FAST_DEADLINE = 0.25


class _Holder:
    """Stands in for asyncpg's PoolConnectionHolder."""

    def __init__(self, connection: object = "connection", fail: BaseException | None = None):
        self._connection = connection
        self._fail = fail
        self._timeout: float | None = "untouched"  # type: ignore[assignment]

    async def acquire(self):
        if self._fail is not None:
            raise self._fail
        return self._connection


class _Pool:
    """Only what asyncpg's real ``Pool._acquire`` touches.

    ``_acquire`` and ``acquire`` are the genuine asyncpg implementations, so the
    unbounded-wait branch and the holder bookkeeping are exercised for real.
    """

    _closing = False

    def __init__(self) -> None:
        self._queue: asyncio.Queue = asyncio.Queue()  # empty == fully starved
        self.released: list = []

    def _check_init(self) -> None:
        return None

    async def release(self, connection, *, timeout=None):  # noqa: ARG002
        self.released.append(connection)

    _acquire = asyncpg.pool.Pool._acquire
    acquire = asyncpg.pool.Pool.acquire


def _healthy(**kwargs) -> tuple[_Pool, _Holder]:
    pool = _Pool()
    holder = _Holder(**kwargs)
    pool._queue.put_nowait(holder)
    return pool, holder


@pytest.fixture(autouse=True)
def _fast_deadline(monkeypatch):
    """Keep the suite quick; the mechanism is identical at any deadline."""
    monkeypatch.setenv("DB_POOL_ACQUIRE_TIMEOUT_SECONDS", str(FAST_DEADLINE))


async def _outcome(coro) -> tuple[BaseException | None, float]:
    started = time.monotonic()
    try:
        await coro
    except BaseException as exc:  # noqa: BLE001 - the test inspects it
        return exc, time.monotonic() - started
    return None, time.monotonic() - started


# --------------------------------------------------------------------------
# The hang itself
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_starved_pool_raises_instead_of_hanging_async_with():
    """`async with pool.acquire()` must give up, not queue forever."""
    pool = _Pool()

    async def _use():
        async with pool.acquire():
            pytest.fail("acquired a connection from a fully starved pool")

    exc, elapsed = await _outcome(_use())

    assert isinstance(exc, DatabaseUnavailableError), f"got {exc!r}"
    assert exc.status_code == 503
    # The whole point. Before the fix this ran until Cloud Run's 3600s.
    assert elapsed < 5, f"took {elapsed:.2f}s — that is a hang, not a deadline"


@pytest.mark.asyncio
async def test_starved_pool_raises_instead_of_hanging_bare_await():
    """`conn = await pool.acquire()` is used too (ria_iam_service._conn)."""
    pool = _Pool()

    exc, elapsed = await _outcome(pool.acquire())

    assert isinstance(exc, DatabaseUnavailableError), f"got {exc!r}"
    assert elapsed < 5, f"took {elapsed:.2f}s — that is a hang, not a deadline"


@pytest.mark.asyncio
async def test_pool_execute_is_bounded_too():
    """execute/fetch/fetchval funnel through acquire, so they inherit the bound.

    94 call sites use `pool.execute(...)` directly rather than acquiring first;
    bounding acquire is what covers them.
    """
    pool = _Pool()

    exc, elapsed = await _outcome(asyncpg.pool.Pool.execute(pool, "SELECT 1"))

    assert isinstance(exc, DatabaseUnavailableError), f"got {exc!r}"
    assert elapsed < 5, f"took {elapsed:.2f}s — that is a hang, not a deadline"


# --------------------------------------------------------------------------
# What the deadline must NOT do
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_an_explicit_none_timeout_still_waits():
    """A background job that must not fail early can opt out with timeout=None.

    api/consent_listener.py needs one connection once, for the life of the
    process. Failing it early permanently disables consent notifications on that
    instance, because nothing retries. `timeout=None` has to keep meaning
    "wait", which is why the wrapper uses a sentinel rather than None.
    """
    pool = _Pool()

    async def _use():
        async with pool.acquire(timeout=None):
            pytest.fail("acquired a connection from a fully starved pool")

    try:
        await asyncio.wait_for(_use(), timeout=0.6)
    except (asyncio.TimeoutError, TimeoutError):
        pass  # still waiting when we pulled the plug — correct
    except DatabaseUnavailableError:
        pytest.fail("timeout=None was overridden; the opt-out does not work")


@pytest.mark.asyncio
async def test_release_budget_is_left_untouched():
    """The deadline must not leak into Pool.release()'s reset budget.

    asyncpg records the acquire timeout on the holder and reuses it in
    release() as the budget for Connection.reset(). If our deadline leaked
    there, an overrunning reset would terminate the connection and force a
    fresh handshake — churn, exactly when the database is already struggling.
    """
    pool, holder = _healthy()

    async with pool.acquire():
        pass

    assert holder._timeout is None, (
        f"acquire deadline leaked into the release budget (ch._timeout={holder._timeout!r}); "
        "Pool.release() would now cap Connection.reset() and terminate on overrun"
    )


@pytest.mark.asyncio
async def test_a_connection_failure_is_not_blamed_on_pool_exhaustion():
    """A TimeoutError from establishing a connection must surface as itself.

    TimeoutError is a subclass of OSError, and asyncio.TimeoutError IS
    TimeoutError since 3.11, so a naive except would swallow a Cloud SQL
    connect timeout and tell an operator to raise DB_POOL_MAX_SIZE — adding
    connection pressure to an instance that is already failing.
    """
    pool, _ = _healthy(fail=TimeoutError("[Errno 60] Operation timed out"))

    async def _use():
        async with pool.acquire():
            pytest.fail("should not have acquired")

    exc, elapsed = await _outcome(_use())

    assert isinstance(exc, TimeoutError), f"got {exc!r}"
    assert not isinstance(exc, DatabaseUnavailableError), (
        "a connect failure was misreported as pool exhaustion"
    )
    assert elapsed < FAST_DEADLINE * 0.9, "should have failed immediately, not at the deadline"


# --------------------------------------------------------------------------
# The happy path must be untouched
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_healthy_pool_still_hands_back_its_connection():
    """Both call shapes keep working, and the connection is released."""
    pool, _ = _healthy()

    async with pool.acquire() as conn:
        assert conn == "connection"

    # __aexit__ must delegate, or connections leak until the pool starves again.
    assert pool.released == ["connection"]

    pool2, _ = _healthy()
    assert await pool2.acquire() == "connection"


@pytest.mark.asyncio
async def test_an_error_inside_the_block_still_propagates():
    """__aexit__ must not swallow what the body raised."""
    pool, _ = _healthy()

    with pytest.raises(ValueError, match="from inside the block"):
        async with pool.acquire():
            raise ValueError("from inside the block")


# --------------------------------------------------------------------------
# The guardrail's own wiring
# --------------------------------------------------------------------------


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
        ("90", 90.0),
        ("not-a-number", _DEFAULT_ACQUIRE_TIMEOUT_SECONDS),
        ("0", _DEFAULT_ACQUIRE_TIMEOUT_SECONDS),
        ("-5", _DEFAULT_ACQUIRE_TIMEOUT_SECONDS),
    ],
)
def test_the_deadline_is_env_tunable_and_rejects_nonsense(monkeypatch, raw, expected):
    monkeypatch.setenv("DB_POOL_ACQUIRE_TIMEOUT_SECONDS", raw)
    assert _get_acquire_timeout_seconds() == expected


def test_the_default_clears_the_documented_cold_start_burst(monkeypatch):
    """The deadline covers establishing a connection, not just waiting for one.

    server.py documents that a burst of first requests after a restart can stall
    15-30s while additional connections are established to Cloud SQL. Only
    DB_POOL_MIN_SIZE connections are pre-warmed; the rest are opened lazily
    inside this deadline. A default at or under that cost would turn every cold
    start into a 503 storm — and the log would tell the operator to enlarge the
    pool, which makes it strictly worse.
    """
    monkeypatch.delenv("DB_POOL_ACQUIRE_TIMEOUT_SECONDS", raising=False)
    assert _get_acquire_timeout_seconds() >= 45, (
        "the default must clear the 15-30s cold-start handshake burst"
    )


def test_the_deadline_is_far_below_the_cloud_run_request_timeout(monkeypatch):
    """The outage was requests holding a Cloud Run slot for the full 3600s.

    Releasing the slot early is the point; which layer reports the failure is
    not. The deadline cannot also undercut the proxy's tightest per-route
    timeouts (10s) without breaking cold starts, so it deliberately does not try.
    """
    monkeypatch.delenv("DB_POOL_ACQUIRE_TIMEOUT_SECONDS", raising=False)
    assert _get_acquire_timeout_seconds() <= 120
