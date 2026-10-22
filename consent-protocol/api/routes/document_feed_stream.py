"""Document-feed wake-up stream: typed v2 frames, bounded v1 long-poll.

Two entry points share this generator and one per-worker admission registry:

- ``GET /api/consent/document-feed/{user_id}[?v=1|2]``: Firebase bearer whose
  uid must equal the path uid (``api.routes.sse``). Native apps call it
  directly; the web reaches it through the same-origin Next proxy, which marks
  the request so its lifetime ends before the web server's request timeout.
- ``GET /api/one/feed/events?v=2``: token-scoped web entry point at the
  backend origin (``api.routes.one.feed_events``); always v2.

Frames are reread hints, never authority. Clients fetch authenticated
snapshots; amounts, file names, provider IDs and counterpart data never enter
the stream. Every stream re-verifies its Firebase token every 30 s, even while
its queue is busy, and closes silently once the token no longer authorizes the
owner.

v2 (``?v=2``)::

    hello          {"v":2,"heartbeat_ms":15000,"max_lifetime_ms":<ms>,"live":bool}
    feed_reset     {}                         on connect and after a LISTEN resync
    feed_changed   id:<event uuid> {"request_id":"<uuid>"}   one document request
    feed_changed   {}                         any other committed Feed write
    payout_changed {"kinds":[...],"request_ids":[<=20 uuids]}
    heartbeat      {"ts":<epoch ms>,"live":bool}   every 15 s, time-based
    reconnect      {"after_ms":0..2000}       just before the server closes

Payout doorbells coalesce per stream (500 ms trailing debounce, 2 s maximum
wait). Missing or unknown kinds mean every kind.

v1 (no ``v``) keeps feed_reset, feed_changed and heartbeat ``{"live":bool}``.
A payout burst becomes one feed_reset. The stream closes about 500 ms after its
first post-connect reset or document frame, so an installed build that buffers
the whole body sees a change within seconds and frees its backend slot.

Lifetimes: v2 840 s +/- 60 s (below the iOS stream plugin's 900 s resource
timeout); v1 110-120 s; any stream through the Next proxy 90-110 s, below the
web server's 120 s production request timeout (300 s in UAT).

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
from collections.abc import AsyncGenerator, Awaitable, Callable
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from fastapi import HTTPException, Request
from sse_starlette.sse import EventSourceResponse
from starlette.types import Receive, Scope, Send

from hushh_mcp.services.payout_doorbell import PAYOUT_DOORBELL_TYPE, PAYOUT_KINDS

logger = logging.getLogger(__name__)

PROTOCOL_V1 = 1
PROTOCOL_V2 = 2
FEED_CHANGED_EVENT_TYPE = "document_share_feed_changed"
# Migration 313: one metadata-only hint for every committed feed_events write.
GENERAL_FEED_EVENT_TYPE = "feed_changed"
# Local-only queue sentinel (never published through PostgreSQL). The resync
# sentinel is api.consent_listener.LOCAL_RESYNC_EVENT_TYPE.
EVICT_EVENT_TYPE = "__evict__"

# The Next proxy sends this fixed header. It is trusted only to shorten the
# stream's lifetime; a client that sets it itself merely reconnects sooner.
STREAM_PROXY_HEADER = "X-Hussh-Stream-Via"
STREAM_PROXY_VALUE = "next-proxy"

MAX_REQUEST_IDS = 20
MAX_STREAMS_PER_USER = 3
MAX_STREAMS_PER_WORKER = 6
BUSY_RETRY_AFTER_SECONDS = 60
V2_LIFETIME_SECONDS = 840
V2_LIFETIME_JITTER_SECONDS = 60
V1_MAX_LIFETIME_SECONDS = 120
V1_LIFETIME_JITTER_SECONDS = 10
PROXIED_LIFETIME_SECONDS = 100
PROXIED_LIFETIME_JITTER_SECONDS = 10
FEED_AUTH_RECHECK_SECONDS = 30
FEED_SEND_TIMEOUT_SECONDS = 10
RECONNECT_MAX_AFTER_MS = 2_000
# A lease that outlives its stream's lifetime by this much leaked (its
# response was never run); admission drops it.
LEASE_GRACE_SECONDS = 60

_STREAM_HEADERS = {
    "Cache-Control": "no-cache, no-store",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}

# Raises HTTPException once the stream's token no longer authorizes its owner.
Authorize = Callable[[], Awaitable[None]]


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


def stream_lifetime_seconds(version: int, *, proxied: bool = False) -> float:
    """Proxied: 90-110 s. Otherwise v2 840 s +/- 60 s (always below 900 s), v1 110-120 s."""
    if proxied:
        jitter_ms = secrets.randbelow(2 * PROXIED_LIFETIME_JITTER_SECONDS * 1000 + 1)
        return PROXIED_LIFETIME_SECONDS - PROXIED_LIFETIME_JITTER_SECONDS + jitter_ms / 1000
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


def _general_feed_frame(item: dict[str, Any]) -> dict[str, str]:
    # Only an explicit history reset reason crosses this content-free boundary.
    payload = {"reason": "history_mutated"} if item.get("reason") == "history_mutated" else {}
    return _json_frame("feed_changed", payload)


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
    authorize: Authorize | None = None,
    auth_recheck_seconds: float | None = None,
) -> AsyncGenerator[dict[str, str], None]:
    """Stream opaque Drive, Feed and payout doorbells, repairing missed changes by snapshot.

    The subscription precedes the reset frame, so a commit racing the client's
    initial authenticated reread is queued and delivered afterwards. Every
    connection and every LISTEN recovery sends a reset; LISTEN/NOTIFY is never
    treated as durable state or as grant authority. ``authorize`` re-verifies
    the token on a wall-clock schedule, also before releasing a hint that
    raced the timer; a refusal ends the stream without another frame.
    """
    from api import consent_listener

    v2 = version >= PROTOCOL_V2
    if lifetime_seconds is None:
        lifetime_seconds = (
            lease.lifetime_seconds if lease is not None else stream_lifetime_seconds(version)
        )
    recheck_every = (
        FEED_AUTH_RECHECK_SECONDS if auth_recheck_seconds is None else auth_recheck_seconds
    )
    loop = asyncio.get_running_loop()
    started = loop.time()
    deadline = started + lifetime_seconds
    recheck_at = started + recheck_every if authorize is not None else None
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

    async def still_authorized() -> bool:
        nonlocal recheck_at
        if authorize is None or recheck_at is None or loop.time() < recheck_at:
            return True
        try:
            await authorize()
        except HTTPException:
            # Headers are already sent. Close without revealing why; the next
            # handshake fails with the real status.
            return False
        recheck_at = loop.time() + recheck_every
        return True

    queue = await consent_listener.subscribe_consent_queue(user_id, snapshot_resets=True)
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
            if not await still_authorized():
                break
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
                live = consent_listener.is_listener_active()
                if v2:
                    yield _json_frame("heartbeat", {"ts": int(time.time() * 1000), "live": live})
                else:
                    yield {"event": "heartbeat", "data": json.dumps({"live": live})}
                continue
            if await _disconnected(request):
                break
            wake_at = min(
                deadline,
                next_heartbeat,
                due if due is not None else deadline,
                close_at if close_at is not None else deadline,
                recheck_at if recheck_at is not None else deadline,
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
            # A hint can race the lifetime or the auth timer; nothing is
            # released past either boundary.
            if loop.time() >= deadline:
                continue  # the top of the loop closes (v2 after a reconnect hint)
            if not await still_authorized():
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
            elif event_type == GENERAL_FEED_EVENT_TYPE:
                # Installed v1 builds ignore it; it never shortens their long-poll.
                yield _general_feed_frame(item)
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
        send_timeout: float,
    ) -> None:
        super().__init__(content, headers=dict(_STREAM_HEADERS), send_timeout=send_timeout)
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
    proxied: bool = False,
    lifetime_seconds: float | None = None,
    authorize: Authorize | None = None,
    auth_recheck_seconds: float | None = None,
    send_timeout_seconds: float | None = None,
    admission: StreamAdmission | None = None,
) -> EventSourceResponse:
    """Admit one stream for an already authenticated owner, or refuse with 503.

    A send blocked for ``send_timeout_seconds`` (a stalled client) ends the
    response, which releases both the admission lease and the subscription.
    """
    lifetime = (
        stream_lifetime_seconds(version, proxied=proxied)
        if lifetime_seconds is None
        else lifetime_seconds
    )
    lease = (admission or _ADMISSION).admit(user_id, version, lifetime)
    if lease is None:
        logger.warning("document_feed.stream_busy version=%s proxied=%s", version, proxied)
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
            user_id,
            request,
            version=version,
            lease=lease,
            lifetime_seconds=lifetime,
            authorize=authorize,
            auth_recheck_seconds=auth_recheck_seconds,
        ),
        lease=lease,
        send_timeout=(
            FEED_SEND_TIMEOUT_SECONDS if send_timeout_seconds is None else send_timeout_seconds
        ),
    )


def web_stream_enabled() -> bool:
    """DOCUMENT_FEED_WEB_STREAM_ENABLED wins; otherwise on everywhere but production."""
    raw = str(os.getenv("DOCUMENT_FEED_WEB_STREAM_ENABLED", "")).strip().lower()
    if raw:
        return raw in {"1", "true", "yes", "on"}
    environment = str(os.getenv("ENVIRONMENT", "development")).strip().lower()
    return environment != "production"
