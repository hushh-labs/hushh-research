"""One pass per interval across the hub fleet, for the sweeps that judge the whole fleet.

Why this exists
---------------
``server.py`` attaches the pod liveness sweep (every 120 s) and the personal-agent
reconcile sweep (every 300 s) in every hub process that is not a pod. ``pod_mode()``
keeps pods out, and the comments beside it called each sweep a "control-plane
singleton", but nothing made it one: the hub itself runs as many instances, each
with its own workers. Live hub logs over 07:00-10:00 UTC held 463 liveness passes and
549 reconcile passes from 11 distinct instance ids. Every per-pass bound (the upgrade
batch, the orphan erase batch, the heal ladder) was therefore multiplied by the
instance count: the default upgrade batch of three pods per five minutes, chosen so a
bad image reaches only the first few people, was three pods per instance instead.

How
---
A Postgres session advisory lock per sweep, taken with ``pg_try_advisory_lock`` on a
dedicated connection. Dedicated, never the request pool, for the reason
``db.connection.dedicated_connection`` states: a lock held through slow provider calls
must not reserve one of the request pool's few connections.

The loop holds the lock through its pass AND the sleep after it, then releases and
contends again. Holding it for the pass alone would only stop passes overlapping: a
mostly empty pass finishes in milliseconds, so every instance would still get its own
turn each interval, and the bounds would stay multiplied. Holding it through the sleep
is what spaces the fleet's passes at least one interval apart.

The connection ceiling
----------------------
Dev peaked at 99 of 100 connections, so the lock must not add standing ones. A process
whose try is refused closes that connection before it sleeps: it held it for one round
trip. Only the turn holder keeps a connection, exactly one per sweep, for the whole
fleet. A connect refused because the database is full is just a refused turn.

The properties the callers rely on
----------------------------------
* **Never waits.** ``pg_try_advisory_lock``, not ``pg_advisory_lock``: a turn held
  elsewhere yields ``False`` at once and the caller just sleeps to its next tick.
* **Fails closed.** A database that cannot be reached, a refused connection, or any
  error taking the lock yields ``False``. The pass is skipped, never run unlocked; an
  unreachable database means "not this process's turn", not "no lock needed".
* **Always releases.** The lock is released in a ``finally`` whatever the pass did. An
  unlock that fails or stalls terminates the connection instead, and ending the session
  releases every session lock regardless, so a pass that raises, or a task cancelled
  at shutdown, never strands the sweep. A holder whose connection drops loses the lock
  with it, so another process takes the turn on its next tick, within one interval.
  The lock is not re-checked mid-pass, so a holder whose connection drops part way
  finishes that pass while the next holder starts one: at worst two passes overlap,
  never one per instance. ``dedicated_connection`` sets no TCP keepalive (follow-up).
* **Releases at shutdown.** :func:`release_held_turns` cancels the tasks holding a
  turn, so a stopping server hands the sweep on at once instead of when its sockets
  happen to close.

Key space
---------
The two-int4 form, ``(FLEET_SWEEP_LOCK_NAMESPACE, sweep_id)``. Every other advisory
lock in this codebase uses the single-bigint form, which Postgres keeps in a separate
key space (``objsubid`` 1 rather than 2 in ``pg_locks``), so a fleet sweep can never
collide with a per-person ``hashtextextended`` lock.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Callable
from contextlib import (
    AbstractAsyncContextManager,
    AsyncExitStack,
    asynccontextmanager,
    nullcontext,
)
from dataclasses import dataclass, field
from typing import Any, Optional

logger = logging.getLogger(__name__)

#: First half of every fleet-sweep advisory key: the ASCII bytes "FSLK".
FLEET_SWEEP_LOCK_NAMESPACE = 0x46534C4B

_TRY_LOCK_SQL = "SELECT pg_try_advisory_lock($1::int4, $2::int4)"
_UNLOCK_SQL = "SELECT pg_advisory_unlock($1::int4, $2::int4)"

#: A healthy unlock is one round trip. Past this the connection is presumed dead and is
#: terminated, which ends the session and so releases the lock server side anyway.
_UNLOCK_TIMEOUT_SECONDS = 5.0

#: Opens one connection for the lifetime of a turn. Injected so tests never need a DB.
Connect = Callable[[], AbstractAsyncContextManager[Any]]

#: The tasks holding a turn right now, so shutdown can release them deliberately.
_HOLDERS: set[asyncio.Task[Any]] = set()


def _dedicated_connection() -> AbstractAsyncContextManager[Any]:
    # Imported on use: db.connection loads the environment at import time, and the
    # sweep modules importing this one are imported by tests that never open a DB.
    from db.connection import dedicated_connection  # noqa: PLC0415

    return dedicated_connection()


@dataclass(frozen=True)
class FleetSweepLock:
    """One fleet-wide sweep's turn. ``sweep_id`` is its half of the advisory key."""

    name: str
    sweep_id: int
    connect: Connect = field(default=_dedicated_connection, compare=False, repr=False)

    @asynccontextmanager
    async def turn(self) -> AsyncIterator[bool]:
        """Yield ``True`` while this process holds the sweep for the whole fleet.

        ``False`` means skip the pass: the turn is held elsewhere or the lock could not
        be taken at all, and no connection is kept open. Whatever the body does,
        leaving releases the lock and closes the connection.
        """
        stack = AsyncExitStack()
        conn: Any = None
        holder = asyncio.current_task()
        try:
            conn = await self._try_lock(stack)
            if conn is None:
                # A skipped turn keeps no connection open through the caller's sleep.
                await _close(stack, self.name)
            elif holder is not None:
                _HOLDERS.add(holder)
            yield conn is not None
        finally:
            if holder is not None:
                _HOLDERS.discard(holder)
            try:
                if conn is not None:
                    await self._unlock(conn)
            finally:
                await _close(stack, self.name)

    async def _try_lock(self, stack: AsyncExitStack) -> Any:
        """The connection now holding the lock, or ``None`` when it is not our turn."""
        try:
            conn = await stack.enter_async_context(self.connect())
            acquired = await conn.fetchval(_TRY_LOCK_SQL, FLEET_SWEEP_LOCK_NAMESPACE, self.sweep_id)
        except Exception as exc:  # noqa: BLE001 - unreachable means skip, never unlocked
            logger.warning(
                "fleet_sweep.skip sweep=%s reason=lock_unavailable error=%s",
                self.name,
                type(exc).__name__,
            )
            return None
        if acquired is not True:
            # The normal case for every process but one, every tick: debug, not info.
            logger.debug("fleet_sweep.skip sweep=%s reason=held_elsewhere", self.name)
            return None
        logger.debug("fleet_sweep.turn sweep=%s", self.name)
        return conn

    async def _unlock(self, conn: Any) -> None:
        try:
            await asyncio.wait_for(
                conn.execute(_UNLOCK_SQL, FLEET_SWEEP_LOCK_NAMESPACE, self.sweep_id),
                _UNLOCK_TIMEOUT_SECONDS,
            )
        except Exception as exc:  # noqa: BLE001 - ending the session releases it anyway
            logger.warning(
                "fleet_sweep.unlock_failed sweep=%s error=%s", self.name, type(exc).__name__
            )
            _terminate(conn, self.name)


def _terminate(conn: Any, name: str) -> None:
    """End the session without a round trip, so a dead socket cannot stall the close."""
    terminate = getattr(conn, "terminate", None)
    if not callable(terminate):
        return
    try:
        terminate()
    except Exception as exc:  # noqa: BLE001 - the close that follows is the backstop
        logger.warning("fleet_sweep.terminate_failed sweep=%s error=%s", name, type(exc).__name__)


async def _close(stack: AsyncExitStack, name: str) -> None:
    try:
        await stack.aclose()
    except Exception as exc:  # noqa: BLE001 - a failed close must not mask the pass
        logger.warning("fleet_sweep.close_failed sweep=%s error=%s", name, type(exc).__name__)


def fleet_turn(lock: Optional[FleetSweepLock]) -> AbstractAsyncContextManager[bool]:
    """``lock``'s turn, or one that is always granted when no lock was given.

    No lock is the single-process shape (a test, a lone runtime). Production wiring in
    ``server.py`` always passes one of the module constants below.
    """
    return lock.turn() if lock is not None else nullcontext(True)


async def release_held_turns(timeout_seconds: float = 5.0) -> int:
    """Cancel every task holding a fleet turn and wait, bounded, for its release.

    For shutdown: the cancelled loop leaves its turn through the same ``finally`` that
    releases it after any pass, so the next process takes the sweep on its next tick.
    Tasks that are only waiting for a turn hold nothing and are left alone.

    A pass can be cut mid-step (an orphan erasure included), as uvicorn's teardown
    already did, only later. Recovery rests on each step being idempotent and on the
    next holder seeing the leftover again: an orphan restarts its confirmation clock.
    """
    current = asyncio.current_task()
    holders = [task for task in _HOLDERS if task is not current and not task.done()]
    for task in holders:
        task.cancel()
    if holders:
        await asyncio.wait(holders, timeout=timeout_seconds)
        logger.info("fleet_sweep.released_at_shutdown turns=%d", len(holders))
    return len(holders)


POD_LIVENESS = FleetSweepLock(name="pod_liveness", sweep_id=1)
PERSONAL_AGENT_RECONCILE = FleetSweepLock(name="personal_agent_reconcile", sweep_id=2)
