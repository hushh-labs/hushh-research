"""
Tests for services/heartbeat.py — ConsentHeartbeatManager and ConsentPulse.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock

from services.heartbeat import ConsentHeartbeatManager, ConsentPulse, heartbeat_manager

# ---------------------------------------------------------------------------
# Helpers — lightweight mock WebSocket
# ---------------------------------------------------------------------------


def _make_ws(*, fail_on_send: bool = False) -> MagicMock:
    """Return a mock WebSocket with async accept/send_text/receive_text."""
    ws = MagicMock()
    ws.accept = AsyncMock()
    ws.client = ("127.0.0.1", 9000)
    if fail_on_send:
        ws.send_text = AsyncMock(side_effect=RuntimeError("connection lost"))
    else:
        ws.send_text = AsyncMock()
    return ws


# ---------------------------------------------------------------------------
# ConsentPulse
# ---------------------------------------------------------------------------


class TestConsentPulse:
    def test_create_sets_event_field(self):
        pulse = ConsentPulse.create()
        assert pulse.event == "pulse"

    def test_create_sets_timestamp(self):
        pulse = ConsentPulse.create()
        assert pulse.timestamp_ms > 0

    def test_create_with_scope_hint(self):
        pulse = ConsentPulse.create(scope_hint="pkm.read")
        assert pulse.scope_hint == "pkm.read"

    def test_engine_label_present(self):
        pulse = ConsentPulse.create()
        assert "Abdul Gaffar" in pulse.engine
        assert "Haptic Vital Sync" in pulse.engine

    def test_to_json_is_valid_json(self):
        pulse = ConsentPulse.create(scope_hint="vault.owner")
        data = json.loads(pulse.to_json())
        assert data["event"] == "pulse"
        assert data["scope_hint"] == "vault.owner"
        assert "Abdul Gaffar" in data["engine"]

    def test_to_json_is_single_line(self):
        pulse = ConsentPulse.create()
        assert "\n" not in pulse.to_json()


# ---------------------------------------------------------------------------
# ConsentHeartbeatManager — lifecycle
# ---------------------------------------------------------------------------


class TestHeartbeatManagerLifecycle:
    async def test_connect_calls_ws_accept(self):
        manager = ConsentHeartbeatManager()
        ws = _make_ws()
        await manager.connect(ws)
        ws.accept.assert_called_once()

    async def test_connect_increments_count(self):
        manager = ConsentHeartbeatManager()
        assert manager.connection_count == 0
        await manager.connect(_make_ws())
        assert manager.connection_count == 1

    async def test_multiple_connects(self):
        manager = ConsentHeartbeatManager()
        for _ in range(5):
            await manager.connect(_make_ws())
        assert manager.connection_count == 5

    async def test_disconnect_decrements_count(self):
        manager = ConsentHeartbeatManager()
        ws = _make_ws()
        await manager.connect(ws)
        await manager.disconnect(ws)
        assert manager.connection_count == 0

    async def test_disconnect_unknown_ws_is_safe(self):
        manager = ConsentHeartbeatManager()
        ws = _make_ws()
        # Disconnect without ever connecting — should not raise
        await manager.disconnect(ws)
        assert manager.connection_count == 0


# ---------------------------------------------------------------------------
# ConsentHeartbeatManager — broadcasting
# ---------------------------------------------------------------------------


class TestHeartbeatManagerBroadcast:
    async def test_broadcast_returns_recipient_count(self):
        manager = ConsentHeartbeatManager()
        ws1, ws2 = _make_ws(), _make_ws()
        await manager.connect(ws1)
        await manager.connect(ws2)
        sent = await manager.broadcast_pulse()
        assert sent == 2

    async def test_broadcast_calls_send_text_on_each(self):
        manager = ConsentHeartbeatManager()
        ws = _make_ws()
        await manager.connect(ws)
        await manager.broadcast_pulse(scope_hint="attr.financial.*")
        ws.send_text.assert_called_once()
        payload = json.loads(ws.send_text.call_args[0][0])
        assert payload["event"] == "pulse"
        assert payload["scope_hint"] == "attr.financial.*"

    async def test_broadcast_empty_manager_returns_zero(self):
        manager = ConsentHeartbeatManager()
        sent = await manager.broadcast_pulse()
        assert sent == 0

    async def test_dead_connection_pruned_after_broadcast(self):
        manager = ConsentHeartbeatManager()
        good = _make_ws()
        dead = _make_ws(fail_on_send=True)
        await manager.connect(good)
        await manager.connect(dead)
        assert manager.connection_count == 2

        sent = await manager.broadcast_pulse()
        # Only the good connection succeeded
        assert sent == 1
        # Dead connection removed on next check
        assert manager.connection_count == 1

    async def test_broadcast_json_contains_engine_label(self):
        manager = ConsentHeartbeatManager()
        ws = _make_ws()
        await manager.connect(ws)
        await manager.broadcast_pulse()
        payload = json.loads(ws.send_text.call_args[0][0])
        assert "Haptic Vital Sync" in payload["engine"]
        assert "Abdul Gaffar" in payload["engine"]


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------


def test_module_singleton_is_manager_instance():
    assert isinstance(heartbeat_manager, ConsentHeartbeatManager)


async def test_singleton_broadcast_does_not_raise_when_empty():
    # heartbeat_manager is shared — clear any stale state from other tests
    async with heartbeat_manager._lock:
        heartbeat_manager._connections.clear()
    sent = await heartbeat_manager.broadcast_pulse()
    assert sent == 0
