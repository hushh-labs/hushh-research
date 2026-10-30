"""Tests that every consent SSE subscriber queue is bounded.

api/consent_listener.py keeps one asyncio.Queue per connected SSE stream.
Postgres NOTIFY events are fanned into every queue for the account and drained
by the corresponding SSE generator. Each stream is isolated so a stalled or
slow consumer cannot starve another browser/device or accumulate an unbounded
backlog.

The fix creates each queue with a fixed maxsize and, when full, drops the
oldest pending event so the newest consent state still reaches the consumer.
These tests drive the real subscribe/unsubscribe and fan-out functions.
functions.

Reachable from api/routes/sse.py consent_event_generator (GET /events/{user_id}),
which subscribes a queue; events arrive via the Postgres NOTIFY callback
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


@pytest.mark.asyncio
async def test_subscribed_consent_queue_is_bounded():
    queue = await consent_listener.subscribe_consent_queue("user_1")
    assert queue.maxsize == consent_listener._CONSENT_NOTIFY_QUEUE_MAXSIZE
    assert queue.maxsize > 0


@pytest.mark.asyncio
async def test_push_drops_oldest_when_full_and_stays_bounded():
    user_id = "user_2"
    queue = await consent_listener.subscribe_consent_queue(user_id)
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
async def test_push_fans_out_and_slow_subscriber_does_not_starve_healthy_stream():
    user_id = "user_fanout"
    slow = await consent_listener.subscribe_consent_queue(user_id)
    healthy = await consent_listener.subscribe_consent_queue(user_id)
    maxsize = consent_listener._CONSENT_NOTIFY_QUEUE_MAXSIZE

    for i in range(maxsize):
        slow.put_nowait({"seq": i})

    event = {"seq": maxsize, "type": "location_circle_renamed"}
    await consent_listener._push_to_consent_queue(user_id, event)

    assert healthy.get_nowait() == event
    slow_items = [slow.get_nowait()["seq"] for _ in range(slow.qsize())]
    assert slow_items[-1] == maxsize
    assert 0 not in slow_items


@pytest.mark.asyncio
async def test_unsubscribe_removes_only_that_stream_then_cleans_empty_user_entry():
    user_id = "user_cleanup"
    first = await consent_listener.subscribe_consent_queue(user_id)
    second = await consent_listener.subscribe_consent_queue(user_id)

    await consent_listener.unsubscribe_consent_queue(user_id, first)
    await consent_listener._push_to_consent_queue(user_id, {"seq": 1})

    assert first.empty()
    assert second.get_nowait() == {"seq": 1}
    assert consent_listener._consent_notify_queues[user_id] == {second}

    await consent_listener.unsubscribe_consent_queue(user_id, second)
    assert user_id not in consent_listener._consent_notify_queues


@pytest.mark.asyncio
async def test_push_to_unknown_user_is_noop():
    # No queue exists for this user (no active SSE connection).
    await consent_listener._push_to_consent_queue("ghost_user", {"seq": 1})
    assert "ghost_user" not in consent_listener._consent_notify_queues
