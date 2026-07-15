"""Tests for SSE consent queue cleanup on disconnect (memory leak fix).

_consent_notify_queues in api/consent_listener.py accumulated one entry per
unique user_id every time an SSE client connected and never freed them. The
fix adds:

  1. remove_consent_queue(user_id) in api/consent_listener.py
  2. A finally block in consent_event_generator() that calls it after the
     generator exits (disconnect, cancellation, or exception).

Canonical attach:
  api/routes/sse.py              -- consent_event_generator, the live SSE path
  api/consent_listener.py        -- _consent_notify_queues, get/remove helpers
"""

from __future__ import annotations

import asyncio
import sys
import types
from types import ModuleType
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _reset_queues() -> None:
    """Clear the module-level dicts between tests to prevent cross-test bleed."""
    from api import consent_listener

    consent_listener._consent_notify_queues.clear()
    consent_listener._consent_notify_queue_refcounts.clear()


def _make_fake_consent_db_module() -> ModuleType:
    """Return a fake hushh_mcp.services.consent_db module with a stub service."""
    mod = types.ModuleType("hushh_mcp.services.consent_db")
    svc = MagicMock()
    svc.get_recent_consent_events = AsyncMock(return_value=[])
    mod.ConsentDBService = MagicMock(return_value=svc)
    return mod


def _make_failing_consent_db_module() -> ModuleType:
    """Return a fake module whose ConsentDBService raises on get_recent_consent_events."""
    mod = types.ModuleType("hushh_mcp.services.consent_db")
    svc = MagicMock()
    svc.get_recent_consent_events = AsyncMock(side_effect=RuntimeError("db exploded"))
    mod.ConsentDBService = MagicMock(return_value=svc)
    return mod


# ---------------------------------------------------------------------------
# Unit tests for remove_consent_queue
# ---------------------------------------------------------------------------


class TestRemoveConsentQueue:
    """remove_consent_queue removes the entry and is safe when absent."""

    def setup_method(self):
        _reset_queues()

    def test_removes_existing_entry(self):
        from api.consent_listener import (
            _consent_notify_queues,
            get_consent_queue,
            remove_consent_queue,
        )

        get_consent_queue("user-1")
        assert "user-1" in _consent_notify_queues

        remove_consent_queue("user-1")
        assert "user-1" not in _consent_notify_queues

    def test_noop_when_user_not_present(self):
        from api.consent_listener import remove_consent_queue

        # Must not raise KeyError or any other exception.
        remove_consent_queue("nonexistent-user")

    def test_does_not_remove_other_users(self):
        from api.consent_listener import (
            _consent_notify_queues,
            get_consent_queue,
            remove_consent_queue,
        )

        get_consent_queue("user-a")
        get_consent_queue("user-b")
        remove_consent_queue("user-a")

        assert "user-a" not in _consent_notify_queues
        assert "user-b" in _consent_notify_queues

    def test_queue_count_decrements(self):
        from api.consent_listener import (
            _consent_notify_queues,
            get_consent_queue,
            remove_consent_queue,
        )

        for uid in ("u1", "u2", "u3"):
            get_consent_queue(uid)

        assert len(_consent_notify_queues) == 3
        remove_consent_queue("u2")
        assert len(_consent_notify_queues) == 2

    def test_concurrent_connections_for_same_user_share_queue_until_last_disconnects(self):
        """A user can have multiple concurrent SSE connections (multiple tabs,
        web + mobile). They share one queue. Disconnecting one connection must
        not tear down the queue out from under the other still-open one.
        """
        from api.consent_listener import (
            _consent_notify_queues,
            get_consent_queue,
            remove_consent_queue,
        )

        first = get_consent_queue("user-multi")
        second = get_consent_queue("user-multi")
        assert first is second

        remove_consent_queue("user-multi")
        assert "user-multi" in _consent_notify_queues, (
            "queue was removed while a second connection for the same user "
            "is still open"
        )

        remove_consent_queue("user-multi")
        assert "user-multi" not in _consent_notify_queues


# ---------------------------------------------------------------------------
# Source-structure test: finally block is present
# ---------------------------------------------------------------------------


class TestGeneratorHasFinallyBlock:
    """Structural test: consent_event_generator contains the cleanup finally block."""

    def test_remove_consent_queue_called_in_finally(self):
        import ast
        import inspect

        from api.routes.sse import consent_event_generator

        src = inspect.getsource(consent_event_generator)
        tree = ast.parse(src)

        # Walk the AST and find Try nodes that have a finally body containing
        # a call to remove_consent_queue.
        found = False
        for node in ast.walk(tree):
            if not isinstance(node, ast.Try):
                continue
            for stmt in node.finalbody:
                # Look for import-then-call or direct call to remove_consent_queue
                src_segment = ast.unparse(stmt)
                if "remove_consent_queue" in src_segment:
                    found = True
                    break
            if found:
                break

        assert found, (
            "consent_event_generator must contain a finally block that calls "
            "remove_consent_queue(user_id) to prevent _consent_notify_queues memory leak"
        )


# ---------------------------------------------------------------------------
# Integration tests: generator cleans up in every exit path
# ---------------------------------------------------------------------------


class TestGeneratorCleansUpOnExit:
    """consent_event_generator removes the queue in every exit path."""

    def setup_method(self):
        _reset_queues()

    @pytest.mark.asyncio
    async def test_queue_removed_after_normal_disconnect(self):
        """Queue entry is gone after the generator exits via is_disconnected."""
        from api import consent_listener
        from api.routes.sse import consent_event_generator

        call_count = {"n": 0}

        async def is_disconnected():
            call_count["n"] += 1
            # Disconnect immediately on the first poll.
            return True

        request = MagicMock()
        request.is_disconnected = is_disconnected

        fake_db_mod = _make_fake_consent_db_module()
        with patch.dict(sys.modules, {"hushh_mcp.services.consent_db": fake_db_mod}):
            gen = consent_event_generator("disconnect-user", request)
            async for _ in gen:
                pass

        assert "disconnect-user" not in consent_listener._consent_notify_queues

    @pytest.mark.asyncio
    async def test_queue_removed_after_exception(self):
        """Queue entry is removed even when the DB service raises."""
        from api import consent_listener
        from api.routes.sse import consent_event_generator

        request = MagicMock()
        request.is_disconnected = AsyncMock(return_value=False)

        failing_mod = _make_failing_consent_db_module()
        with patch.dict(sys.modules, {"hushh_mcp.services.consent_db": failing_mod}):
            gen = consent_event_generator("exc-user", request)
            with pytest.raises(RuntimeError, match="db exploded"):
                async for _ in gen:
                    pass

        assert "exc-user" not in consent_listener._consent_notify_queues

    @pytest.mark.asyncio
    async def test_queue_removed_after_cancellation(self):
        """Queue entry is removed even when the generator task is cancelled."""
        from api import consent_listener
        from api.routes.sse import consent_event_generator

        request = MagicMock()
        # Never disconnect naturally so the while-loop blocks on queue.get().
        request.is_disconnected = AsyncMock(return_value=False)

        fake_db_mod = _make_fake_consent_db_module()

        async def run_gen():
            with patch.dict(sys.modules, {"hushh_mcp.services.consent_db": fake_db_mod}):
                gen = consent_event_generator("cancel-user", request)
                async for _ in gen:
                    pass

        task = asyncio.create_task(run_gen())
        # Let the generator reach the asyncio.wait_for(...) inside the while loop.
        await asyncio.sleep(0.05)
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass

        # The finally block must have run by now.
        assert "cancel-user" not in consent_listener._consent_notify_queues
