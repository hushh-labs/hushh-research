"""One pooled LISTEN session shared by the hub notification consumers."""

from __future__ import annotations

import asyncio
from typing import Any

import asyncpg

_UNSET = object()


def listener_isolation_enabled() -> bool:
    from api.middlewares.observability import request_feature_enabled

    return request_feature_enabled("AUTH_DB_LISTENER_ISOLATION_ENABLED", default=False)


class _SharedListenerSession:
    """One pooled session for independent LISTEN subscribers, never request SQL."""

    def __init__(self, pool: Any, connection: Any) -> None:
        self.pool = pool
        self.connection = connection
        self.commands = asyncio.Lock()
        self.unavailable = asyncio.Event()
        self.borrowers = 0
        self.released = False
        connection.add_termination_listener(self._terminated)

    def _terminated(self, _connection: Any) -> None:
        self.unavailable.set()

    def is_closed(self) -> bool:
        if self.released or self.unavailable.is_set():
            return True
        try:
            return bool(self.connection.is_closed())
        except asyncpg.InterfaceError:
            # asyncpg detaches a proxy when its physical connection closes.
            return True

    async def call(self, method: str, *args: Any) -> Any:
        async with self.commands:
            if self.is_closed():
                raise ConnectionError("Shared LISTEN session is unavailable")
            try:
                return await getattr(self.connection, method)(*args)
            except BaseException:
                self.unavailable.set()
                raise

    async def close(self) -> None:
        if self.released:
            return
        failed = self.is_closed()
        try:
            physically_closed = self.connection.is_closed()
        except asyncpg.InterfaceError:
            physically_closed = True
        self.released = True
        self.unavailable.set()
        if not physically_closed:
            self.connection.remove_termination_listener(self._terminated)
        # A failed probe must not leave other subscribers sleeping on a broken
        # session, nor let reset of a half-open session retain a request slot.
        if failed and not physically_closed:
            self.connection.terminate()
        await self.pool.release(self.connection)


class _SharedListenerLease:
    def __init__(self, owner: "_SharedListenerOwner", session: _SharedListenerSession) -> None:
        self.owner = owner
        self.session = session
        self.subscriptions: list[tuple[str, Any]] = []
        self.released = False

    def is_closed(self) -> bool:
        return self.released or self.session.is_closed()

    async def _call(self, method: str, *args: Any) -> Any:
        if self.released:
            raise ConnectionError("LISTEN lease has been released")
        return await self.session.call(method, *args)

    async def execute(self, query: str) -> Any:
        return await self._call("execute", query)

    async def fetchval(self, query: str) -> Any:
        return await self._call("fetchval", query)

    async def add_listener(self, channel: str, callback: Any) -> None:
        await self._call("add_listener", channel, callback)
        self.subscriptions.append((channel, callback))

    async def remove_listener(self, channel: str, callback: Any) -> None:
        await self._call("remove_listener", channel, callback)
        if (channel, callback) in self.subscriptions:
            self.subscriptions.remove((channel, callback))

    async def release(self) -> None:
        if self.released:
            return
        self.released = True
        try:
            for channel, callback in tuple(self.subscriptions):
                if self.session.is_closed():
                    break
                await self.session.call("remove_listener", channel, callback)
        finally:
            self.subscriptions.clear()
            await self.owner.release(self.session)


class _SharedListenerOwner:
    def __init__(self, pool: Any) -> None:
        self.pool = pool
        self.lock = asyncio.Lock()
        self.session: _SharedListenerSession | None = None

    async def acquire(self) -> _SharedListenerLease:
        async with self.lock:
            if self.session is not None and self.session.is_closed():
                await self.session.close()
                self.session = None
            if self.session is None:
                connection = await self.pool.acquire(timeout=None)
                try:
                    self.session = _SharedListenerSession(self.pool, connection)
                except BaseException:
                    await self.pool.release(connection)
                    raise
            self.session.borrowers += 1
            return _SharedListenerLease(self, self.session)

    async def release(self, session: _SharedListenerSession) -> None:
        async with self.lock:
            session.borrowers -= 1
            if session.borrowers == 0:
                await session.close()
                if self.session is session:
                    self.session = None


_shared_listener_owners: dict[Any, _SharedListenerOwner] = {}


async def acquire_listener_connection(pool: Any, *, timeout: Any = _UNSET) -> Any:
    """Keep notification consumers inside one existing pool slot.

    The shared background session can wait for capacity; request operations keep
    their existing acquisition deadlines. Explicit legacy timeouts are preserved.
    """
    if not listener_isolation_enabled():
        return await (pool.acquire() if timeout is _UNSET else pool.acquire(timeout=timeout))
    owner = _shared_listener_owners.get(pool)
    if owner is None:
        owner = _SharedListenerOwner(pool)
        _shared_listener_owners[pool] = owner
    return await owner.acquire()


async def release_listener_connection(pool: Any, connection: Any) -> None:
    if isinstance(connection, _SharedListenerLease):
        await connection.release()
        return
    await pool.release(connection)


async def wait_for_listener_connection(connection: Any, interval: float) -> None:
    if not isinstance(connection, _SharedListenerLease):
        await asyncio.sleep(interval)
        return
    try:
        await asyncio.wait_for(connection.session.unavailable.wait(), timeout=interval)
    except TimeoutError:
        return
    raise ConnectionError("Shared LISTEN session is unavailable")


def forget_listener_pool(pool: Any) -> None:
    """Drop idle transport metadata after the owning pool has closed."""
    _shared_listener_owners.pop(pool, None)
