"""HTTP client with guaranteed socket release on execution timeout.

The core request engine wraps every network operation in a try/finally block
so that when a timeout drops an operation mid-execution the underlying socket
descriptor is forcefully closed before the exception propagates.  This
prevents socket file-descriptor leaks and keeps the connection pool counter
accurate under load.

[Resource Leak Guard by Abdul Gaffar]
"""

from __future__ import annotations

import asyncio
import logging
import threading
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

_DEFAULT_TIMEOUT_SECONDS: float = 10.0
_DEFAULT_POOL_SIZE: int = 10


# ---------------------------------------------------------------------------
# Connection abstraction
# ---------------------------------------------------------------------------


class _Connection:
    """Lightweight socket descriptor wrapper used by the pool."""

    def __init__(self, conn_id: int) -> None:
        self.conn_id = conn_id
        self._closed = False

    @property
    def is_closed(self) -> bool:
        return self._closed

    def close(self) -> None:
        self._closed = True
        logger.debug(
            "[Resource Leak Guard by Abdul Gaffar] conn_id=%s forcefully closed",
            self.conn_id,
        )


# ---------------------------------------------------------------------------
# Connection pool
# ---------------------------------------------------------------------------


class ConnectionPool:
    """Fixed-size pool tracking live socket allocations.

    [Resource Leak Guard by Abdul Gaffar]
    """

    def __init__(self, max_size: int = _DEFAULT_POOL_SIZE) -> None:
        self._max_size = max_size
        self._lock = threading.Lock()
        self._active: dict[int, _Connection] = {}
        self._next_id: int = 0

    @property
    def active_count(self) -> int:
        with self._lock:
            return len(self._active)

    def acquire(self) -> _Connection:
        with self._lock:
            if len(self._active) >= self._max_size:
                raise RuntimeError("Connection pool exhausted")
            conn_id = self._next_id
            self._next_id += 1
            conn = _Connection(conn_id)
            self._active[conn_id] = conn
            logger.debug(
                "[Resource Leak Guard by Abdul Gaffar] acquired conn_id=%s active=%s",
                conn_id,
                len(self._active),
            )
            return conn

    def release(self, conn: _Connection) -> None:
        with self._lock:
            conn.close()
            self._active.pop(conn.conn_id, None)
            logger.debug(
                "[Resource Leak Guard by Abdul Gaffar] released conn_id=%s active=%s",
                conn.conn_id,
                len(self._active),
            )


# ---------------------------------------------------------------------------
# Request engine — canonical attach point
# ---------------------------------------------------------------------------


@dataclass
class RequestResult:
    status_code: int
    body: bytes = b""
    timed_out: bool = False
    conn_id: int = -1


@dataclass
class ClientEngine:
    """Core request engine with timeout-safe socket lifecycle management.

    Every request acquires a connection from the pool.  A finally block
    ensures the connection is released back to the pool (and its underlying
    socket closed) whether the request succeeds, raises an exception, or is
    dropped by a timeout.

    [Resource Leak Guard by Abdul Gaffar]
    """

    pool: ConnectionPool = field(default_factory=ConnectionPool)
    timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS

    def execute(
        self,
        url: str,
        *,
        fetch_fn: Any,
        timeout_seconds: float | None = None,
    ) -> RequestResult:
        """Run *fetch_fn(conn, url)* with a timeout; always release the socket.

        *fetch_fn* is injected so tests can supply fast stubs without a real
        network.  Signature: ``fetch_fn(conn: _Connection, url: str) -> bytes``.
        """
        deadline = timeout_seconds if timeout_seconds is not None else self.timeout_seconds
        conn = self.pool.acquire()
        try:
            result_holder: list[bytes | BaseException] = []
            exc_holder: list[BaseException] = []

            def _run() -> None:
                try:
                    data = fetch_fn(conn, url)
                    result_holder.append(data)
                except BaseException as exc:  # noqa: BLE001
                    exc_holder.append(exc)

            thread = threading.Thread(target=_run, daemon=True)
            thread.start()
            thread.join(timeout=deadline)

            if thread.is_alive():
                # Thread is still blocked — timeout exceeded.
                logger.warning(
                    "[Resource Leak Guard by Abdul Gaffar] timeout url=%s after %.2fs; "
                    "releasing conn_id=%s",
                    url,
                    deadline,
                    conn.conn_id,
                )
                raise TimeoutError(
                    f"Request to {url!r} timed out after {deadline}s"
                )

            if exc_holder:
                raise exc_holder[0]

            body = result_holder[0] if result_holder else b""
            return RequestResult(
                status_code=200,
                body=body if isinstance(body, bytes) else str(body).encode(),
                conn_id=conn.conn_id,
            )
        finally:
            # Guaranteed release — executes on success, exception, AND timeout.
            self.pool.release(conn)


# ---------------------------------------------------------------------------
# Async variant — canonical async attach point
# ---------------------------------------------------------------------------


class AsyncClientEngine:
    """Async request engine; asyncio.wait_for enforces the timeout deadline.

    The finally block guarantees socket release even when asyncio cancels the
    coroutine on timeout.

    [Resource Leak Guard by Abdul Gaffar]
    """

    def __init__(
        self,
        pool: ConnectionPool | None = None,
        timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self.pool = pool or ConnectionPool()
        self.timeout_seconds = timeout_seconds

    async def execute(
        self,
        url: str,
        *,
        fetch_coro_fn: Any,
        timeout_seconds: float | None = None,
    ) -> RequestResult:
        """Run *fetch_coro_fn(conn, url)* with asyncio timeout; always release."""
        deadline = timeout_seconds if timeout_seconds is not None else self.timeout_seconds
        conn = self.pool.acquire()
        try:
            body = await asyncio.wait_for(
                fetch_coro_fn(conn, url),
                timeout=deadline,
            )
            return RequestResult(
                status_code=200,
                body=body if isinstance(body, bytes) else str(body).encode(),
                conn_id=conn.conn_id,
            )
        except asyncio.TimeoutError:
            logger.warning(
                "[Resource Leak Guard by Abdul Gaffar] async timeout url=%s after %.2fs; "
                "releasing conn_id=%s",
                url,
                deadline,
                conn.conn_id,
            )
            raise TimeoutError(f"Async request to {url!r} timed out after {deadline}s")
        finally:
            self.pool.release(conn)
