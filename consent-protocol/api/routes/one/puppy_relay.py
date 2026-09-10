"""Hub broker for the owner-scoped Puppy inference WebSocket.

Two authenticated sockets share one short-lived device-bound capability:
Puppy opens an outbound device socket and a private pod opens a provider socket.
The hub only forwards bounded inference frames between the matching owner and
device. It never interprets prompts, executes tools, or exposes a local model
endpoint. The owner-pod deployment is single-instance and does not require a
shared broker. A dedicated rendezvous URL is an explicit compatibility option for
a deliberately shared hub topology; the rate-limit store is never reused for
relay traffic.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
from redis import asyncio as redis_asyncio

from api.middleware import require_firebase_auth
from hushh_mcp.consent.token import validate_token_with_db
from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.trusted_device_service import TrustedDeviceService

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/one/puppy", tags=["private-agent"])
_MAX_FRAME_BYTES = 1_048_576
_FRAME_TIMEOUT_SECONDS = 120.0
_MAX_PENDING_FRAMES = 32
_MAX_REQUEST_ID_LENGTH = 128
_RENDEZVOUS_TTL_SECONDS = 45
_RENDEZVOUS_BUSY_TTL_SECONDS = 130
_ROLE_HEADER = "x-hussh-relay-role"
_ENV_HEADER = "x-hussh-deploy-env"
_MAX_MODEL_ID_LENGTH = 128
# The capability names a device may declare, in the Puppy One harness vocabulary
# (Hermes ``hussh_one_routing/profile.py``). Bool values only; anything else is
# dropped rather than forwarded to the pod as if the device had said it.
_DEVICE_CAPABILITY_NAMES: frozenset[str] = frozenset({"tool_calling", "json_schema", "streaming"})


def _declared_model(value: Any) -> str:
    """A device-declared model id, or empty when it is not one we may repeat.

    The id is forwarded to the pod and shown to the owner, so it must not be able
    to carry an endpoint, a path or free text: no scheme, no leading slash, no
    whitespace, bounded length. Anything else reads as "not declared".
    """
    if not isinstance(value, str):
        return ""
    text = value.strip()
    if not text or len(text) > _MAX_MODEL_ID_LENGTH:
        return ""
    if "://" in text or text.startswith("/") or any(char.isspace() for char in text):
        return ""
    return text


def _declared_capabilities(value: Any) -> dict[str, bool]:
    """Allowlisted capability names with boolean values; everything else dropped."""
    if not isinstance(value, dict):
        return {}
    return {
        str(name): flag
        for name, flag in value.items()
        if name in _DEVICE_CAPABILITY_NAMES and isinstance(flag, bool)
    }


@dataclass
class _DeviceLink:
    websocket: WebSocket
    generation: int
    pending: dict[str, asyncio.Queue[dict[str, Any]]] = field(default_factory=dict)
    busy_request_id: str | None = None
    last_seen_monotonic: float = field(default_factory=time.monotonic)
    status: str = "ready"
    # What the device said about itself at admission, already validated. Empty
    # means the device declared nothing, and the pod is told nothing.
    model: str = ""
    capabilities: dict[str, bool] = field(default_factory=dict)
    probe_mode: str = ""

    def declaration(self) -> dict[str, Any] | None:
        """The ``device`` block for the pod's admission frame, or None if silent."""
        if not self.model and not self.capabilities:
            return None
        block: dict[str, Any] = {"model": self.model, "capabilities": dict(self.capabilities)}
        if self.probe_mode:
            block["probe_mode"] = self.probe_mode
        return block


class PuppyRelayBroker:
    def __init__(self) -> None:
        self._links: dict[tuple[str, str], _DeviceLink] = {}
        self._lock = asyncio.Lock()
        self._generation = 0
        self._instance_id = uuid4().hex
        self._redis: redis_asyncio.Redis | None = None

    @staticmethod
    def _rendezvous_url() -> str:
        # Do not couple inference transport to the rate limiter. An owner pod is
        # single-instance and local fencing is sufficient; a shared hub must opt
        # into a dedicated rendezvous store with its own cost and retention policy.
        return str(os.getenv("PUPPY_RELAY_RENDEZVOUS_URL") or "").strip()

    def _client(self) -> redis_asyncio.Redis | None:
        if self._redis is not None:
            return self._redis
        url = self._rendezvous_url()
        if not url:
            return None
        self._redis = redis_asyncio.Redis.from_url(
            url,
            socket_timeout=0.5,
            socket_connect_timeout=0.5,
            decode_responses=True,
        )
        return self._redis

    def rendezvous_enabled(self) -> bool:
        return self._client() is not None

    @staticmethod
    def _key(key: tuple[str, str]) -> str:
        digest = hashlib.sha256("\x00".join(key).encode("utf-8")).hexdigest()
        return f"hushh:puppy-relay:v1:{digest}"

    async def _redis_set_presence(self, key: tuple[str, str]) -> None:
        client = self._client()
        if client is None:
            return
        try:
            await client.set(
                f"{self._key(key)}:presence", self._instance_id, ex=_RENDEZVOUS_TTL_SECONDS
            )
        except Exception:  # noqa: BLE001 - rendezvous is a fail-closed transport aid
            logger.warning("puppy_relay.rendezvous_write_failed")

    async def touch(self, key: tuple[str, str]) -> None:
        await self._redis_set_presence(key)

    async def available(self, key: tuple[str, str]) -> bool:
        local = await self.get(key)
        if local is not None:
            return True
        client = self._client()
        if client is None:
            return False
        try:
            return bool(await client.exists(f"{self._key(key)}:presence"))
        except Exception:  # noqa: BLE001 - unavailable is the safe answer
            return False

    async def publish(self, key: tuple[str, str], direction: str, frame: dict[str, Any]) -> bool:
        client = self._client()
        if client is None:
            return False
        try:
            await client.publish(
                f"{self._key(key)}:{direction}", json.dumps(frame, separators=(",", ":"))
            )
            return True
        except Exception:  # noqa: BLE001 - never log frame contents
            logger.warning("puppy_relay.rendezvous_publish_failed")
            return False

    async def subscribe(self, key: tuple[str, str], direction: str) -> Any | None:
        client = self._client()
        if client is None:
            return None
        try:
            pubsub = client.pubsub()
            await pubsub.subscribe(f"{self._key(key)}:{direction}")
            return pubsub
        except Exception:  # noqa: BLE001 - caller remains local-only if unavailable
            logger.warning("puppy_relay.rendezvous_subscribe_failed")
            return None

    async def release_presence(self, key: tuple[str, str]) -> None:
        client = self._client()
        if client is None:
            return
        name = f"{self._key(key)}:presence"
        try:
            owner = await client.get(name)
            if owner == self._instance_id:
                await client.delete(name)
        except Exception:  # noqa: BLE001 - expiry remains the fallback
            logger.warning("puppy_relay.rendezvous_release_failed")

    async def acquire_busy(self, key: tuple[str, str], request_id: str) -> bool:
        client = self._client()
        if client is None:
            return False
        try:
            return bool(
                await client.set(
                    f"{self._key(key)}:busy",
                    request_id,
                    ex=_RENDEZVOUS_BUSY_TTL_SECONDS,
                    nx=True,
                )
            )
        except Exception:  # noqa: BLE001 - no distributed admission on failed rendezvous
            logger.warning("puppy_relay.rendezvous_busy_failed")
            return False

    async def release_busy(self, key: tuple[str, str], request_id: str) -> None:
        client = self._client()
        if client is None:
            return
        name = f"{self._key(key)}:busy"
        try:
            if await client.get(name) == request_id:
                await client.delete(name)
        except Exception:  # noqa: BLE001 - expiry remains the fallback
            logger.warning("puppy_relay.rendezvous_busy_release_failed")

    async def register(
        self,
        key: tuple[str, str],
        websocket: WebSocket,
        *,
        model: str = "",
        capabilities: dict[str, bool] | None = None,
        probe_mode: str = "",
    ) -> _DeviceLink:
        async with self._lock:
            prior = self._links.get(key)
            if prior is not None:
                try:
                    await prior.websocket.close(code=1012, reason="replaced")
                except Exception:  # noqa: BLE001
                    pass
            self._generation += 1
            link = _DeviceLink(
                websocket,
                generation=self._generation,
                model=_declared_model(model),
                capabilities=_declared_capabilities(capabilities),
                probe_mode=_declared_model(probe_mode),
            )
            self._links[key] = link
        await self._redis_set_presence(key)
        return link

    async def remove(self, key: tuple[str, str], link: _DeviceLink) -> None:
        removed = False
        async with self._lock:
            if self._links.get(key) is link:
                self._links.pop(key, None)
                removed = True
            for request_id, queue in tuple(link.pending.items()):
                try:
                    queue.put_nowait(
                        {
                            "type": "inference.error",
                            "requestId": request_id,
                            "code": "PUPPY_OFFLINE",
                        }
                    )
                except asyncio.QueueFull:
                    pass
        if removed:
            await self.release_presence(key)
            await self.publish(key, "device-to-pod", {"type": "relay.device_offline"})

    async def get(self, key: tuple[str, str]) -> _DeviceLink | None:
        async with self._lock:
            return self._links.get(key)

    async def status(self, key: tuple[str, str]) -> dict[str, Any]:
        link = await self.get(key)
        if link is not None:
            busy = bool(link.busy_request_id)
            client = self._client()
            if client is not None:
                try:
                    busy = busy or bool(await client.exists(f"{self._key(key)}:busy"))
                except Exception:  # noqa: BLE001
                    busy = True
            return {
                "connected": True,
                "state": "busy" if busy else link.status,
                "busy": busy,
                "generation": link.generation,
                "last_seen_age_seconds": round(
                    max(0.0, time.monotonic() - link.last_seen_monotonic), 3
                ),
                # Declared by the device at admission, validated, never inferred.
                "model": link.model,
                "capabilities": dict(link.capabilities),
                "probe_mode": link.probe_mode,
            }
        client = self._client()
        busy = False
        if client is not None:
            try:
                busy = bool(await client.exists(f"{self._key(key)}:busy"))
            except Exception:  # noqa: BLE001
                busy = False
        if await self.available(key):
            return {
                "connected": True,
                "state": "busy" if busy else "ready",
                "busy": busy,
                "generation": None,
            }
        return {
            "connected": False,
            "state": "offline",
            "busy": False,
            "generation": None,
        }


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


def _header(websocket: WebSocket, name: str) -> str:
    return str(websocket.headers.get(name) or "").strip().lower()


def _expected_environment() -> str:
    return str(os.getenv("HUSHH_DEPLOY_ENV") or os.getenv("ENVIRONMENT") or "").strip().lower()


def _require_transport_binding(websocket: WebSocket, role: str) -> bool:
    """Require the transport declaration to agree with the authenticated socket.

    The grant remains the authority. These headers prevent a valid device-bound
    grant from accidentally being used on the wrong transport role or environment;
    they are deliberately not accepted as a replacement for token validation.
    """
    if _header(websocket, _ROLE_HEADER) != role:
        return False
    expected = _expected_environment()
    return not expected or _header(websocket, _ENV_HEADER) == expected


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


async def _close_pubsub(pubsub: Any | None) -> None:
    if pubsub is None:
        return
    try:
        await pubsub.unsubscribe()
        await pubsub.close()
    except Exception:  # noqa: BLE001 - socket teardown is best effort
        pass


async def _redis_frames(pubsub: Any, queue: asyncio.Queue[dict[str, Any]]) -> None:
    """Decode only bounded JSON frames from the cross-instance rendezvous."""
    while True:
        message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
        if not message:
            continue
        raw = message.get("data")
        try:
            frame = json.loads(raw) if isinstance(raw, str) else None
        except (TypeError, ValueError):
            continue
        if not isinstance(frame, dict):
            continue
        encoded = json.dumps(frame, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > _MAX_FRAME_BYTES:
            continue
        try:
            queue.put_nowait(frame)
        except asyncio.QueueFull:
            raise ValueError("Puppy response buffer is full")


async def _device_loop(websocket: WebSocket, key: tuple[str, str], link: _DeviceLink) -> None:
    remote_pubsub = await BROKER.subscribe(key, "pod-to-device")
    remote_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=_MAX_PENDING_FRAMES)
    remote_task = (
        asyncio.create_task(_redis_frames(remote_pubsub, remote_queue)) if remote_pubsub else None
    )
    try:
        await websocket.send_json({"type": "relay.ready", "role": "device"})
        while True:
            receive_task = asyncio.create_task(_frame(websocket))
            tasks = {receive_task}
            if remote_task is not None:
                tasks.add(asyncio.create_task(remote_queue.get()))
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            frame = next(iter(done)).result()
            link.last_seen_monotonic = time.monotonic()
            await BROKER.touch(key)
            kind = str(frame.get("type") or "")
            request_id = str(frame.get("requestId") or "")
            if kind == "inference.request":
                await websocket.send_json(frame)
                continue
            if kind in {"relay.heartbeat", "relay.status"}:
                status = str(frame.get("status") or "ready").strip().lower()
                link.status = status if status in {"ready", "busy", "offline"} else "ready"
                continue
            if (
                not request_id
                or len(request_id) > _MAX_REQUEST_ID_LENGTH
                or kind
                not in {
                    "inference.delta",
                    "inference.result",
                    "inference.done",
                    "inference.error",
                }
            ):
                raise ValueError("unsupported Puppy device frame")
            queue = link.pending.get(request_id)
            if queue is not None:
                try:
                    queue.put_nowait(frame)
                except asyncio.QueueFull as exc:
                    raise ValueError("Puppy response buffer is full") from exc
            else:
                await BROKER.publish(key, "device-to-pod", frame)
    except (WebSocketDisconnect, ValueError, json.JSONDecodeError):
        return
    finally:
        if remote_task is not None:
            remote_task.cancel()
        await _close_pubsub(remote_pubsub)
        await BROKER.remove(key, link)


async def _provider_loop(websocket: WebSocket, key: tuple[str, str], token: str) -> None:
    link = await BROKER.get(key)
    distributed = link is None and await BROKER.available(key)
    rendezvous_enabled = BROKER.rendezvous_enabled()
    if link is None and not distributed:
        await websocket.send_json(
            {"type": "relay.error", "code": "PUPPY_OFFLINE", "message": "linked Puppy is offline"}
        )
        return
    remote_pubsub = await BROKER.subscribe(key, "device-to-pod") if distributed else None
    if distributed and remote_pubsub is None:
        await websocket.send_json(
            {
                "type": "relay.error",
                "code": "PUPPY_OFFLINE",
                "message": "relay rendezvous unavailable",
            }
        )
        return
    pending_queues: dict[str, asyncio.Queue[dict[str, Any]]] = {}
    remote_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=_MAX_PENDING_FRAMES)
    remote_task = (
        asyncio.create_task(_redis_frames(remote_pubsub, remote_queue)) if remote_pubsub else None
    )
    ready: dict[str, Any] = {"type": "relay.ready", "role": "pod"}
    declaration = link.declaration() if link is not None else None
    if declaration is not None:
        # The pod refuses before dispatch on a declared gap; a silent device
        # keeps the frame exactly as before and stays the only judge.
        ready["device"] = declaration
    await websocket.send_json(ready)
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
            if not request_id or len(request_id) > _MAX_REQUEST_ID_LENGTH or device_id != key[1]:
                raise ValueError("Puppy request binding mismatch")
            local_busy = link is not None and link.busy_request_id is not None
            rendezvous_busy = (
                not await BROKER.acquire_busy(key, request_id) if rendezvous_enabled else False
            )
            busy = local_busy or rendezvous_busy or (link is None and not rendezvous_enabled)
            if busy:
                await websocket.send_json(
                    {
                        "type": "inference.error",
                        "requestId": request_id,
                        "code": "PUPPY_BUSY",
                    }
                )
                continue
            if request_id in pending_queues:
                raise ValueError("duplicate Puppy request")
            queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=_MAX_PENDING_FRAMES)
            pending_queues[request_id] = queue
            if link is not None:
                link.pending[request_id] = queue
                link.busy_request_id = request_id
            try:
                if link is not None:
                    await link.websocket.send_json(frame)
                elif not await BROKER.publish(key, "pod-to-device", frame):
                    await websocket.send_json(
                        {
                            "type": "inference.error",
                            "requestId": request_id,
                            "code": "PUPPY_OFFLINE",
                        }
                    )
                    continue
                while True:
                    if remote_task is not None:
                        remote_incoming = asyncio.create_task(remote_queue.get())
                        response_task = asyncio.create_task(queue.get())
                        done, waiters = await asyncio.wait(
                            {response_task, remote_incoming}, return_when=asyncio.FIRST_COMPLETED
                        )
                        for waiter in waiters:
                            waiter.cancel()
                        response = next(iter(done)).result()
                        if (
                            response.get("requestId") == request_id
                            and response.get("type") != "relay.device_offline"
                        ):
                            try:
                                queue.put_nowait(response)
                            except asyncio.QueueFull as exc:
                                raise ValueError("Puppy response buffer is full") from exc
                            continue
                        if response.get("type") == "relay.device_offline":
                            response = {
                                "type": "inference.error",
                                "requestId": request_id,
                                "code": "PUPPY_OFFLINE",
                            }
                        else:
                            continue
                    else:
                        response = None
                    try:
                        if response is None:
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
                pending_queues.pop(request_id, None)
                if link is not None:
                    link.pending.pop(request_id, None)
                    if link.busy_request_id == request_id:
                        link.busy_request_id = None
                if rendezvous_enabled:
                    await BROKER.release_busy(key, request_id)
    except (WebSocketDisconnect, ValueError, json.JSONDecodeError):
        return
    finally:
        if remote_task is not None:
            remote_task.cancel()
        await _close_pubsub(remote_pubsub)


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
        role = str(hello.get("role") or "").strip().lower()
        if role not in {"device", "pod"} or not _require_transport_binding(websocket, role):
            await websocket.close(code=1008, reason="Puppy relay role binding refused")
            return
        key = (user_id, device_id)
        if role == "device":
            link = await BROKER.register(
                key,
                websocket,
                model=hello.get("model"),
                capabilities=hello.get("capabilities"),
                probe_mode=hello.get("probe_mode"),
            )
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


@router.get("/status/{device_id}", tags=["private-agent"])
async def puppy_status(
    device_id: str, firebase_uid: str = Depends(require_firebase_auth)
) -> dict[str, Any]:
    """Return truthful owner-scoped Puppy readiness without exposing credentials."""
    try:
        service = TrustedDeviceService()
        device = service.device_status(user_id=firebase_uid, device_id=device_id)
    except Exception:  # noqa: BLE001 - status must not expose database/provider details
        logger.debug("puppy_status.unavailable", exc_info=True)
        return {
            "device_id": device_id,
            "state": "unavailable",
            "linked": False,
            "inference_ready": False,
            "execution_target": "unavailable",
        }
    if device is None:
        return {
            "device_id": device_id,
            "state": "unavailable",
            "linked": False,
            "inference_ready": False,
            "execution_target": "unavailable",
        }
    relay = await BROKER.status((firebase_uid, device_id))
    active = str(device.get("status") or "") == "active"
    state = "revoked" if not active else str(relay["state"] or "offline")
    ready = active and relay["connected"] and state == "ready" and not relay["busy"]
    return {
        "device_id": device_id,
        "state": state,
        "linked": active,
        "inference_ready": ready,
        "execution_target": "puppy" if active and state in {"ready", "busy"} else "unavailable",
        "relay": relay,
    }
