"""Listener isolation retains request capacity in the existing four-slot pool."""

from __future__ import annotations

import asyncio

import pytest

from db.connection import DatabaseUnavailableError
from tests.helpers.asyncpg_pool import _Holder, _Pool


@pytest.fixture(autouse=True)
def _fast_deadline(monkeypatch):
    monkeypatch.setenv("DB_POOL_ACQUIRE_TIMEOUT_SECONDS", "0.25")


class _ListenerConnection:
    def __init__(self):
        self.callbacks = {}
        self.termination_callbacks = set()
        self.closed = False
        self.executing = False

    def is_closed(self):
        return self.closed

    def add_termination_listener(self, callback):
        self.termination_callbacks.add(callback)

    def remove_termination_listener(self, callback):
        self.termination_callbacks.discard(callback)

    async def execute(self, _query):
        assert not self.executing, "overlapping commands on a shared asyncpg session"
        self.executing = True
        try:
            await asyncio.sleep(0)
        finally:
            self.executing = False

    async def fetchval(self, query):
        await self.execute(query)
        return 1

    async def add_listener(self, channel, callback):
        await self.execute("LISTEN")
        self.callbacks.setdefault(channel, set()).add(callback)

    async def remove_listener(self, channel, callback):
        await self.execute("UNLISTEN")
        self.callbacks.get(channel, set()).discard(callback)

    def terminate(self):
        self.closed = True
        for callback in tuple(self.termination_callbacks):
            callback(self)


class _ListenerPool(_Pool):
    def __init__(self):
        super().__init__()
        self.holders = {}
        for _ in range(4):
            connection = _ListenerConnection()
            holder = _Holder(connection=connection)
            self.holders[connection] = holder
            self._queue.put_nowait(holder)

    async def release(self, connection, *, timeout=None):
        assert connection not in self.released, "listener generation released twice"
        self.released.append(connection)
        self._queue.put_nowait(self.holders[connection])


@pytest.mark.asyncio
@pytest.mark.feature_auth_reliability
@pytest.mark.trace_loop
@pytest.mark.parametrize("isolation", [False, True])
async def test_listener_load_preserves_request_capacity_without_new_connections(
    monkeypatch, isolation
):
    """Three lifetime subscribers must not reduce a four-slot pool to one request."""
    from db import listener_connection as database

    monkeypatch.setattr(database, "listener_isolation_enabled", lambda: isolation)
    monkeypatch.setattr(database, "_shared_listener_owners", {})
    pool = _ListenerPool()
    listeners = []
    request_connections = []
    observed = []
    channels = ("consent_audit_new", "one_referral_changed", "pod_lifecycle_new")
    try:
        for channel in channels:
            listener = await database.acquire_listener_connection(pool)
            listeners.append(listener)
            await listener.add_listener(channel, lambda *event: observed.append(event[2]))
        await asyncio.gather(*(listener.execute("SELECT 1") for listener in listeners))
        request_connections.append(await pool.acquire())
        if isolation:
            request_connections.append(await pool.acquire())
            # Same callbacks, same channel dispatch, one physical session.
            session = listeners[0].session
            assert all(listener.session is session for listener in listeners)
            assert pool._queue.qsize() == 1
            for channel, callbacks in session.connection.callbacks.items():
                for callback in callbacks:
                    callback(session.connection, 0, channel, "{}")
            assert observed == list(channels)
        else:
            # Negative control: the serving topology has only one request slot.
            with pytest.raises(DatabaseUnavailableError):
                await pool.acquire()
    finally:
        for connection in request_connections:
            await pool.release(connection)
        for listener in listeners:
            await database.release_listener_connection(pool, listener)
    assert pool._queue.qsize() == 4
    if isolation:
        assert all(not callbacks for conn in pool.holders for callbacks in conn.callbacks.values())


@pytest.mark.asyncio
@pytest.mark.feature_auth_reliability
@pytest.mark.trace_loop
async def test_shared_listener_failure_wakes_peers_and_old_cleanup_cannot_release_replacement(
    monkeypatch,
):
    from db import listener_connection as database

    monkeypatch.setattr(database, "listener_isolation_enabled", lambda: True)
    monkeypatch.setattr(database, "_shared_listener_owners", {})
    pool = _ListenerPool()
    first = await database.acquire_listener_connection(pool)
    peer = await database.acquire_listener_connection(pool)
    old_session = first.session
    await database.release_listener_connection(pool, first)
    with pytest.raises(ConnectionError, match="lease has been released"):
        await first.fetchval("SELECT 1")
    assert await peer.fetchval("SELECT 1") == 1
    waiter = asyncio.create_task(database.wait_for_listener_connection(peer, 3600))
    old_session.connection.terminate()
    with pytest.raises(ConnectionError):
        await asyncio.wait_for(waiter, 1)
    replacement = await database.acquire_listener_connection(pool)
    assert replacement.session is not old_session
    assert pool.released == [old_session.connection]
    await database.release_listener_connection(pool, first)
    await database.release_listener_connection(pool, peer)
    assert not replacement.is_closed()
    assert await replacement.fetchval("SELECT 1") == 1
    await database.release_listener_connection(pool, replacement)
    assert pool._queue.qsize() == 4
    # The original pool owner also releases the new transport's idle metadata.
    from unittest.mock import AsyncMock

    from db import connection as pool_database

    pool.close = AsyncMock()
    monkeypatch.setattr(pool_database, "_pool", pool)
    await pool_database.close_pool()
    assert pool not in database._shared_listener_owners


@pytest.mark.asyncio
@pytest.mark.feature_auth_reliability
@pytest.mark.trace_loop
async def test_all_hub_listener_entrypoints_share_one_slot_and_release_on_cancellation(monkeypatch):
    from unittest.mock import AsyncMock

    from api import consent_listener, pod_lifecycle_listener, referral_listener
    from db import listener_connection as database

    pool = _ListenerPool()
    monkeypatch.setattr(database, "listener_isolation_enabled", lambda: True)
    monkeypatch.setattr(database, "_shared_listener_owners", {})
    monkeypatch.setattr("db.connection.get_pool", AsyncMock(return_value=pool))
    monkeypatch.setattr(consent_listener, "broadcast_local_resync", AsyncMock())

    async def dormant():
        await asyncio.Event().wait()

    monkeypatch.setattr(consent_listener, "_timeout_job_loop", dormant)
    monkeypatch.setattr(consent_listener, "_notification_job_loop", dormant)
    tasks = [
        asyncio.create_task(consent_listener.run_consent_listener()),
        asyncio.create_task(referral_listener.run_referral_listener()),
        asyncio.create_task(pod_lifecycle_listener.run_pod_lifecycle_listener()),
    ]
    requests = []
    expected = {
        "consent_audit_new",
        consent_listener.USER_STATE_CHANNEL,
        "system_push_ready",
        referral_listener.CHANNEL,
        "pod_lifecycle_new",
    }

    async def registered():
        while not expected <= set().union(*(connection.callbacks for connection in pool.holders)):
            await asyncio.sleep(0)

    try:
        await asyncio.wait_for(registered(), 1)
        assert pool._queue.qsize() == 3, (
            "listener consumers retained more than one request-pool slot"
        )
        requests = [await pool.acquire(), await pool.acquire()]
        assert all(not task.done() for task in tasks)
    finally:
        for connection in requests:
            await pool.release(connection)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    assert pool._queue.qsize() == 4
    assert all(
        not callbacks for connection in pool.holders for callbacks in connection.callbacks.values()
    )
    assert not consent_listener._listener_active
    assert not referral_listener._listener_active
    assert not pod_lifecycle_listener._listener_active
