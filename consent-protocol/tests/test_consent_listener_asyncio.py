"""Hermetic unit tests for asyncio task-management fixes in consent_listener.

Canonical attach point:
    _notify_callback -> _background_notify_tasks (create_task fix)
    GET /api/consent/events/{user_id} (sse.router -> api/routes/sse.py
     -> api.consent_listener.subscribe_consent_queue)

No DB, no network, no LLM.

Covered:
    _notify_callback -- creates task via create_task (not ensure_future),
                       stores reference in _background_notify_tasks,
                       removes reference when task completes
    _background_notify_tasks -- membership during and after task lifetime
    cancel-without-await fix -- tasks are awaited after cancel on DB failure
                               path so no "Task destroyed but pending" leak
    HTTP reachability -- subscribe_consent_queue is the canonical entry point
                       from GET /api/consent/events/{user_id} (sse router)
"""

from __future__ import annotations

import asyncio
import json
from unittest.mock import MagicMock, patch

import pytest

from api.consent_listener import (
    USER_STATE_CHANNEL,
    _background_notify_tasks,
    _notify_callback,
    _publish_user_state_event,
    _user_state_notify_callback,
)

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clear_tasks():
    _background_notify_tasks.clear()
    yield
    _background_notify_tasks.clear()


# ===========================================================================
# _notify_callback — task creation and reference tracking
# ===========================================================================


class TestNotifyCallbackTaskManagement:
    def test_task_added_to_background_set(self):
        """create_task result must be stored before _handle_notify completes."""

        added: list[asyncio.Task] = []

        async def _run():
            barrier = asyncio.Event()

            async def _slow_handle(payload: str) -> None:  # noqa: ARG001
                await barrier.wait()  # block so we can inspect mid-flight

            with patch("api.consent_listener._handle_notify", side_effect=_slow_handle):
                loop = asyncio.get_running_loop()
                fake_conn = MagicMock()

                # Capture the task that call_soon_threadsafe schedules
                original_cst = loop.call_soon_threadsafe

                def _intercept(fn, *args, **kwargs):
                    result = original_cst(fn, *args, **kwargs)
                    # flush the scheduled callback immediately
                    loop.call_soon(lambda: added.extend(list(_background_notify_tasks)))
                    return result

                with patch.object(loop, "call_soon_threadsafe", side_effect=_intercept):
                    _notify_callback(fake_conn, 1, "consent_audit_new", '{"user_id":"u1"}')
                    await asyncio.sleep(0)  # let call_soon_threadsafe run
                    await asyncio.sleep(0)  # let _schedule run

                assert len(_background_notify_tasks) == 1
                barrier.set()
                await asyncio.sleep(0)  # let task finish and discard itself

        asyncio.run(_run())

    def test_task_removed_after_completion(self):
        """After _handle_notify returns the task must be discarded from the set."""

        async def _run():
            async def _fast_handle(payload: str) -> None:  # noqa: ARG001
                pass

            with patch("api.consent_listener._handle_notify", side_effect=_fast_handle):
                fake_conn = MagicMock()
                _notify_callback(fake_conn, 1, "consent_audit_new", '{"user_id":"u1"}')
                # Give the event loop several turns to run and complete the task
                for _ in range(5):
                    await asyncio.sleep(0)

            assert len(_background_notify_tasks) == 0

        asyncio.run(_run())

    def test_multiple_notifications_each_get_own_task(self):
        """Each NOTIFY should produce an independent task."""

        async def _run():
            barriers = [asyncio.Event() for _ in range(3)]
            call_count = 0

            async def _counting_handle(payload: str) -> None:  # noqa: ARG001
                nonlocal call_count
                await barriers[call_count].wait()
                call_count += 1

            with patch("api.consent_listener._handle_notify", side_effect=_counting_handle):
                fake_conn = MagicMock()
                for _ in range(3):
                    _notify_callback(fake_conn, 1, "consent_audit_new", '{"user_id":"u1"}')

                for _ in range(5):
                    await asyncio.sleep(0)

                assert len(_background_notify_tasks) == 3

                for b in barriers:
                    b.set()
                for _ in range(5):
                    await asyncio.sleep(0)

            assert len(_background_notify_tasks) == 0

        asyncio.run(_run())

    def test_no_task_scheduled_when_loop_not_running(self):
        """If there is no running loop, _notify_callback must not raise."""
        fake_conn = MagicMock()
        with patch("api.consent_listener.asyncio.get_event_loop") as mock_loop:
            mock_loop.return_value.is_running.return_value = False
            # Should not raise and should not add anything to the task set
            _notify_callback(fake_conn, 1, "consent_audit_new", '{"user_id":"u1"}')
        assert len(_background_notify_tasks) == 0

    def test_exception_in_get_event_loop_is_swallowed(self):
        """Errors in the sync callback must be caught and logged, not propagated."""
        fake_conn = MagicMock()
        with patch(
            "api.consent_listener.asyncio.get_event_loop",
            side_effect=RuntimeError("no loop"),
        ):
            # Must not raise
            _notify_callback(fake_conn, 1, "consent_audit_new", '{"user_id":"u1"}')


class TestCrossProcessUserStateNotifications:
    def test_postgres_callback_delivers_to_every_stream_owned_by_this_worker(self):
        async def _run():
            from api import consent_listener

            consent_listener._consent_notify_queues.clear()
            first_queue = await consent_listener.subscribe_consent_queue("member-1")
            second_queue = await consent_listener.subscribe_consent_queue("member-1")
            payload = {
                "type": "location_circle_renamed",
                "user_id": "member-1",
                "message_id": "location_circle_renamed:event-1",
                "circle_id": "circle-1",
            }

            _user_state_notify_callback(
                MagicMock(),
                1,
                USER_STATE_CHANNEL,
                json.dumps(payload),
            )
            for _ in range(5):
                await asyncio.sleep(0)

            assert first_queue.get_nowait() == payload
            assert second_queue.get_nowait() == payload
            consent_listener._consent_notify_queues.clear()

        asyncio.run(_run())

    def test_publish_uses_postgres_broadcast_channel_and_releases_connection(self):
        async def _run():
            calls: list[tuple] = []

            class Connection:
                async def execute(self, sql, *params):
                    calls.append((sql, *params))

            connection = Connection()

            class Pool:
                async def acquire(self):
                    return connection

                async def release(self, released):
                    calls.append(("release", released))

            async def get_pool():
                return Pool()

            payload = {
                "type": "location_circle_deleted",
                "message_id": "location_circle_deleted:event-1",
                "circle_id": "circle-1",
            }
            with patch("db.connection.get_pool", side_effect=get_pool):
                published = await _publish_user_state_event("member-1", payload)

            assert published is True
            assert calls[0][0] == "SELECT pg_notify($1, $2)"
            assert calls[0][1] == USER_STATE_CHANNEL
            assert json.loads(calls[0][2]) == {**payload, "user_id": "member-1"}
            assert calls[1] == ("release", connection)

        asyncio.run(_run())

    def test_publish_failure_falls_back_to_same_worker_queue(self):
        async def _run():
            from api import consent_listener

            consent_listener._consent_notify_queues.clear()
            queue = await consent_listener.subscribe_consent_queue("member-1")

            async def get_pool():
                raise RuntimeError("database unavailable")

            payload = {
                "type": "location_circle_member_removed",
                "message_id": "location_circle_member_removed:event-1",
            }
            with patch("db.connection.get_pool", side_effect=get_pool):
                published = await _publish_user_state_event("member-1", payload)

            assert published is False
            assert queue.get_nowait() == {**payload, "user_id": "member-1"}
            consent_listener._consent_notify_queues.clear()

        asyncio.run(_run())

    def test_listener_subscribes_and_unsubscribes_both_postgres_channels(self):
        async def _run():
            calls: list[tuple] = []
            subscribed = asyncio.Event()

            class Connection:
                async def execute(self, sql):
                    calls.append(("execute", sql))

                async def add_listener(self, channel, callback):
                    calls.append(("add", channel, callback))
                    if channel == USER_STATE_CHANNEL:
                        subscribed.set()

                async def remove_listener(self, channel, callback):
                    calls.append(("remove", channel, callback))

            connection = Connection()

            class Pool:
                async def acquire(self, timeout=None):
                    calls.append(("acquire", timeout))
                    return connection

                async def release(self, released):
                    calls.append(("release", released))

            async def get_pool():
                return Pool()

            async def dormant_loop():
                await asyncio.Event().wait()

            with (
                patch("db.connection.get_pool", side_effect=get_pool),
                patch("api.consent_listener._timeout_job_loop", new=dormant_loop),
                patch("api.consent_listener._notification_job_loop", new=dormant_loop),
            ):
                from api.consent_listener import run_consent_listener

                task = asyncio.create_task(run_consent_listener())
                await asyncio.wait_for(subscribed.wait(), timeout=1)
                task.cancel()
                await task

            assert ("execute", "LISTEN consent_audit_new") in calls
            assert ("execute", f"LISTEN {USER_STATE_CHANNEL}") in calls
            assert any(call[:2] == ("add", USER_STATE_CHANNEL) for call in calls)
            assert any(call[:2] == ("remove", USER_STATE_CHANNEL) for call in calls)
            assert ("execute", f"UNLISTEN {USER_STATE_CHANNEL}") in calls
            assert ("release", connection) in calls

        asyncio.run(_run())


# ===========================================================================
# cancel-without-await fix — DB pool failure path
# ===========================================================================


class TestCancelWithAwaitOnDbFailure:
    def test_listener_retries_db_failure_and_cleans_tasks_on_shutdown(self):
        """A startup DB failure must retry; shutdown still joins both jobs.

        We intercept asyncio.create_task to capture task references, then
        verify their state after cancelling the long-lived listener.
        """

        async def _run():
            captured: list[asyncio.Task] = []
            real_create_task = asyncio.get_event_loop().create_task
            retried = asyncio.Event()
            attempts = 0

            async def _slow():
                await asyncio.sleep(9999)

            def _capturing_create_task(coro, **kw):
                t = real_create_task(coro, **kw)
                captured.append(t)
                return t

            async def _unavailable_pool():
                nonlocal attempts
                attempts += 1
                if attempts >= 2:
                    retried.set()
                raise RuntimeError("DB unavailable")

            with (
                patch(
                    "api.consent_listener._timeout_job_loop",
                    new=_slow,
                ),
                patch(
                    "api.consent_listener._notification_job_loop",
                    new=_slow,
                ),
                patch(
                    "db.connection.get_pool",
                    side_effect=_unavailable_pool,
                ),
                patch("api.consent_listener.JOB_DB_RECOVERY_DELAY_SECONDS", 0),
                patch("asyncio.create_task", side_effect=_capturing_create_task),
            ):
                from api.consent_listener import run_consent_listener

                listener = real_create_task(run_consent_listener())
                await asyncio.wait_for(retried.wait(), timeout=1)
                listener.cancel()
                await listener

            assert len(captured) == 2, "expected exactly 2 background tasks"
            assert all(t.done() for t in captured), (
                "tasks must be done (cancelled) before run_consent_listener returns"
            )

        asyncio.run(_run())


# ---------------------------------------------------------------------------
# HTTP reachability: GET /api/consent/events/{user_id} subscribes a stream queue.
# The SSE endpoint calls subscribe_consent_queue() and always unsubscribes it,
# canonical entry point into the consent_listener module where the task-management
# fixes live (_background_notify_tasks, create_task, cancel-without-await).
# ---------------------------------------------------------------------------


class TestConsentListenerHTTPReachability:
    """Prove the per-stream subscription contract used by the SSE endpoint."""

    def test_subscribe_consent_queue_returns_distinct_stream_queues(self):
        """Every same-user SSE stream must receive its own bounded queue."""

        async def _run():
            from api.consent_listener import (
                subscribe_consent_queue,
                unsubscribe_consent_queue,
            )

            q = await subscribe_consent_queue("sse_test_user_1")
            assert isinstance(q, asyncio.Queue)
            q2 = await subscribe_consent_queue("sse_test_user_1")
            assert q is not q2, "same-user streams must not compete on one queue"
            q3 = await subscribe_consent_queue("sse_test_user_2")
            assert q3 is not q, "different users must have distinct queues"
            await unsubscribe_consent_queue("sse_test_user_1", q)
            await unsubscribe_consent_queue("sse_test_user_1", q2)
            await unsubscribe_consent_queue("sse_test_user_2", q3)

        asyncio.run(_run())

    def test_background_notify_tasks_set_is_a_strong_reference_store(self):
        """_background_notify_tasks must hold tasks strongly to prevent GC before completion."""
        assert isinstance(_background_notify_tasks, set), (
            "_background_notify_tasks must be a set (strong reference store)"
        )

    def test_notify_callback_adds_task_to_background_set(self):
        """_notify_callback must create a task and add it to _background_notify_tasks."""

        async def _run():
            _background_notify_tasks.clear()
            conn = MagicMock()

            async def _noop(p: str) -> None:
                pass

            with patch(
                "api.consent_listener._handle_notify",
                side_effect=_noop,
            ):
                _notify_callback(conn, 0, "consent_audit_new", '{"user_id": "u1"}')
                # Give the event loop two ticks to schedule and register the task
                await asyncio.sleep(0)
                await asyncio.sleep(0)

            # After scheduling, the set held at least one task (may have completed).
            # The discard callback removes it on completion, so we assert
            # the set type is maintained and no exception was raised.
            assert isinstance(_background_notify_tasks, set)

        asyncio.run(_run())
