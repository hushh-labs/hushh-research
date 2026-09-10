"""The in-pod Puppy broker: one owner, one process, one persistent device socket.

Lifted from the hub broker (``api/routes/one/puppy_relay.py``: the device link,
register, remove, get, status, and the busy and timeout semantics) without the
rendezvous store. An owner pod is single-instance by construction (``maxScale`` 1)
and its fence is the incarnation object, not Redis, so cross-instance presence,
pub/sub and distributed busy locks have nothing to coordinate here. What is kept
is exactly what a single process needs:

* one link per ``(owner, device)``; a new socket replaces the old one, which is
  closed 1012 and never written to again (the hub captured its link once per
  connection and kept writing to a replaced socket; ``dispatch`` here resolves the
  link per request);
* one request in flight per device; a second is answered ``PUPPY_BUSY``;
* an inter-frame bound of 65 s (above Hermes' 60 s read timeout) and a request
  deadline of 120 s, after which the device is told ``inference.cancel`` so a local
  model does not keep generating for an answer nobody will read;
* every publication gated on the incarnation lease: a fenced or uncertain
  incarnation dispatches nothing.

The broker deals in PLAIN frames. Sealing is the relay route's job (it owns the
socket and the per-connection key), which is why a link carries ``send`` and
``close`` callables rather than a socket.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Optional
from uuid import uuid4

logger = logging.getLogger(__name__)

MAX_FRAME_BYTES = 1_048_576
MAX_PENDING_FRAMES = 32
MAX_REQUEST_ID_LENGTH = 128
INTER_FRAME_TIMEOUT_SECONDS = 65.0
REQUEST_DEADLINE_SECONDS = 120.0

_TERMINAL = frozenset({"inference.done", "inference.result", "inference.error"})
_DEVICE_FRAMES = frozenset(
    {"inference.delta", "inference.result", "inference.done", "inference.error"}
)


class PuppyBrokerFenced(RuntimeError):
    """This incarnation no longer holds the pod; it publishes nothing."""


class PuppyBrokerOffline(RuntimeError):
    """No live link for this owner and device."""


@dataclass
class DeviceLink:
    key: tuple[str, str]
    send: Callable[[dict[str, Any]], Awaitable[None]]
    close: Callable[[int, str], Awaitable[None]]
    generation: int
    epoch: int
    model: str = ""
    capabilities: tuple[str, ...] = ()
    pending: dict[str, asyncio.Queue[dict[str, Any]]] = field(default_factory=dict)
    busy_request_id: Optional[str] = None
    last_seen_monotonic: float = field(default_factory=time.monotonic)
    status: str = "ready"
    replaced: bool = False


class PuppyBroker:
    def __init__(self) -> None:
        self._links: dict[tuple[str, str], DeviceLink] = {}
        self._lock = asyncio.Lock()
        self._generation = 0
        self._instance_id = uuid4().hex

    # -- links --------------------------------------------------------------------------

    async def register(
        self,
        key: tuple[str, str],
        *,
        send: Callable[[dict[str, Any]], Awaitable[None]],
        close: Callable[[int, str], Awaitable[None]],
        epoch: int,
        model: str = "",
        capabilities: tuple[str, ...] = (),
    ) -> DeviceLink:
        async with self._lock:
            prior = self._links.get(key)
            if prior is not None:
                prior.replaced = True
                try:
                    await prior.close(1012, "replaced")
                except Exception:  # noqa: BLE001 - the old socket may already be gone
                    pass
                self._fail_pending(prior, "PUPPY_OFFLINE")
            self._generation += 1
            link = DeviceLink(
                key=key,
                send=send,
                close=close,
                generation=self._generation,
                epoch=int(epoch),
                model=str(model or "")[:128],
                capabilities=tuple(str(c)[:64] for c in capabilities)[:32],
            )
            self._links[key] = link
        logger.info("puppy_broker.linked generation=%s epoch=%s", link.generation, link.epoch)
        return link

    async def remove(self, key: tuple[str, str], link: DeviceLink) -> None:
        async with self._lock:
            if self._links.get(key) is link:
                self._links.pop(key, None)
            self._fail_pending(link, "PUPPY_OFFLINE")

    @staticmethod
    def _fail_pending(link: DeviceLink, code: str) -> None:
        for request_id, queue in tuple(link.pending.items()):
            try:
                queue.put_nowait({"type": "inference.error", "requestId": request_id, "code": code})
            except asyncio.QueueFull:
                pass

    async def get(self, key: tuple[str, str]) -> Optional[DeviceLink]:
        async with self._lock:
            return self._links.get(key)

    def is_linked(self, key: tuple[str, str]) -> bool:
        """Synchronous read for the transport factory; the event loop owns the dict."""
        return key in self._links

    async def available(self, key: tuple[str, str]) -> bool:
        return await self.get(key) is not None

    async def close_subject(
        self, device_id: str, *, code: int = 1008, reason: str = "revoked"
    ) -> int:
        """Close every link for a device, whichever owner key it hangs under."""
        closed = 0
        async with self._lock:
            victims = [(k, link) for k, link in self._links.items() if k[1] == device_id]
            for k, link in victims:
                self._links.pop(k, None)
                link.replaced = True
                self._fail_pending(link, "PUPPY_REVOKED")
        for _, link in victims:
            try:
                await link.close(code, reason)
            except Exception:  # noqa: BLE001
                pass
            closed += 1
        return closed

    # -- inbound from the device --------------------------------------------------------

    async def deliver(self, key: tuple[str, str], frame: dict[str, Any]) -> None:
        """A plain frame the relay route opened from the device. Routed by request id."""
        link = await self.get(key)
        if link is None:
            return
        link.last_seen_monotonic = time.monotonic()
        kind = str(frame.get("type") or "")
        if kind in {"relay.heartbeat", "relay.status"}:
            status = str(frame.get("status") or "ready").strip().lower()
            link.status = status if status in {"ready", "busy", "offline"} else "ready"
            return
        request_id = str(frame.get("requestId") or "")
        if not request_id or len(request_id) > MAX_REQUEST_ID_LENGTH or kind not in _DEVICE_FRAMES:
            raise ValueError("unsupported Puppy device frame")
        queue = link.pending.get(request_id)
        if queue is None:
            # A frame for a request that finished or never existed. Dropped, not
            # an error: a late delta after a timeout is ordinary.
            return
        try:
            queue.put_nowait(frame)
        except asyncio.QueueFull as exc:
            raise ValueError("Puppy response buffer is full") from exc

    # -- outbound from One -------------------------------------------------------------

    async def _require_current(self, incarnation: Any) -> None:
        if incarnation is None:
            return
        current = await incarnation.is_current()
        if current is not True:
            raise PuppyBrokerFenced("this incarnation no longer holds the pod")

    async def dispatch(
        self, key: tuple[str, str], frame: dict[str, Any], *, incarnation: Any = None
    ) -> AsyncIterator[dict[str, Any]]:
        """Send one ``inference.request`` and yield the device's frames for it.

        The link is resolved HERE, per request, so a device that reconnected between
        two turns is written to on its new socket. A busy device answers
        ``PUPPY_BUSY`` as an error frame (the transport raises on it), exactly as the
        hub did. A fenced incarnation raises before anything is sent.
        """
        await self._require_current(incarnation)
        request_id = str(frame.get("requestId") or "")
        if (
            str(frame.get("type") or "") != "inference.request"
            or not request_id
            or len(request_id) > MAX_REQUEST_ID_LENGTH
            or str(frame.get("deviceId") or "") != key[1]
        ):
            raise ValueError("Puppy request binding mismatch")
        link = await self.get(key)
        if link is None:
            raise PuppyBrokerOffline("linked Puppy is offline")
        if link.busy_request_id is not None or request_id in link.pending:
            yield {"type": "inference.error", "requestId": request_id, "code": "PUPPY_BUSY"}
            return
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=MAX_PENDING_FRAMES)
        link.pending[request_id] = queue
        link.busy_request_id = request_id
        started = time.monotonic()
        finished = False
        try:
            await link.send(frame)
            while True:
                remaining = REQUEST_DEADLINE_SECONDS - (time.monotonic() - started)
                if remaining <= 0:
                    raise asyncio.TimeoutError
                try:
                    async with asyncio.timeout(min(INTER_FRAME_TIMEOUT_SECONDS, remaining)):
                        response = await queue.get()
                except asyncio.TimeoutError:
                    await self._cancel(link, request_id)
                    yield {
                        "type": "inference.error",
                        "requestId": request_id,
                        "code": "PUPPY_TIMEOUT",
                    }
                    finished = True
                    return
                await self._require_current(incarnation)
                yield response
                if str(response.get("type") or "") in _TERMINAL:
                    finished = True
                    return
        finally:
            if not finished:
                # The consumer stopped early (cancelled turn, closed stream): tell the
                # device to stop generating rather than let it run to the end.
                await self._cancel(link, request_id)
            link.pending.pop(request_id, None)
            if link.busy_request_id == request_id:
                link.busy_request_id = None

    @staticmethod
    async def _cancel(link: DeviceLink, request_id: str) -> None:
        if link.replaced:
            return
        try:
            await link.send({"type": "inference.cancel", "requestId": request_id})
        except Exception:  # noqa: BLE001 - the socket may be gone; nothing to cancel
            pass

    # -- reporting ------------------------------------------------------------------

    async def status(self, key: tuple[str, str]) -> dict[str, Any]:
        link = await self.get(key)
        if link is None:
            return {"connected": False, "state": "offline", "busy": False, "generation": None}
        busy = link.busy_request_id is not None
        return {
            "connected": True,
            "state": "busy" if busy else link.status,
            "busy": busy,
            "generation": link.generation,
            "epoch": link.epoch,
            "model": link.model or None,
            "capabilities": list(link.capabilities),
            "last_seen_age_seconds": round(
                max(0.0, time.monotonic() - link.last_seen_monotonic), 3
            ),
        }

    async def report(self, hushh_id: str) -> dict[str, Any]:
        """Every link for this owner, shape only: ids, state, model, capabilities."""
        async with self._lock:
            links = [link for k, link in self._links.items() if k[0] == hushh_id]
        return {
            "links": [
                {
                    "deviceId": link.key[1],
                    "state": "busy" if link.busy_request_id else link.status,
                    "busy": link.busy_request_id is not None,
                    "model": link.model or None,
                    "capabilities": list(link.capabilities),
                    "generation": link.generation,
                    "epoch": link.epoch,
                }
                for link in links
            ]
        }


BROKER = PuppyBroker()

__all__ = [
    "BROKER",
    "INTER_FRAME_TIMEOUT_SECONDS",
    "MAX_FRAME_BYTES",
    "MAX_PENDING_FRAMES",
    "MAX_REQUEST_ID_LENGTH",
    "REQUEST_DEADLINE_SECONDS",
    "DeviceLink",
    "PuppyBroker",
    "PuppyBrokerFenced",
    "PuppyBrokerOffline",
]
