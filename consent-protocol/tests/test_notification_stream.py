"""Shared notification streams retain bounded owner authority and release every lease."""

from types import SimpleNamespace

import pytest

from api import consent_listener
from api.routes import sse as sse_routes
from api.routes.sse import consent_event_generator
from hushh_mcp.services.consent_db import ConsentDBService


@pytest.mark.asyncio
@pytest.mark.parametrize("busy", [False, True])
@pytest.mark.parametrize("expired_authority", [False, True])
async def test_consent_stream_bounds_busy_and_idle_connections(
    monkeypatch, busy, expired_authority
):
    """Neither a quiet connection nor constant notifications can retain a slot forever."""
    import asyncio

    from fastapi import HTTPException

    queue = asyncio.Queue()
    if busy:
        for index in range(100):
            queue.put_nowait({"request_id": str(index), "action": "REQUESTED"})
    unsubscribed = []
    checked = []

    async def subscribe(_user_id):
        return queue

    async def unsubscribe(user_id, owned_queue):
        unsubscribed.append((user_id, owned_queue))

    async def backfill(self, **_kwargs):
        return [{"request_id": "backfill", "action": "REQUESTED"}]

    async def verify():
        checked.append(True)
        if expired_authority:
            raise HTTPException(401, "expired")

    monkeypatch.setattr(consent_listener, "subscribe_consent_queue", subscribe)
    monkeypatch.setattr(consent_listener, "unsubscribe_consent_queue", unsubscribe)
    monkeypatch.setattr(ConsentDBService, "get_recent_consent_events", backfill)
    monkeypatch.setattr(sse_routes, "_owner_recheck", lambda *_args: verify)
    request = SimpleNamespace(is_disconnected=lambda: asyncio.sleep(0, result=False))
    admission = sse_routes.feed_stream.StreamAdmission()
    lease = admission.admit("owner", 1, 0.5)
    stream = consent_event_generator(
        "owner", request, lease=lease, authorization="Bearer token", auth_recheck_seconds=0
    )

    async def consume():
        return [frame async for frame in stream]

    frames = await asyncio.wait_for(consume(), timeout=2)
    assert checked
    if expired_authority:
        assert frames == []  # Not even backfill may escape expired authority.
    else:
        assert frames[0]["id"] == "backfill"
        assert all(frame["event"] == "consent_update" for frame in frames)
    assert unsubscribed == [("owner", queue)]
    assert admission.active() == []


@pytest.mark.asyncio
async def test_notification_routes_share_feed_admission_and_eviction_cleanup(monkeypatch):
    import asyncio

    from fastapi import HTTPException

    from api.routes.one import messages

    admission = sse_routes.feed_stream.StreamAdmission(per_user=1, per_worker=1)
    monkeypatch.setattr(sse_routes.feed_stream, "_ADMISSION", admission)
    monkeypatch.setattr(sse_routes, "verify_firebase_bearer", lambda _token: "owner")
    monkeypatch.setenv("CONSENT_WEB_FALLBACK_ENABLED", "true")

    async def backfill(self, **_kwargs):
        return [{"request_id": "backfill", "action": "REQUESTED"}]

    monkeypatch.setattr(ConsentDBService, "get_recent_consent_events", backfill)
    request = SimpleNamespace(
        headers={"X-Hussh-Stream-Via": "next-proxy"},
        is_disconnected=lambda: asyncio.sleep(0, result=False),
    )
    response = await sse_routes.consent_events("owner", request, authorization="Bearer token")
    lease = admission.active()[0]
    assert 90 <= lease.lifetime_seconds <= 110
    assert (await anext(response.body_iterator))["id"] == "backfill"
    with pytest.raises(HTTPException) as exc:
        sse_routes.feed_stream.open_document_feed_stream("other", request, version=2)
    assert exc.value.status_code == 503
    assert exc.value.headers["Retry-After"] == "60"

    replacement = await messages._events_response(request, "owner")
    assert lease.evicted
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(anext(response.body_iterator), timeout=1)
    assert "owner" not in consent_listener._consent_notify_queues

    # A failed ASGI send must release even a body that never started.
    async def receive():
        return {"type": "http.disconnect"}

    async def send(_message):
        raise OSError("disconnected before headers")

    with pytest.raises((OSError, BaseExceptionGroup)):
        await replacement({"type": "http"}, receive, send)
    assert admission.active() == []

    # Also close a generator already suspended at yield: releasing accounting
    # alone would leave its listener queue registered after a failed body send.
    for disconnect in (False, True):
        response = await sse_routes.consent_events("owner", request, authorization="Bearer token")
        body_started = asyncio.Event()

        async def receive_after_body(event=body_started, disconnected=disconnect):
            await event.wait()
            if not disconnected:
                await asyncio.Event().wait()
            return {"type": "http.disconnect"}

        async def send_body(message, event=body_started, disconnected=disconnect):
            if message["type"] == "http.response.body" and message.get("body"):
                event.set()
                if disconnected:
                    await asyncio.Event().wait()
                raise OSError("body send failed")

        if disconnect:
            await asyncio.wait_for(response({"type": "http"}, receive_after_body, send_body), 2)
        else:
            with pytest.raises((OSError, BaseExceptionGroup)):
                await asyncio.wait_for(response({"type": "http"}, receive_after_body, send_body), 2)
        assert body_started.is_set()
        assert "owner" not in consent_listener._consent_notify_queues
        assert admission.active() == []
