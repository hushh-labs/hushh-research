"""Referral NOTIFY listener: LISTEN one_referral_changed, push to open streams.

The Referrals tab used to poll. A referral changes state from something the
OTHER person did -- they finished setup, they opened an agent, their credited
minutes crossed the bar -- and the referrer is touching nothing while any of
that happens, so a number that only moves on a reload is wrong the moment it is
drawn.

This is the bridge: Postgres raises NOTIFY on the write, every backend instance
holds one LISTEN connection, and each pushes to the queues of whichever
referrers happen to have a stream open on that instance.

WHY A DOORBELL, NOT A PAYLOAD. What arrives on the queue is "your referrals
changed" and a reason. It carries nothing about the referred person, because a
NOTIFY payload travels to every listening connection on the database, and
because deciding what a referrer may see already has one owner -- the
authenticated summary endpoint. Copying that decision into a trigger would mean
maintaining it in two places and getting it wrong in the one nobody reads.

Modelled on api/consent_listener.py, which has run this same shape in
production; the differences are the channel, the queue key, and the fact that
nothing here sends a push notification.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from typing import Any, Dict

from db import listener_connection as listener_transport

logger = logging.getLogger(__name__)

CHANNEL = "one_referral_changed"

# One bounded queue per authenticated stream on THIS instance. Bounded, because
# a client that stops reading must not be able to grow a queue without limit --
# and because a referrer who has fallen behind by more than a few doorbells
# learns nothing extra from the older ones.
_QUEUE_MAXSIZE = 16

_queues: Dict[str, set[asyncio.Queue]] = {}
_queues_lock = asyncio.Lock()
_listener_active = False
_serving_loop: asyncio.AbstractEventLoop | None = None


def get_referral_queue(user_id: str) -> asyncio.Queue:
    """The queue a referrer's open stream reads from."""
    queue: asyncio.Queue[Dict[str, Any]] = asyncio.Queue(maxsize=_QUEUE_MAXSIZE)
    _queues.setdefault(user_id, set()).add(queue)
    return queue


async def release_referral_queue(user_id: str, queue: asyncio.Queue) -> None:
    """Remove only this device's stream; other devices keep their own queue."""
    async with _queues_lock:
        subscribers = _queues.get(user_id)
        if subscribers is not None:
            subscribers.discard(queue)
            if not subscribers:
                _queues.pop(user_id, None)


def get_referral_listener_status() -> dict:
    return {
        "active": _listener_active,
        "channel": CHANNEL,
        "queue_count": sum(len(queues) for queues in _queues.values()),
    }


def _push(user_id: str, data: Dict[str, Any]) -> None:
    """Hand one doorbell to a waiting stream, if there is one on this instance.

    Never blocks and never raises. A full queue is dropped on purpose: the
    client's next read of the summary is a full refresh anyway, so a missed
    doorbell costs a few seconds of staleness, while blocking the LISTEN
    callback would stall every other referrer's stream behind it.
    """
    for queue in tuple(_queues.get(user_id, ())):
        try:
            if queue.full():
                queue.get_nowait()  # retain the newest state-change doorbell
            queue.put_nowait(data)
        except Exception:
            logger.exception("referral_listener.push_failed")


def _broadcast(message: Dict[str, Any]) -> None:
    # This doorbell contains no balances, membership or identity information.
    for user_id in list(_queues):
        _push(user_id, message)


def _deliver(user_id: str, message: Dict[str, Any]) -> None:
    if user_id:
        _push(user_id, message)
    else:
        _broadcast(message)


def _notify_callback(connection, pid, channel, payload: str) -> None:
    """Sync callback asyncpg invokes on NOTIFY. Must not block or raise."""
    try:
        data = json.loads(payload or "{}")
    except Exception:  # noqa: BLE001
        logger.warning("referral_listener.bad_payload")
        return

    if not isinstance(data, dict):
        return
    user_id = str(data.get("referrer_user_id") or "").strip()
    message = {"reason": str(data.get("reason") or "changed")}
    if not user_id and message["reason"] not in {
        "leaderboard_published",
        "weekly_prizes_enabled",
        "circle_wars_changed",
    }:
        return

    loop = _serving_loop
    if loop is not None and loop.is_running():
        # asyncpg may deliver on a different loop than the one serving requests.
        loop.call_soon_threadsafe(_deliver, user_id, message)
    else:
        _deliver(user_id, message)


async def run_referral_listener() -> None:
    """Long-running task: LISTEN one_referral_changed for this instance.

    One connection per instance, not per stream. Postgres broadcasts a NOTIFY to
    every listening connection on the database, so each instance receives every
    referral change and pushes only to the referrers it happens to be serving --
    which is what makes this work across several Cloud Run instances without any
    instance-to-instance messaging.
    """
    global _listener_active, _serving_loop

    with contextlib.suppress(RuntimeError):
        _serving_loop = asyncio.get_running_loop()

    try:
        from db.connection import get_pool

        pool = await get_pool()
    except Exception as exc:  # noqa: BLE001
        # No pool means no push. The tab keeps its polling fallback, so this
        # degrades freshness rather than breaking the screen.
        logger.error("Referral listener: DB pool unavailable (%s), skipping LISTEN", exc)
        return

    while True:
        conn = None
        try:
            conn = await listener_transport.acquire_listener_connection(pool)
            await conn.execute(f"LISTEN {CHANNEL}")
            await conn.add_listener(CHANNEL, _notify_callback)
            _listener_active = True
            logger.info("Referral NOTIFY listener active (%s)", CHANNEL)
            while True:
                await listener_transport.wait_for_listener_connection(conn, 3600)
        except asyncio.CancelledError:
            logger.info("Referral listener cancelled")
            return
        except Exception as exc:  # noqa: BLE001
            logger.exception("Referral listener error: %s", exc)
        finally:
            _listener_active = False
            if conn is not None:
                with contextlib.suppress(Exception):
                    await conn.remove_listener(CHANNEL, _notify_callback)
                with contextlib.suppress(Exception):
                    await conn.execute(f"UNLISTEN {CHANNEL}")
                with contextlib.suppress(Exception):
                    await listener_transport.release_listener_connection(pool, conn)
        if not listener_transport.listener_isolation_enabled():
            return
        await asyncio.sleep(5)
