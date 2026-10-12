"""Document-feed wake-up stream: typed v2 frames, bounded v1 long-poll.

Two entry points share this generator and one per-worker admission registry:

- ``GET /api/consent/document-feed/{user_id}[?v=2]``: Firebase bearer whose
  uid must equal the path uid (registered on the ``api.routes.sse`` router).
- ``GET /api/one/feed/events?v=2``: token-scoped web entry point
  (``api.routes.one.feed_events``); always v2.

Frames are reread hints, never authority. Clients fetch authenticated
snapshots; amounts, file names, provider IDs and counterpart data never enter
the stream.

v2 (``?v=2``)::

    hello          {"v":2,"heartbeat_ms":15000,"max_lifetime_ms":<ms>,"live":bool}
    feed_reset     {}                         on connect and after a LISTEN resync
    feed_changed   id:<event uuid> {"request_id":"<uuid>"}
    payout_changed {"kinds":[...],"request_ids":[<=20 uuids]}
    heartbeat      {"ts":<epoch ms>,"live":bool}   every 15 s, time-based
    reconnect      {"after_ms":0..2000}       just before the server closes

Payout doorbells coalesce per stream (500 ms trailing debounce, 2 s maximum
wait). Missing or unknown kinds mean every kind. A v2 stream lives 840 s
+/- 60 s, below the iOS stream plugin's 900 s resource timeout.

v1 (no ``v``) keeps feed_reset, feed_changed and heartbeat only. A payout
burst becomes one feed_reset. The stream lives at most 120 s and closes about
500 ms after its first post-connect frame, so an installed build that buffers
the whole body sees a change within seconds and frees its backend slot.

Admission: at most 6 document-feed streams per worker and 3 per uid per worker.
A fourth stream for one uid evicts that uid's oldest; a new stream on a full
worker gets 503 with ``Retry-After: 60``.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import secrets
import time
from collections.abc import AsyncGenerator, Callable
from dataclasses import dataclass
from typing import Annotated, Any
from uuid import UUID

from fastapi import Header, HTTPException, Path, Query, Request
from fastapi.concurrency import run_in_threadpool
from sse_starlette.sse import EventSourceResponse
from starlette.types import Receive, Scope, Send

from api.utils.firebase_auth import verify_firebase_bearer
from hushh_mcp.services.payout_doorbell import PAYOUT_DOORBELL_TYPE, PAYOUT_KINDS

logger = logging.getLogger(__name__)

PROTOCOL_V1 = 1
PROTOCOL_V2 = 2
FEED_CHANGED_EVENT_TYPE = "document_share_feed_changed"
# Local-only queue sentinel (never published through PostgreSQL). The resync
# sentinel is api.consent_listener.LOCAL_RESYNC_EVENT_TYPE.
EVICT_EVENT_TYPE = "__evict__"

MAX_REQUEST_IDS = 20
MAX_STREAMS_PER_USER = 3
MAX_STREAMS_PER_WORKER = 6
BUSY_RETRY_AFTER_SECONDS = 60
V2_LIFETIME_SECONDS = 840
V2_LIFETIME_JITTER_SECONDS = 60
V1_MAX_LIFETIME_SECONDS = 120
V1_LIFETIME_JITTER_SECONDS = 10
RECONNECT_MAX_AFTER_MS = 2_000
# A lease that outlives its stream's lifetime by this much leaked (its
# response was never run); admission drops it.
LEASE_GRACE_SECONDS = 60

_STREAM_HEADERS = {
    "Cache-Control": "no-cache, no-store",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


@dataclass(frozen=True)
class StreamTiming:
    heartbeat_seconds: float = 15.0
    v1_heartbeat_seconds: float = 30.0
    coalesce_debounce_seconds: float = 0.5
    coalesce_max_wait_seconds: float = 2.0
    v1_close_after_frame_seconds: float = 0.5


DEFAULT_TIMING = StreamTiming()


def negotiate_version(raw: str | None) -> int:
    """``v=2`` or higher selects v2; anything else keeps today's v1 frames."""
    value = (raw or "").strip()
    if value.isascii() and value.isdigit() and int(value) >= PROTOCOL_V2:
        return PROTOCOL_V2
    return PROTOCOL_V1


def stream_lifetime_seconds(version: int) -> float:
    """v2: 840 s +/- 60 s, always below 900 s. v1: 110-120 s."""
    if version >= PROTOCOL_V2:
        jitter_ms = secrets.randbelow(2 * V2_LIFETIME_JITTER_SECONDS * 1000)
        return V2_LIFETIME_SECONDS - V2_LIFETIME_JITTER_SECONDS + jitter_ms / 1000
    return V1_MAX_LIFETIME_SECONDS - secrets.randbelow(V1_LIFETIME_JITTER_SECONDS * 1000 + 1) / 1000


def _offer_newest(queue: asyncio.Queue[Any], item: dict[str, Any]) -> None:
    try:
        queue.put_nowait(item)
    except asyncio.QueueFull:
        with contextlib.suppress(asyncio.QueueEmpty):
            queue.get_nowait()
        with contextlib.suppress(asyncio.QueueFull):
            queue.put_nowait(item)


class StreamLease:
    """One admitted stream; released exactly once, evictable by its owner's next stream."""

    __slots__ = (
        "user_id",
        "version",
        "opened_at",
        "lifetime_seconds",
        "queue",
        "evicted",
        "_owner",
    )

    def __init__(
        self,
        owner: StreamAdmission,
        user_id: str,
        version: int,
        opened_at: float,
        lifetime_seconds: float,
    ) -> None:
        self._owner: StreamAdmission | None = owner
        self.user_id = user_id
        self.version = version
        self.opened_at = opened_at
        self.lifetime_seconds = lifetime_seconds
        self.queue: asyncio.Queue[Any] | None = None
        self.evicted = False

    @property
    def expires_at(self) -> float:
        return self.opened_at + self.lifetime_seconds + LEASE_GRACE_SECONDS

    def release(self) -> None:
        owner, self._owner = self._owner, None
        if owner is not None:
            owner.discard(self)


class StreamAdmission:
    """Per-worker caps. All calls run on the event loop thread; no awaits inside."""

    def __init__(
        self,
        *,
        per_user: int = MAX_STREAMS_PER_USER,
        per_worker: int = MAX_STREAMS_PER_WORKER,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._per_user = per_user
        self._per_worker = per_worker
        self._clock = clock
        self._leases: list[StreamLease] = []

    def admit(self, user_id: str, version: int, lifetime_seconds: float) -> StreamLease | None:
        now = self._clock()
        for leaked in [lease for lease in self._leases if lease.expires_at <= now]:
            leaked.release()
        own = [lease for lease in self._leases if lease.user_id == user_id]
        while len(own) >= self._per_user:
            self._evict(own.pop(0))
        if len(self._leases) >= self._per_worker:
            return None
        lease = StreamLease(self, user_id, version, now, lifetime_seconds)
        self._leases.append(lease)
        return lease

    def discard(self, lease: StreamLease) -> None:
        with contextlib.suppress(ValueError):
            self._leases.remove(lease)

    def active(self) -> list[StreamLease]:
        return list(self._leases)

    @staticmethod
    def _evict(lease: StreamLease) -> None:
        lease.evicted = True
        lease.release()
        if lease.queue is not None:
            _offer_newest(lease.queue, {"type": EVICT_EVENT_TYPE})


_ADMISSION = StreamAdmission()


class PayoutChangeCoalescer:
    """Merges one stream's payout doorbells: trailing debounce with a maximum wait."""

    def __init__(self, debounce_seconds: float, max_wait_seconds: float) -> None:
        self._debounce = debounce_seconds
        self._max_wait = max_wait_seconds
        self._first_at: float | None = None
        self._last_at = 0.0
        self._all_kinds = False
        self._kinds: set[str] = set()
        self._request_ids: list[str] = []
        self._too_many_requests = False

    def add(self, kinds: frozenset[str] | None, request_id: str | None, now: float) -> None:
        if self._first_at is None:
            self._first_at = now
        self._last_at = now
        if kinds is None:
            self._all_kinds = True
        else:
            self._kinds.update(kinds)
        if request_id is None or request_id in self._request_ids:
            return
        if len(self._request_ids) < MAX_REQUEST_IDS:
            self._request_ids.append(request_id)
        else:
            self._too_many_requests = True

    def due_at(self) -> float | None:
        if self._first_at is None:
            return None
        return min(self._last_at + self._debounce, self._first_at + self._max_wait)

    def take(self) -> tuple[list[str], list[str]]:
        """Closed kinds in canonical order; an empty id list means "not request-specific"."""
        kinds = [kind for kind in PAYOUT_KINDS if self._all_kinds or kind in self._kinds]
        request_ids = [] if self._too_many_requests else list(self._request_ids)
        self._first_at = None
        self._all_kinds = False
        self._kinds = set()
        self._request_ids = []
        self._too_many_requests = False
        return kinds, request_ids


def doorbell_kinds(raw: object) -> frozenset[str] | None:
    """Closed kinds from a doorbell; None (all kinds) when missing or unknown."""
    if not isinstance(raw, list) or not raw:
        return None
    kinds: set[str] = set()
    for kind in raw:
        if not isinstance(kind, str) or kind not in PAYOUT_KINDS:
            return None
        kinds.add(kind)
    return frozenset(kinds)


def _uuid_or_none(raw: object) -> str | None:
    if not isinstance(raw, str):
        return None
    try:
        return str(UUID(raw))
    except ValueError:
        return None


def _json_frame(event: str, payload: dict[str, Any]) -> dict[str, str]:
    return {"event": event, "data": json.dumps(payload, separators=(",", ":"))}


def _reset_frame() -> dict[str, str]:
    return {"event": "feed_reset", "data": "{}"}


def _feed_changed_frame(item: dict[str, Any]) -> dict[str, str] | None:
    event_id = _uuid_or_none(item.get("event_id"))
    request_id = _uuid_or_none(item.get("request_id"))
    if event_id is None or request_id is None:
        return None
    return {
        "event": "feed_changed",
        "id": event_id,
        "data": json.dumps({"request_id": request_id}),
    }


async def _disconnected(request: Any) -> bool:
    probe = getattr(request, "is_disconnected", None)
    if probe is None:
        return False
    return bool(await probe())


async def document_feed_event_generator(
    user_id: str,
    request: Request,
    *,
    version: int = PROTOCOL_V1,
    lease: StreamLease | None = None,
    lifetime_seconds: float | None = None,
    timing: StreamTiming = DEFAULT_TIMING,
) -> AsyncGenerator[dict[str, str], None]:
    """Stream opaque Drive and payout doorbells, repairing missed changes by snapshot.

    The subscription precedes the reset frame, so a commit racing the client's
    initial authenticated reread is queued and delivered afterwards. Every
    connection and every LISTEN recovery sends a reset; LISTEN/NOTIFY is never
    treated as durable state or as grant authority.
    """
    from api import consent_listener

    v2 = version >= PROTOCOL_V2
    if lifetime_seconds is None:
        lifetime_seconds = (
            lease.lifetime_seconds if lease is not None else stream_lifetime_seconds(version)
        )
    loop = asyncio.get_running_loop()
    started = loop.time()
    deadline = started + lifetime_seconds
    heartbeat_every = timing.heartbeat_seconds if v2 else timing.v1_heartbeat_seconds
    next_heartbeat = started + heartbeat_every
    close_at: float | None = None
    coalescer = PayoutChangeCoalescer(
        timing.coalesce_debounce_seconds, timing.coalesce_max_wait_seconds
    )

    def after_frame(now: float) -> None:
        # v1 is long-poll: deliver what arrives in the next half second, then close.
        nonlocal close_at
        if not v2 and close_at is None:
            close_at = now + timing.v1_close_after_frame_seconds

    queue = await consent_listener.subscribe_consent_queue(user_id)
    if lease is not None:
        lease.queue = queue
    try:
        if v2:
            yield _json_frame(
                "hello",
                {
                    "v": PROTOCOL_V2,
                    "heartbeat_ms": int(timing.heartbeat_seconds * 1000),
                    "max_lifetime_ms": int(lifetime_seconds * 1000),
                    "live": consent_listener.is_listener_active(),
                },
            )
        yield _reset_frame()
        while lease is None or not lease.evicted:
            now = loop.time()
            due = coalescer.due_at()
            if due is not None and now >= due:
                kinds, request_ids = coalescer.take()
                if v2:
                    yield _json_frame(
                        "payout_changed", {"kinds": kinds, "request_ids": request_ids}
                    )
                else:
                    yield _reset_frame()
                after_frame(now)
                continue
            if close_at is not None and now >= close_at:
                break
            if now >= deadline:
                if v2:
                    yield _json_frame(
                        "reconnect", {"after_ms": secrets.randbelow(RECONNECT_MAX_AFTER_MS + 1)}
                    )
                break
            if now >= next_heartbeat:
                next_heartbeat += heartbeat_every
                if next_heartbeat <= now:
                    next_heartbeat = now + heartbeat_every
                if v2:
                    yield _json_frame(
                        "heartbeat",
                        {
                            "ts": int(time.time() * 1000),
                            "live": consent_listener.is_listener_active(),
                        },
                    )
                else:
                    yield {"event": "heartbeat", "data": "{}"}
                continue
            if await _disconnected(request):
                break
            wake_at = min(
                deadline,
                next_heartbeat,
                due if due is not None else deadline,
                close_at if close_at is not None else deadline,
            )
            try:
                item = await asyncio.wait_for(queue.get(), timeout=max(0.0, wake_at - now))
            except TimeoutError:
                continue
            if not isinstance(item, dict):
                continue
            event_type = item.get("type")
            if event_type == EVICT_EVENT_TYPE:
                break
            if event_type == consent_listener.LOCAL_RESYNC_EVENT_TYPE:
                yield _reset_frame()
                after_frame(loop.time())
            elif event_type == PAYOUT_DOORBELL_TYPE:
                coalescer.add(
                    doorbell_kinds(item.get("kinds")),
                    _uuid_or_none(item.get("request_id")),
                    loop.time(),
                )
            elif event_type == FEED_CHANGED_EVENT_TYPE:
                frame = _feed_changed_frame(item)
                if frame is not None:
                    yield frame
                    after_frame(loop.time())
    finally:
        if lease is not None:
            lease.release()
        await consent_listener.unsubscribe_consent_queue(user_id, queue)


class _LeasedEventSourceResponse(EventSourceResponse):
    """Releases the admission lease however the response ends."""

    def __init__(
        self,
        content: AsyncGenerator[dict[str, str], None],
        *,
        lease: StreamLease,
    ) -> None:
        super().__init__(content, headers=dict(_STREAM_HEADERS))
        self._lease = lease

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            self._lease.release()


def open_document_feed_stream(
    user_id: str,
    request: Request,
    *,
    version: int,
    admission: StreamAdmission | None = None,
) -> EventSourceResponse:
    """Admit one stream for an already authenticated owner, or refuse with 503."""
    lifetime = stream_lifetime_seconds(version)
    lease = (admission or _ADMISSION).admit(user_id, version, lifetime)
    if lease is None:
        logger.warning("document_feed.stream_busy version=%s", version)
        raise HTTPException(
            status_code=503,
            detail={"code": "FEED_STREAM_BUSY", "message": "Live updates are busy right now."},
            headers={
                "Retry-After": str(BUSY_RETRY_AFTER_SECONDS),
                "Cache-Control": "private, no-store",
                "Access-Control-Expose-Headers": "Retry-After",
            },
        )
    return _LeasedEventSourceResponse(
        document_feed_event_generator(
            user_id, request, version=version, lease=lease, lifetime_seconds=lifetime
        ),
        lease=lease,
    )


def web_stream_enabled() -> bool:
    """DOCUMENT_FEED_WEB_STREAM_ENABLED wins; otherwise on everywhere but production."""
    raw = str(os.getenv("DOCUMENT_FEED_WEB_STREAM_ENABLED", "")).strip().lower()
    if raw:
        return raw in {"1", "true", "yes", "on"}
    environment = str(os.getenv("ENVIRONMENT", "development")).strip().lower()
    return environment != "production"


async def _authorize_owner(user_id: str, authorization: str | None) -> None:
    firebase_uid = await run_in_threadpool(verify_firebase_bearer, authorization)
    if firebase_uid != user_id:
        raise HTTPException(
            status_code=403,
            detail={
                "error_code": "USER_ID_MISMATCH",
                "message": "Authenticated user does not match the requested user_id.",
            },
        )


async def document_feed_events(
    user_id: Annotated[str, Path(min_length=1, max_length=128)],
    request: Request,
    v: Annotated[str | None, Query(max_length=4, description="2 selects typed frames")] = None,
    authorization: Annotated[str | None, Header(description="Bearer Firebase ID token")] = None,
) -> EventSourceResponse:
    """Authenticated live wake-ups for document requests and payouts.

    Unlike the legacy consent-fallback stream, this endpoint is available
    alongside FCM. Its reset frame instructs a fresh authenticated snapshot.
    """
    await _authorize_owner(user_id, authorization)
    return open_document_feed_stream(user_id, request, version=negotiate_version(v))
