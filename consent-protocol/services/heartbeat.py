"""
WebSocket connection manager for the Consent Heartbeat service.

Haptic Vital Sync by Abdul Gaffar — Beast Mode initiative.

Broadcasts a lightweight "pulse" to every connected WebSocket client
whenever a ConsentApprovalPayload is successfully validated. Enables
real-time frontend indicators (badge updates, animations, haptic
feedback on supported devices) without polling.

Architecture note
-----------------
This module is intentionally transport-only: it manages connections and
serialises the pulse payload, but takes no position on *why* a pulse was
triggered. Callers (route handlers, background listeners) are responsible
for invoking ``broadcast_pulse()`` at the right moment.

The existing SSE channel (``api/routes/sse.py``) remains the canonical
consent-event stream for authenticated per-user subscriptions. This
heartbeat channel is a lightweight, unauthenticated aggregate pulse
suited for dashboard widgets and haptic feedback loops.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import asdict, dataclass

from fastapi import WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)

_ENGINE_LABEL = "Haptic Vital Sync by Abdul Gaffar"


# ---------------------------------------------------------------------------
# Pulse payload
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ConsentPulse:
    """
    Lightweight event broadcast to every connected heartbeat client.

    Fields are deliberately minimal to avoid leaking PII over an
    unauthenticated channel.
    """

    event: str = "pulse"
    timestamp_ms: int = 0
    scope_hint: str = ""
    engine: str = _ENGINE_LABEL

    def to_json(self) -> str:
        return json.dumps(asdict(self), separators=(",", ":"))

    @classmethod
    def create(cls, *, scope_hint: str = "") -> "ConsentPulse":
        return cls(
            event="pulse",
            timestamp_ms=int(time.time() * 1000),
            scope_hint=scope_hint,
            engine=_ENGINE_LABEL,
        )


# ---------------------------------------------------------------------------
# Connection manager
# ---------------------------------------------------------------------------


class ConsentHeartbeatManager:
    """
    Tracks active WebSocket connections and broadcasts consent pulse events.

    Thread/task safety: all mutations to ``_connections`` are guarded by
    an asyncio.Lock so concurrent connect/disconnect calls cannot race.

    Usage::

        manager = ConsentHeartbeatManager()

        # In the WebSocket endpoint:
        await manager.connect(websocket)
        try:
            await manager.keep_alive(websocket)
        finally:
            await manager.disconnect(websocket)

        # When a consent payload is approved:
        await manager.broadcast_pulse(scope_hint="pkm.read")
    """

    def __init__(self) -> None:
        self._connections: set[WebSocket] = set()
        self._lock: asyncio.Lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def connect(self, websocket: WebSocket) -> None:
        """Accept the WebSocket handshake and register the connection."""
        await websocket.accept()
        async with self._lock:
            self._connections.add(websocket)
        logger.info(
            "heartbeat.connected total=%d engine=%s",
            len(self._connections),
            _ENGINE_LABEL,
        )

    async def disconnect(self, websocket: WebSocket) -> None:
        """Remove a connection (safe to call even if not registered)."""
        async with self._lock:
            self._connections.discard(websocket)
        logger.info("heartbeat.disconnected total=%d", len(self._connections))

    async def keep_alive(self, websocket: WebSocket) -> None:
        """
        Block until the client disconnects, handling ping/pong frames.

        Call this inside the WebSocket route handler to hold the connection
        open. The manager will raise ``WebSocketDisconnect`` when the client
        closes the socket — the caller should catch it and call
        ``disconnect()``.
        """
        try:
            while True:
                # Wait for any message (ping-pong or close frame).
                # We do not process incoming messages; the channel is
                # server→client only.
                await websocket.receive_text()
        except WebSocketDisconnect:
            raise

    # ------------------------------------------------------------------
    # Broadcasting
    # ------------------------------------------------------------------

    async def broadcast_pulse(self, *, scope_hint: str = "") -> int:
        """
        Broadcast a pulse to all connected clients.

        Returns the number of clients that received the message.
        Disconnected clients are silently pruned.
        """
        pulse = ConsentPulse.create(scope_hint=scope_hint)
        payload = pulse.to_json()

        async with self._lock:
            active = list(self._connections)

        sent = 0
        dead: list[WebSocket] = []

        for ws in active:
            try:
                await ws.send_text(payload)
                sent += 1
            except Exception:
                dead.append(ws)

        if dead:
            async with self._lock:
                for ws in dead:
                    self._connections.discard(ws)
            logger.debug("heartbeat.pruned_dead count=%d", len(dead))

        logger.info(
            "heartbeat.pulse_sent recipients=%d scope=%s",
            sent,
            scope_hint or "(none)",
        )
        return sent

    @property
    def connection_count(self) -> int:
        return len(self._connections)


# ---------------------------------------------------------------------------
# Module-level singleton used by the WebSocket route and consent handlers
# ---------------------------------------------------------------------------

heartbeat_manager = ConsentHeartbeatManager()
