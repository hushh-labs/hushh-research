"""Pod-lifecycle NOTIFY listener: LISTEN pod_lifecycle_new, ring per-user doorbells.

A sibling of ``api/consent_listener.py`` rather than an addition to it: that
module also owns FCM delivery, timeout jobs, and reminder jobs, and has a
different failure envelope. This one does exactly one thing -- when Postgres
says a narrative row landed, nudge any open stream for that user so it reads
the log NOW instead of at its next heartbeat tick.

THE PAYLOAD IS A DOORBELL, NEVER DATA. The trigger (migration 907) emits only
``{user_id, seq}``; a NOTIFY payload is readable by any session that can
LISTEN, so nothing worth protecting may ride in it. The stream re-reads the
actual rows by cursor.

A DROPPED DOORBELL LOSES NOTHING. The reader is cursored: the next doorbell or
the stream's own heartbeat tick catches up with ``WHERE seq > cursor``. That is
the property the consent SSE lacks (it backfills a fixed wall-clock window and
ignores Last-Event-ID), and the reason this listener can use a small bounded
queue and drop the oldest without ceremony.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from typing import Dict

logger = logging.getLogger(__name__)

_QUEUE_MAXSIZE = 100

_queues: Dict[str, asyncio.Queue] = {}
_queues_lock = asyncio.Lock()
_listener_active = False


async def register(user_id: str) -> asyncio.Queue:
    """A doorbell queue for one user's open stream. Caller must unregister."""
    async with _queues_lock:
        queue = _queues.get(user_id)
        if queue is None:
            queue = asyncio.Queue(maxsize=_QUEUE_MAXSIZE)
            _queues[user_id] = queue
        return queue


async def unregister(user_id: str) -> None:
    async with _queues_lock:
        _queues.pop(user_id, None)


def listener_active() -> bool:
    """Whether LISTEN is up -- streams poll on heartbeat alone when it is not."""
    return _listener_active


def _notify_callback(_conn, _pid, _channel, payload: str) -> None:
    """Sync callback from asyncpg on NOTIFY pod_lifecycle_new."""
    try:
        parsed = json.loads(payload or "{}")
        user_id = str(parsed.get("user_id") or "")
        seq = int(parsed.get("seq") or 0)
    except Exception:  # noqa: BLE001 - a malformed doorbell is just no doorbell
        return
    if not user_id:
        return
    queue = _queues.get(user_id)
    if queue is None:
        return  # nobody is streaming for this user; the log row still exists
    try:
        queue.put_nowait(seq)
    except asyncio.QueueFull:
        # Drop the OLDEST: the newest seq is the one that lets the reader catch
        # everything up in a single cursored SELECT.
        with contextlib.suppress(Exception):
            queue.get_nowait()
            queue.put_nowait(seq)


async def run_pod_lifecycle_listener() -> None:
    """Long-running task: LISTEN pod_lifecycle_new for the process lifetime.

    Same acquisition/release discipline as ``run_consent_listener``. If the pool
    is unavailable the task exits quietly: streams degrade to heartbeat-paced
    reads, which is slower narrative, not lost narrative.
    """
    global _listener_active
    try:
        from db.connection import get_pool

        pool = await get_pool()
    except Exception as exc:  # noqa: BLE001 - no pool means degrade, not crash
        logger.warning("pod_lifecycle_listener.pool_unavailable err=%s", type(exc).__name__)
        return
    conn = None
    try:
        conn = await pool.acquire()
        await conn.execute("LISTEN pod_lifecycle_new")
        await conn.add_listener("pod_lifecycle_new", _notify_callback)
        _listener_active = True
        logger.info("pod_lifecycle_listener.active channel=pod_lifecycle_new")
        while True:
            await asyncio.sleep(3600)
    except asyncio.CancelledError:
        logger.info("pod_lifecycle_listener.cancelled")
    except Exception:
        logger.exception("pod_lifecycle_listener.error")
    finally:
        _listener_active = False
        if conn is not None:
            with contextlib.suppress(Exception):
                await conn.remove_listener("pod_lifecycle_new", _notify_callback)
                await conn.execute("UNLISTEN pod_lifecycle_new")
            with contextlib.suppress(Exception):
                await pool.release(conn)
