"""Bound shared-listener subscriptions without changing their wire payloads."""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncGenerator, Awaitable, Callable
from typing import Any

from fastapi import HTTPException, Request
from sse_starlette.sse import EventSourceResponse

from api.routes import document_feed_stream as streams

Backfill = Callable[[], Awaitable[list[dict[str, Any]]]]


def open_notification_stream(
    user_id: str,
    request: Request,
    content: Callable[[streams.StreamLease], AsyncGenerator[dict[str, str], None]],
) -> EventSourceResponse:
    """Admit before sending headers; web leases end before the Next timeout."""
    proxied = request.headers.get(streams.STREAM_PROXY_HEADER) == streams.STREAM_PROXY_VALUE
    lifetime = streams.stream_lifetime_seconds(streams.PROTOCOL_V1, proxied=proxied)
    lease = streams.admit_stream(user_id, streams.PROTOCOL_V1, lifetime)
    try:
        return streams.leased_event_response(content(lease), lease=lease)
    except BaseException:
        lease.release()
        raise


async def _notification_is_active(
    request: Request,
    *,
    clock: Callable[[], float],
    deadline: float,
    lease: streams.StreamLease | None,
    authorize: streams.Authorize | None,
    recheck_at: float,
    auth_recheck_seconds: float,
) -> tuple[bool, float]:
    """Revalidate the existing stream authority without extending its lifetime."""
    if clock() >= deadline or (lease is not None and lease.evicted):
        return False, recheck_at
    if await request.is_disconnected():
        return False, recheck_at
    if authorize is not None and clock() >= recheck_at:
        try:
            await asyncio.wait_for(authorize(), max(0, deadline - clock()))
        except HTTPException:
            return False, recheck_at
        recheck_at = clock() + auth_recheck_seconds
    return clock() < deadline and not (lease is not None and lease.evicted), recheck_at


async def notification_events(
    user_id: str,
    request: Request,
    *,
    lease: streams.StreamLease | None = None,
    authorize: streams.Authorize | None = None,
    backfill: Backfill | None = None,
    snapshot_resets: bool = False,
    heartbeat_seconds: float = 30,
    lifetime_seconds: float | None = None,
    auth_recheck_seconds: float = streams.FEED_AUTH_RECHECK_SECONDS,
) -> AsyncGenerator[dict[str, Any] | None, None]:
    """Yield notifications, or None for a heartbeat, while the owner remains valid.

    Subscribe before backfill, check deadlines even on busy queues, and release
    both subscription and admission on expiry, eviction, cancellation or failure.
    """
    from api import consent_listener

    # Admission uses time.monotonic; keep the same clock under uvloop too.
    clock = time.monotonic
    started = clock()
    lifetime = lifetime_seconds
    if lifetime is None:
        lifetime = lease.lifetime_seconds if lease else streams.stream_lifetime_seconds(1)
    deadline = (lease.opened_at if lease else started) + lifetime
    recheck_at = started + auth_recheck_seconds
    heartbeat_at = started + heartbeat_seconds
    queue: asyncio.Queue[Any] | None = None

    async def active() -> bool:
        nonlocal recheck_at
        admitted, recheck_at = await _notification_is_active(
            request,
            clock=clock,
            deadline=deadline,
            lease=lease,
            authorize=authorize,
            recheck_at=recheck_at,
            auth_recheck_seconds=auth_recheck_seconds,
        )
        return admitted

    try:
        subscription: asyncio.Queue[Any] = await asyncio.wait_for(
            (
                consent_listener.subscribe_consent_queue(user_id, snapshot_resets=True)
                if snapshot_resets
                else consent_listener.subscribe_consent_queue(user_id)
            ),
            max(0, deadline - clock()),
        )
        queue = subscription
        if lease is not None:
            lease.queue = queue
        if not await active():
            return
        if backfill is not None:
            events = await asyncio.wait_for(backfill(), max(0, deadline - clock()))
            for event in events:
                if not await active():
                    return
                yield event
        while await active():
            now = clock()
            wake_at = min(deadline, heartbeat_at)
            if authorize is not None:
                wake_at = min(wake_at, recheck_at)
            try:
                event = await asyncio.wait_for(subscription.get(), max(0, wake_at - now))
            except TimeoutError:
                if not await active():
                    return
                if clock() >= heartbeat_at:
                    heartbeat_at = clock() + heartbeat_seconds
                    yield None
                continue
            if event.get("type") == streams.EVICT_EVENT_TYPE or not await active():
                return
            yield event
    except TimeoutError:
        return
    finally:
        if lease is not None:
            lease.release()
        if queue is not None:
            await consent_listener.unsubscribe_consent_queue(user_id, queue)
