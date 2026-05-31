"""Tests for SSE consent queue cleanup on disconnect (memory leak fix).

The fix uses reference counting so a single disconnect does not evict the
queue while another concurrent same-user SSE connection is still reading.

  get_consent_queue(user_id)   -- increments refcount, creates queue on first call
  release_consent_queue(user_id) -- decrements refcount, removes queue when it hits 0

Canonical attach:
  api/routes/sse.py          -- consent_event_generator calls release in finally
  api/consent_listener.py    -- _consent_notify_queues, _consent_queue_refcount
"""

def _reset() -> None:
    from api import consent_listener
    consent_listener._consent_notify_queues.clear()
    consent_listener._consent_queue_refcount.clear()


# ---------------------------------------------------------------------------
# Unit tests for ref-counted queue helpers
# ---------------------------------------------------------------------------


class TestRefCountedQueueHelpers:
    def setup_method(self):
        _reset()

    def test_first_get_creates_queue_and_sets_refcount_to_1(self):
        from api.consent_listener import (
            _consent_notify_queues,
            _consent_queue_refcount,
            get_consent_queue,
        )
        get_consent_queue("user-a")
        assert "user-a" in _consent_notify_queues
        assert _consent_queue_refcount["user-a"] == 1

    def test_second_get_for_same_user_increments_refcount(self):
        from api.consent_listener import _consent_queue_refcount, get_consent_queue
        get_consent_queue("user-a")
        get_consent_queue("user-a")
        assert _consent_queue_refcount["user-a"] == 2

    def test_second_get_returns_same_queue_object(self):
        from api.consent_listener import get_consent_queue
        q1 = get_consent_queue("user-a")
        q2 = get_consent_queue("user-a")
        assert q1 is q2

    def test_release_with_one_ref_removes_queue(self):
        from api.consent_listener import (
            _consent_notify_queues,
            _consent_queue_refcount,
            get_consent_queue,
            release_consent_queue,
        )
        get_consent_queue("user-a")
        release_consent_queue("user-a")
        assert "user-a" not in _consent_notify_queues
        assert "user-a" not in _consent_queue_refcount

    def test_release_with_two_refs_preserves_queue_for_second_connection(self):
        """Two connections hold refs; first disconnect must not remove the queue."""
        from api.consent_listener import (
            _consent_notify_queues,
            _consent_queue_refcount,
            get_consent_queue,
            release_consent_queue,
        )
        get_consent_queue("user-a")
        get_consent_queue("user-a")
        assert _consent_queue_refcount["user-a"] == 2

        release_consent_queue("user-a")
        assert "user-a" in _consent_notify_queues, (
            "Queue must survive first disconnect when a second connection is still active"
        )
        assert _consent_queue_refcount["user-a"] == 1

    def test_release_twice_removes_queue_after_both_disconnects(self):
        from api.consent_listener import (
            _consent_notify_queues,
            _consent_queue_refcount,
            get_consent_queue,
            release_consent_queue,
        )
        get_consent_queue("user-a")
        get_consent_queue("user-a")
        release_consent_queue("user-a")
        release_consent_queue("user-a")
        assert "user-a" not in _consent_notify_queues
        assert "user-a" not in _consent_queue_refcount

    def test_release_noop_when_user_never_registered(self):
        from api.consent_listener import _consent_notify_queues, release_consent_queue
        release_consent_queue("nonexistent-user")
        assert "nonexistent-user" not in _consent_notify_queues

    def test_independent_users_do_not_interfere(self):
        from api.consent_listener import (
            _consent_notify_queues,
            get_consent_queue,
            release_consent_queue,
        )
        get_consent_queue("user-a")
        get_consent_queue("user-b")
        release_consent_queue("user-a")
        assert "user-a" not in _consent_notify_queues
        assert "user-b" in _consent_notify_queues
        release_consent_queue("user-b")
        assert "user-b" not in _consent_notify_queues

    def test_notify_queue_receives_events_after_first_of_two_disconnects(self):
        """Second connection can still receive events after the first disconnects."""
        from api.consent_listener import (
            get_consent_queue,
            release_consent_queue,
        )
        q = get_consent_queue("user-a")
        get_consent_queue("user-a")

        q.put_nowait({"request_id": "req-001"})
        release_consent_queue("user-a")

        from api import consent_listener
        still_alive = consent_listener._consent_notify_queues.get("user-a")
        assert still_alive is not None, "Queue must still exist for the second connection"
        item = still_alive.get_nowait()
        assert item["request_id"] == "req-001"
        release_consent_queue("user-a")
        release_consent_queue("user-a")
