"""Tests that the consent notify queue is bounded.

api/consent_listener.py keeps one asyncio.Queue per connected SSE user.
Postgres NOTIFY events are pushed into the queue by _push_to_consent_queue and
drained by the SSE generator. The queue was created with no maxsize, so the
QueueFull branch in _push_to_consent_queue was unreachable and a stalled or
slow consumer could accumulate an unbounded backlog and exhaust memory.

The fix creates each queue with a fixed maxsize and, when full, drops the
oldest pending event so the newest consent state still reaches the consumer.
These tests drive the real get_consent_queue and _push_to_consent_queue
functions.

Reachable from api/routes/sse.py consent_event_generator (GET /events/{user_id}),
which calls get_consent_queue; events arrive via the Postgres NOTIFY callback
that calls _push_to_consent_queue.
"""

from __future__ import annotations

import pytest

from api import consent_listener


@pytest.fixture(autouse=True)
def _clear_queues():
    consent_listener._consent_notify_queues.clear()
    yield
    consent_listener._consent_notify_queues.clear()


def test_get_consent_queue_is_bounded():
    queue = consent_listener.get_consent_queue("user_1")
    assert queue.maxsize == consent_listener._CONSENT_NOTIFY_QUEUE_MAXSIZE
    assert queue.maxsize > 0


@pytest.mark.asyncio
async def test_push_drops_oldest_when_full_and_stays_bounded():
    user_id = "user_2"
    queue = consent_listener.get_consent_queue(user_id)
    maxsize = consent_listener._CONSENT_NOTIFY_QUEUE_MAXSIZE

    # Fill the queue to capacity through the real push path.
    for i in range(maxsize):
        await consent_listener._push_to_consent_queue(user_id, {"seq": i})
    assert queue.qsize() == maxsize

    # One more push must not grow the queue past its bound.
    await consent_listener._push_to_consent_queue(user_id, {"seq": maxsize})
    assert queue.qsize() == maxsize

    # The newest event is retained and the oldest was dropped.
    drained = [queue.get_nowait()["seq"] for _ in range(queue.qsize())]
    assert drained[-1] == maxsize
    assert 0 not in drained


@pytest.mark.asyncio
async def test_push_to_unknown_user_is_noop():
    # No queue exists for this user (no active SSE connection).
    await consent_listener._push_to_consent_queue("ghost_user", {"seq": 1})
    assert "ghost_user" not in consent_listener._consent_notify_queues
