"""Hub broker for the owner-scoped Puppy inference WebSocket.

Two authenticated sockets share one short-lived device-bound capability:
Puppy opens an outbound device socket and a private pod opens a provider socket.
The hub only forwards bounded inference frames between the matching owner and
device. It never interprets prompts, executes tools, or exposes a local model
endpoint. The in-process broker is intentionally single-instance for dev; a
multi-instance deployment must provide an external rendezvous store before it
can be called production-ready.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from hushh_mcp.consent.token import validate_token_with_db
from hushh_mcp.constants import ConsentScope

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/one/puppy", tags=["private-agent"])
_MAX_FRAME_BYTES = 1_048_576
_FRAME_TIMEOUT_SECONDS = 60.0


@dataclass
class _DeviceLink:
    websocket: WebSocket
    pending: dict[str, asyncio.Queue[dict[str, Any]]] = field(default_factory=dict)


class PuppyRelayBroker:
    def __init__(self) -> None:
        self._links: dict[tuple[str, str], _DeviceLink] = {}
        self._lock = asyncio.Lock()

    async def register(self, key: tuple[str, str], websocket: WebSocket) -> _DeviceLink:
        async with self._lock:
            prior = self._links.get(key)
            if prior is not None:
                try:
                    await prior.websocket.close(code=1012, reason="replaced")
                except Exception:  # noqa: BLE001
                    pass
            link = _DeviceLink(websocket)
            self._links[key] = link
            return link

    async def remove(self, key: tuple[str, str], link: _DeviceLink) -> None:
        async with self._lock:
            if self._links.get(key) is link:
                self._links.pop(key, None)

    async def get(self, key: tuple[str, str]) -> _DeviceLink | None:
        async with self._lock:
            return self._links.get(key)


BROKER = PuppyRelayBroker()


def _bearer(websocket: WebSocket) -> str:
    raw = str(websocket.headers.get("authorization") or "").strip()
    scheme, _, token = raw.partition(" ")
    return token.strip() if scheme.lower() == "bearer" else ""


async def _frame(websocket: WebSocket) -> dict[str, Any]:
    value = await websocket.receive_text()
    if len(value.encode("utf-8")) > _MAX_FRAME_BYTES:
        raise ValueError("frame too large")
    decoded = json.loads(value)
    if not isinstance(decoded, dict):
        raise ValueError("frame must be an object")
    return decoded


async def _admit(websocket: WebSocket) -> tuple[str, str, str] | None:
    token = _bearer(websocket)
    if not token or len(token) > 4096:
        return None
    valid, _reason, claims = await validate_token_with_db(
        token, expected_scope=ConsentScope.CAP_PUPPY_INFERENCE.value
    )
    if not valid or claims is None:
        return None
    agent = str(claims.agent_id)
    if not agent.startswith("device:") or not agent.removeprefix("device:"):
        return None
    return str(claims.user_id), agent.removeprefix("device:"), token


async def _device_loop(websocket: WebSocket, key: tuple[str, str], link: _DeviceLink) -> None:
    try:
        await websocket.send_json({"type": "relay.ready", "role": "device"})
        while True:
            frame = await _frame(websocket)
            kind = str(frame.get("type") or "")
            request_id = str(frame.get("requestId") or "")
            if kind in {"relay.heartbeat", "relay.status"}:
                continue
            if not request_id or kind not in {
                "inference.delta",
                "inference.result",
                "inference.done",
                "inference.error",
            }:
                raise ValueError("unsupported Puppy device frame")
            queue = link.pending.get(request_id)
            if queue is not None:
                await queue.put(frame)
    except (WebSocketDisconnect, ValueError, json.JSONDecodeError):
        return
    finally:
        await BROKER.remove(key, link)


async def _provider_loop(websocket: WebSocket, key: tuple[str, str], token: str) -> None:
    link = await BROKER.get(key)
    if link is None:
        await websocket.send_json(
            {"type": "relay.error", "code": "PUPPY_OFFLINE", "message": "linked Puppy is offline"}
        )
        return
    await websocket.send_json({"type": "relay.ready", "role": "pod"})
    try:
        while True:
            frame = await _frame(websocket)
            valid, _reason, _claims = await validate_token_with_db(
                token, expected_scope=ConsentScope.CAP_PUPPY_INFERENCE.value
            )
            if not valid:
                await websocket.send_json(
                    {
                        "type": "relay.error",
                        "code": "PUPPY_REVOKED",
                        "message": "inference grant is no longer active",
                    }
                )
                return
            if str(frame.get("type") or "") != "inference.request":
                raise ValueError("unsupported Puppy provider frame")
            request_id = str(frame.get("requestId") or "")
            device_id = str(frame.get("deviceId") or "")
            if not request_id or device_id != key[1]:
                raise ValueError("Puppy request binding mismatch")
            queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
            link.pending[request_id] = queue
            try:
                await link.websocket.send_json(frame)
                while True:
                    try:
                        async with asyncio.timeout(_FRAME_TIMEOUT_SECONDS):
                            response = await queue.get()
                    except asyncio.TimeoutError:
                        await websocket.send_json(
                            {
                                "type": "inference.error",
                                "requestId": request_id,
                                "code": "PUPPY_TIMEOUT",
                            }
                        )
                        break
                    valid, _reason, _claims = await validate_token_with_db(
                        token, expected_scope=ConsentScope.CAP_PUPPY_INFERENCE.value
                    )
                    if not valid:
                        await websocket.send_json(
                            {
                                "type": "inference.error",
                                "requestId": request_id,
                                "code": "PUPPY_REVOKED",
                            }
                        )
                        break
                    await websocket.send_json(response)
                    if str(response.get("type") or "") in {
                        "inference.done",
                        "inference.result",
                        "inference.error",
                    }:
                        break
            finally:
                link.pending.pop(request_id, None)
    except (WebSocketDisconnect, ValueError, json.JSONDecodeError):
        return


@router.websocket("/relay")
async def puppy_relay(websocket: WebSocket) -> None:
    admitted = await _admit(websocket)
    if admitted is None:
        await websocket.close(code=1008, reason="Puppy inference admission refused")
        return
    user_id, device_id, token = admitted
    await websocket.accept()
    try:
        hello = await _frame(websocket)
        if hello.get("type") != "relay.hello" or str(hello.get("deviceId") or "") != device_id:
            await websocket.close(code=1008, reason="Puppy relay binding refused")
            return
        role = str(hello.get("role") or "")
        key = (user_id, device_id)
        if role == "device":
            link = await BROKER.register(key, websocket)
            await _device_loop(websocket, key, link)
        elif role == "pod":
            await _provider_loop(websocket, key, token)
        else:
            await websocket.close(code=1008, reason="Puppy relay role refused")
    except (WebSocketDisconnect, ValueError, json.JSONDecodeError):
        return
    except Exception:  # noqa: BLE001 - no provider/device data in logs
        logger.warning("puppy_relay.connection_failed", exc_info=True)
        try:
            await websocket.close(code=1011, reason="Puppy relay unavailable")
        except Exception:  # noqa: BLE001
            pass
