"""Client socket-release resilience tests.

Verifies that when a background execution timeout fires mid-request the
underlying connection pool counter drops back to zero — no sockets leak.

[Resource Leak Guard by Abdul Gaffar]
"""

from __future__ import annotations

import asyncio
import time

import pytest

from hushh_mcp.services.client import (
    AsyncClientEngine,
    ClientEngine,
    ConnectionPool,
    RequestResult,
    _Connection,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_SHORT_TIMEOUT = 0.05  # 50 ms — reliably triggers before any real I/O


def _fast_fetch(conn: _Connection, url: str) -> bytes:
    return b"OK"


def _slow_fetch(conn: _Connection, url: str) -> bytes:
    time.sleep(10)
    return b"late"  # never reached in timeout tests


async def _fast_coro(conn: _Connection, url: str) -> bytes:
    return b"OK"


async def _slow_coro(conn: _Connection, url: str) -> bytes:
    await asyncio.sleep(10)
    return b"late"


# ---------------------------------------------------------------------------
# TestConnectionPool
# ---------------------------------------------------------------------------


class TestConnectionPool:
    def test_initial_active_count_is_zero(self) -> None:
        pool = ConnectionPool()
        assert pool.active_count == 0

    def test_acquire_increments_count(self) -> None:
        pool = ConnectionPool()
        pool.acquire()
        assert pool.active_count == 1

    def test_release_decrements_count(self) -> None:
        pool = ConnectionPool()
        conn = pool.acquire()
        pool.release(conn)
        assert pool.active_count == 0

    def test_multiple_acquire_release_cycles(self) -> None:
        pool = ConnectionPool()
        for _ in range(5):
            conn = pool.acquire()
            pool.release(conn)
        assert pool.active_count == 0

    def test_pool_exhaustion_raises(self) -> None:
        pool = ConnectionPool(max_size=2)
        pool.acquire()
        pool.acquire()
        with pytest.raises(RuntimeError, match="exhausted"):
            pool.acquire()

    def test_release_closes_connection(self) -> None:
        pool = ConnectionPool()
        conn = pool.acquire()
        pool.release(conn)
        assert conn.is_closed is True

    def test_acquire_returns_connection_instance(self) -> None:
        pool = ConnectionPool()
        conn = pool.acquire()
        assert isinstance(conn, _Connection)


# ---------------------------------------------------------------------------
# TestConnectionLifecycle
# ---------------------------------------------------------------------------


class TestConnectionLifecycle:
    def test_new_connection_is_not_closed(self) -> None:
        conn = _Connection(conn_id=0)
        assert conn.is_closed is False

    def test_close_marks_connection_closed(self) -> None:
        conn = _Connection(conn_id=1)
        conn.close()
        assert conn.is_closed is True

    def test_conn_id_is_stored(self) -> None:
        conn = _Connection(conn_id=42)
        assert conn.conn_id == 42


# ---------------------------------------------------------------------------
# TestClientEngineHappyPath
# ---------------------------------------------------------------------------


class TestClientEngineHappyPath:
    def test_successful_request_returns_result(self) -> None:
        engine = ClientEngine()
        result = engine.execute("http://example.test", fetch_fn=_fast_fetch)
        assert isinstance(result, RequestResult)
        assert result.status_code == 200

    def test_successful_request_pool_returns_to_zero(self) -> None:
        engine = ClientEngine()
        engine.execute("http://example.test", fetch_fn=_fast_fetch)
        assert engine.pool.active_count == 0

    def test_successful_request_body_is_returned(self) -> None:
        engine = ClientEngine()
        result = engine.execute("http://example.test", fetch_fn=_fast_fetch)
        assert result.body == b"OK"

    def test_multiple_sequential_requests_pool_stays_zero(self) -> None:
        engine = ClientEngine()
        for _ in range(5):
            engine.execute("http://example.test", fetch_fn=_fast_fetch)
        assert engine.pool.active_count == 0


# ---------------------------------------------------------------------------
# TestTimeoutReleasesSocket  ← core requirement
# ---------------------------------------------------------------------------


class TestTimeoutReleasesSocket:
    """Timeout mid-execution MUST release the socket; pool must drop to zero."""

    def test_slow_endpoint_raises_timeout_error(self) -> None:
        engine = ClientEngine(timeout_seconds=_SHORT_TIMEOUT)
        with pytest.raises(TimeoutError):
            engine.execute("http://slow.test", fetch_fn=_slow_fetch)

    def test_pool_count_is_zero_after_timeout(self) -> None:
        """Core invariant: socket released even when thread is still alive."""
        engine = ClientEngine(timeout_seconds=_SHORT_TIMEOUT)
        with pytest.raises(TimeoutError):
            engine.execute("http://slow.test", fetch_fn=_slow_fetch)
        assert engine.pool.active_count == 0

    def test_pool_count_zero_after_multiple_timeouts(self) -> None:
        engine = ClientEngine(timeout_seconds=_SHORT_TIMEOUT)
        for _ in range(3):
            with pytest.raises(TimeoutError):
                engine.execute("http://slow.test", fetch_fn=_slow_fetch)
        assert engine.pool.active_count == 0

    def test_released_connection_is_marked_closed_after_timeout(self) -> None:
        released: list[_Connection] = []
        original_release = ConnectionPool.release

        def spy_release(self: ConnectionPool, conn: _Connection) -> None:
            original_release(self, conn)
            released.append(conn)

        engine = ClientEngine(timeout_seconds=_SHORT_TIMEOUT)
        pool = engine.pool
        pool.release = lambda c: spy_release(pool, c)  # type: ignore[method-assign]

        with pytest.raises(TimeoutError):
            engine.execute("http://slow.test", fetch_fn=_slow_fetch)

        assert len(released) == 1
        assert released[0].is_closed is True

    def test_engine_continues_to_work_after_timeout(self) -> None:
        engine = ClientEngine(timeout_seconds=_SHORT_TIMEOUT)
        with pytest.raises(TimeoutError):
            engine.execute("http://slow.test", fetch_fn=_slow_fetch)
        # Should still serve healthy requests
        result = engine.execute("http://fast.test", fetch_fn=_fast_fetch)
        assert result.status_code == 200
        assert engine.pool.active_count == 0

    def test_fetch_fn_exception_also_releases_socket(self) -> None:
        def _error_fetch(conn: _Connection, url: str) -> bytes:
            raise ConnectionError("mock socket error")

        engine = ClientEngine()
        with pytest.raises(ConnectionError):
            engine.execute("http://error.test", fetch_fn=_error_fetch)
        assert engine.pool.active_count == 0

    def test_timeout_error_message_contains_url(self) -> None:
        engine = ClientEngine(timeout_seconds=_SHORT_TIMEOUT)
        with pytest.raises(TimeoutError, match="slow.test"):
            engine.execute("http://slow.test", fetch_fn=_slow_fetch)

    def test_per_call_timeout_override(self) -> None:
        engine = ClientEngine(timeout_seconds=60)
        with pytest.raises(TimeoutError):
            engine.execute(
                "http://slow.test",
                fetch_fn=_slow_fetch,
                timeout_seconds=_SHORT_TIMEOUT,
            )
        assert engine.pool.active_count == 0


# ---------------------------------------------------------------------------
# TestAsyncClientEngineHappyPath
# ---------------------------------------------------------------------------


class TestAsyncClientEngineHappyPath:
    def test_successful_async_request_returns_result(self) -> None:
        engine = AsyncClientEngine()
        result = asyncio.run(engine.execute("http://example.test", fetch_coro_fn=_fast_coro))
        assert result.status_code == 200

    def test_successful_async_request_pool_zero(self) -> None:
        engine = AsyncClientEngine()
        asyncio.run(engine.execute("http://example.test", fetch_coro_fn=_fast_coro))
        assert engine.pool.active_count == 0

    def test_async_body_returned(self) -> None:
        engine = AsyncClientEngine()
        result = asyncio.run(engine.execute("http://example.test", fetch_coro_fn=_fast_coro))
        assert result.body == b"OK"


# ---------------------------------------------------------------------------
# TestAsyncTimeoutReleasesSocket
# ---------------------------------------------------------------------------


class TestAsyncTimeoutReleasesSocket:
    def test_async_slow_endpoint_raises_timeout(self) -> None:
        engine = AsyncClientEngine(timeout_seconds=_SHORT_TIMEOUT)
        with pytest.raises(TimeoutError):
            asyncio.run(engine.execute("http://slow.test", fetch_coro_fn=_slow_coro))

    def test_async_pool_count_zero_after_timeout(self) -> None:
        """Core async invariant: asyncio.wait_for cancel still releases the socket."""
        engine = AsyncClientEngine(timeout_seconds=_SHORT_TIMEOUT)
        with pytest.raises(TimeoutError):
            asyncio.run(engine.execute("http://slow.test", fetch_coro_fn=_slow_coro))
        assert engine.pool.active_count == 0

    def test_async_pool_zero_after_multiple_timeouts(self) -> None:
        engine = AsyncClientEngine(timeout_seconds=_SHORT_TIMEOUT)
        for _ in range(3):
            with pytest.raises(TimeoutError):
                asyncio.run(engine.execute("http://slow.test", fetch_coro_fn=_slow_coro))
        assert engine.pool.active_count == 0

    def test_async_engine_recovers_after_timeout(self) -> None:
        engine = AsyncClientEngine(timeout_seconds=_SHORT_TIMEOUT)
        with pytest.raises(TimeoutError):
            asyncio.run(engine.execute("http://slow.test", fetch_coro_fn=_slow_coro))
        result = asyncio.run(engine.execute("http://fast.test", fetch_coro_fn=_fast_coro))
        assert result.status_code == 200
        assert engine.pool.active_count == 0

    def test_async_per_call_timeout_override(self) -> None:
        engine = AsyncClientEngine(timeout_seconds=60)
        with pytest.raises(TimeoutError):
            asyncio.run(
                engine.execute(
                    "http://slow.test",
                    fetch_coro_fn=_slow_coro,
                    timeout_seconds=_SHORT_TIMEOUT,
                )
            )
        assert engine.pool.active_count == 0


# ---------------------------------------------------------------------------
# TestSharedPool
# ---------------------------------------------------------------------------


class TestSharedPool:
    def test_shared_pool_count_accurate_across_engines(self) -> None:
        pool = ConnectionPool(max_size=5)
        engine_a = ClientEngine(pool=pool)
        engine_b = ClientEngine(pool=pool)
        engine_a.execute("http://a.test", fetch_fn=_fast_fetch)
        engine_b.execute("http://b.test", fetch_fn=_fast_fetch)
        assert pool.active_count == 0

    def test_shared_pool_count_zero_after_timeout_on_one_engine(self) -> None:
        pool = ConnectionPool(max_size=5)
        engine_slow = ClientEngine(pool=pool, timeout_seconds=_SHORT_TIMEOUT)
        engine_fast = ClientEngine(pool=pool)
        with pytest.raises(TimeoutError):
            engine_slow.execute("http://slow.test", fetch_fn=_slow_fetch)
        engine_fast.execute("http://fast.test", fetch_fn=_fast_fetch)
        assert pool.active_count == 0


# ---------------------------------------------------------------------------
# TestTrustBoundaryProof
# ---------------------------------------------------------------------------


class TestTrustBoundaryProof:
    """Canonical trust-boundary proof — socket release chain.

    Caller chain:
        test suite
        → ClientEngine.execute()            [try/finally boundary]
        → ConnectionPool.acquire/release()  [socket counter]
        → _Connection.close()               [descriptor teardown]
        → hushh_mcp.services.client
        [Resource Leak Guard by Abdul Gaffar]
    """

    def test_golden_path_timeout_pool_drops_to_zero(self) -> None:
        """Golden-path: mock slow endpoint → timeout → pool.active_count == 0."""
        engine = ClientEngine(timeout_seconds=_SHORT_TIMEOUT)
        assert engine.pool.active_count == 0

        with pytest.raises(TimeoutError):
            engine.execute("http://unresponsive.test", fetch_fn=_slow_fetch)

        assert engine.pool.active_count == 0

    def test_resource_leak_guard_signature_in_module_docstring(self) -> None:
        import hushh_mcp.services.client as client_mod

        assert "[Resource Leak Guard by Abdul Gaffar]" in (client_mod.__doc__ or "")

    def test_finally_block_runs_on_exception(self) -> None:
        finally_ran: list[bool] = []

        def _error_fetch(conn: _Connection, url: str) -> bytes:
            raise ValueError("mid-request failure")

        class _TrackedPool(ConnectionPool):
            def release(self, conn: _Connection) -> None:
                finally_ran.append(True)
                super().release(conn)

        engine = ClientEngine(pool=_TrackedPool())
        with pytest.raises(ValueError):
            engine.execute("http://fail.test", fetch_fn=_error_fetch)

        assert finally_ran == [True]
        assert engine.pool.active_count == 0

    def test_async_golden_path_timeout_pool_drops_to_zero(self) -> None:
        engine = AsyncClientEngine(timeout_seconds=_SHORT_TIMEOUT)
        assert engine.pool.active_count == 0

        with pytest.raises(TimeoutError):
            asyncio.run(engine.execute("http://unresponsive.test", fetch_coro_fn=_slow_coro))

        assert engine.pool.active_count == 0
