"""
WebSocket heartbeat endpoint for real-time consent pulse notifications.

Haptic Vital Sync by Abdul Gaffar — Beast Mode initiative.

Route: GET /ws/heartbeat  (WebSocket upgrade)

The client connects once and receives a JSON "pulse" frame each time any
consent payload is successfully validated elsewhere in the system.  The
channel is intentionally unauthenticated and carries no PII — it is a
presence signal only (you may want to know *that* a consent event
occurred, not *which* one).

For authenticated, per-user consent events use the SSE channel at
GET /api/consent/events/{user_id} instead.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from services.heartbeat import heartbeat_manager

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Heartbeat"])


@router.websocket("/ws/heartbeat")
async def consent_heartbeat(websocket: WebSocket) -> None:
    """
    WebSocket endpoint that streams lightweight consent pulse events.

    Connect once; receive a JSON frame for every successful consent
    validation that occurs while the socket is open.

    Frame schema::

        {
          "event":        "pulse",
          "timestamp_ms": 1716000000000,
          "scope_hint":   "pkm.read",
          "engine":       "Haptic Vital Sync by Abdul Gaffar"
        }

    ``scope_hint`` is a non-PII indication of the consent scope category;
    it may be empty when the scope is unavailable.
    """
    await heartbeat_manager.connect(websocket)
    try:
        await heartbeat_manager.keep_alive(websocket)
    except WebSocketDisconnect:
        logger.debug("heartbeat.ws_disconnect client=%s", websocket.client)
    finally:
        await heartbeat_manager.disconnect(websocket)
