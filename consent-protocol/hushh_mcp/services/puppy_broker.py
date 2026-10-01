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
import hashlib
import json
import logging
import re
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
_MODEL_NAME = re.compile(r"^[A-Za-z0-9_.:/-]{1,128}$")


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
    # None means the device declared nothing, which the pre-dispatch gate reads
    # as its negative control. An empty tuple means it declared an EMPTY list,
    # which is a real declaration of no capabilities. Collapsing the two is how
    # the gate was silently disabled on the owner-direct path.
    capabilities: Optional[tuple[str, ...]] = None
    pending: dict[str, asyncio.Queue[dict[str, Any]]] = field(default_factory=dict)
    busy_request_id: Optional[str] = None
    last_seen_monotonic: float = field(default_factory=time.monotonic)
    last_work_monotonic: float = field(default_factory=time.monotonic)
    status: str = "ready"
    replaced: bool = False
    catalog_status: str = "unavailable"
    catalog_default_model: str = ""
    catalog_models: tuple[str, ...] = ()
    catalog_version: str = ""
    catalog_observed_at: int | None = None
    catalog_received_at: int | None = None


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
        capabilities: Optional[tuple[str, ...]] = None,
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
                capabilities=(
                    None if capabilities is None else tuple(str(c)[:64] for c in capabilities)[:32]
                ),
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
        link = self._links.get(key)
        return link is not None and not link.replaced and link.status in {"ready", "busy"}

    async def available(self, key: tuple[str, str]) -> bool:
        link = await self.get(key)
        return link is not None and not link.replaced and link.status in {"ready", "busy"}

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

    async def deliver(
        self,
        key: tuple[str, str],
        frame: dict[str, Any],
        *,
        expected_link: DeviceLink | None = None,
    ) -> None:
        """A plain frame the relay route opened from the device. Routed by request id."""
        link = await self.get(key)
        if link is None or (expected_link is not None and link is not expected_link):
            return
        link.last_seen_monotonic = time.monotonic()
        kind = str(frame.get("type") or "")
        if kind in {"relay.heartbeat", "relay.status"}:
            status = str(frame.get("status") or "ready").strip().lower()
            link.status = status if status in {"ready", "busy", "offline"} else "offline"
            return
        if kind == "model.catalog":
            self._accept_catalog(link, frame)
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

    @staticmethod
    def _accept_catalog(link: DeviceLink, frame: dict[str, Any]) -> None:
        """Accept only a bounded, internally consistent inventory from the sealed device."""
        status = frame.get("status")
        raw_models = frame.get("models")
        raw_default = frame.get("defaultModel")
        raw_version = frame.get("catalogVersion")
        observed_at = frame.get("observedAt")
        if status not in {"available", "unavailable"} or not isinstance(raw_models, list):
            raise ValueError("invalid Puppy model catalog")
        if not isinstance(observed_at, int) or isinstance(observed_at, bool) or observed_at < 0:
            raise ValueError("invalid Puppy model observation")
        if not isinstance(raw_default, str) or not isinstance(raw_version, str):
            raise ValueError("invalid Puppy model catalog")
        if len(raw_models) > 32 or any(
            not isinstance(row, dict)
            or set(row) != {"id"}
            or not isinstance(row["id"], str)
            or _MODEL_NAME.fullmatch(row["id"]) is None
            or "://" in row["id"]
            or row["id"].startswith("/")
            for row in raw_models
        ):
            raise ValueError("invalid Puppy model catalog")
        models = tuple(row["id"] for row in raw_models)
        if len(set(models)) != len(models):
            raise ValueError("duplicate Puppy model catalog entry")
        if status == "available":
            if not models or (raw_default and raw_default not in models):
                raise ValueError("invalid Puppy default model")
            material = json.dumps(
                {"defaultModel": raw_default, "models": sorted(models)},
                separators=(",", ":"),
            ).encode("utf-8")
            if raw_version != hashlib.sha256(material).hexdigest():
                raise ValueError("invalid Puppy model catalog version")
        elif models or raw_default or raw_version:
            raise ValueError("unavailable Puppy catalog must be empty")
        link.catalog_status = status
        link.catalog_default_model = raw_default
        link.catalog_models = models
        link.catalog_version = raw_version
        link.catalog_observed_at = observed_at
        link.catalog_received_at = int(time.time() * 1000)

    async def catalog(self, key: tuple[str, str]) -> dict[str, Any]:
        link = await self.get(key)
        if link is None or link.replaced or link.status not in {"ready", "busy"}:
            return {
                "status": "offline",
                "defaultModel": "",
                "models": [],
                "catalogVersion": "",
                "observedAt": None,
                "receivedAt": None,
            }
        return {
            "status": link.catalog_status,
            "defaultModel": link.catalog_default_model,
            "models": [{"id": model} for model in link.catalog_models],
            "catalogVersion": link.catalog_version,
            "observedAt": link.catalog_observed_at,
            "receivedAt": link.catalog_received_at,
        }

    async def require_model(
        self, key: tuple[str, str], model: str, catalog_version: str
    ) -> str | None:
        """Return a stable refusal code for an explicit selected model."""
        link = await self.get(key)
        return self._model_refusal(link, model, catalog_version)

    @staticmethod
    def _model_refusal(link: DeviceLink | None, model: str, catalog_version: str) -> str | None:
        if link is None or link.catalog_status != "available":
            return "PUPPY_MODEL_UNAVAILABLE"
        if catalog_version != link.catalog_version:
            return "PUPPY_CATALOG_STALE"
        if model not in link.catalog_models:
            return "PUPPY_MODEL_UNAVAILABLE"
        return None

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
        if link is None or link.replaced or link.status not in {"ready", "busy"}:
            raise PuppyBrokerOffline("linked Puppy is offline")
        selected_model = str(frame.get("model") or "")
        if selected_model and selected_model != "local":
            refusal = self._model_refusal(
                link, selected_model, str(frame.get("catalogVersion") or "")
            )
            if refusal:
                yield {"type": "inference.error", "requestId": request_id, "code": refusal}
                return
        if link.status == "busy" or link.busy_request_id is not None or request_id in link.pending:
            yield {"type": "inference.error", "requestId": request_id, "code": "PUPPY_BUSY"}
            return
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=MAX_PENDING_FRAMES)
        link.last_work_monotonic = time.monotonic()
        link.pending[request_id] = queue
        link.busy_request_id = request_id
        started = time.monotonic()
        finished = False
        try:
            await link.send(frame)
            while True:
                try:
                    remaining = REQUEST_DEADLINE_SECONDS - (time.monotonic() - started)
                    if remaining <= 0:
                        raise asyncio.TimeoutError
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
            link.last_work_monotonic = time.monotonic()
            link.pending.pop(request_id, None)
            if link.busy_request_id == request_id:
                link.busy_request_id = None

    @staticmethod
    async def _cancel(link: DeviceLink, request_id: str) -> None:
        if link.replaced:
            return
        try:
            await asyncio.wait_for(
                link.send({"type": "inference.cancel", "requestId": request_id}),
                timeout=3.0,
            )
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
            "capabilities": (None if link.capabilities is None else list(link.capabilities)),
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
                    "capabilities": (
                        None if link.capabilities is None else list(link.capabilities)
                    ),
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
