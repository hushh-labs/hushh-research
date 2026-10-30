import json
from types import SimpleNamespace

import pytest

from api import consent_listener
from api.routes import sse as sse_routes
from api.routes.sse import (
    _sse_event_id,
    _sse_payload_from_event_payload,
    consent_event_generator,
    document_feed_event_generator,
)
from hushh_mcp.services.consent_db import ConsentDBService


@pytest.mark.asyncio
async def test_document_feed_stream_rejects_another_users_token(monkeypatch):
    from fastapi import HTTPException

    assert any(
        route.path == "/api/consent/document-feed/{user_id}" for route in sse_routes.router.routes
    )
    monkeypatch.setattr(sse_routes, "verify_firebase_bearer", lambda _authorization: "other")
    with pytest.raises(HTTPException) as exc:
        await sse_routes.document_feed_events(
            "requester", SimpleNamespace(), authorization="Bearer token"
        )
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_document_feed_stream_resets_then_sends_only_opaque_committed_doorbell(monkeypatch):
    import asyncio

    request_id = "11111111-2222-4333-8444-555555555555"
    event_id = "22222222-3333-4444-8555-666666666666"
    queue: asyncio.Queue = asyncio.Queue()
    unsubscribed = []

    async def subscribe(_user_id, *, snapshot_resets=False):
        assert snapshot_resets
        return queue

    async def unsubscribe(user_id, subscribed):
        unsubscribed.append((user_id, subscribed))

    monkeypatch.setattr(consent_listener, "subscribe_consent_queue", subscribe)
    monkeypatch.setattr(consent_listener, "unsubscribe_consent_queue", unsubscribe)
    request = SimpleNamespace(is_disconnected=lambda: asyncio.sleep(0, result=False))
    stream = document_feed_event_generator("requester", request)
    assert (await anext(stream))["event"] == "feed_reset"

    queue.put_nowait({"type": "location_settings_changed", "setting": "auto_approve"})
    queue.put_nowait(
        {
            "type": "document_share_feed_changed",
            "event_id": event_id,
            "request_id": request_id,
            "file_name": "private.pdf",
            "provider_token": "never-send-this",
        }
    )
    changed = await asyncio.wait_for(anext(stream), timeout=1)
    assert changed == {
        "event": "feed_changed",
        "id": event_id,
        "data": json.dumps({"request_id": request_id}),
    }
    await stream.aclose()
    assert unsubscribed == [("requester", queue)]


@pytest.mark.asyncio
async def test_bank_payout_doorbell_resets_owner_feed_without_request_attribution(monkeypatch):
    import asyncio

    queue: asyncio.Queue = asyncio.Queue()

    async def subscribe(_user_id, *, snapshot_resets=False):
        assert snapshot_resets
        return queue

    async def unsubscribe(_user_id, _queue):
        return None

    monkeypatch.setattr(consent_listener, "subscribe_consent_queue", subscribe)
    monkeypatch.setattr(consent_listener, "unsubscribe_consent_queue", unsubscribe)
    assert consent_listener._is_user_state_event_type("bank_payout_changed")
    request = SimpleNamespace(is_disconnected=lambda: asyncio.sleep(0, result=False))
    stream = document_feed_event_generator("owner", request)
    assert (await anext(stream)) == {"event": "feed_reset", "data": "{}"}
    # One redemption rings three doorbells (old untyped and new typed shapes).
    queue.put_nowait({"type": "bank_payout_changed", "user_id": "owner"})
    queue.put_nowait({"type": "bank_payout_changed", "user_id": "owner", "kinds": ["wallet"]})
    queue.put_nowait(
        {
            "type": "bank_payout_changed",
            "user_id": "owner",
            "kinds": ["earnings", "wallet"],
            "request_id": "11111111-2222-4333-8444-555555555555",
        }
    )

    async def rest():
        return [frame async for frame in stream]

    # v1 clients get one untyped reset per burst, then the long-poll closes so a
    # buffering native build receives it and frees its backend slot.
    assert await asyncio.wait_for(rest(), timeout=3) == [{"event": "feed_reset", "data": "{}"}]


def test_sse_payload_includes_enriched_request_fields():
    payload = _sse_payload_from_event_payload(
        {
            "request_id": "req_123",
            "action": "REQUESTED",
            "scope": "attr.financial.*",
            "agent_id": "developer:demo",
            "scope_description": "Financial Data",
            "issued_at": 1234567890,
            "metadata": {
                "requester_label": "Codex Local Workspace",
                "requester_image_url": "https://example.com/logo.png",
                "requester_website_url": "https://example.com",
                "reason": "Portfolio insights",
                "expiry_hours": 24,
                "approval_timeout_minutes": 5,
                "approval_timeout_at": 1234569999,
            },
        }
    )

    assert payload["request_id"] == "req_123"
    assert payload["request_url"].endswith("/one/consent?tab=pending&requestId=req_123")
    assert payload["deep_link"] == "/one/consent?tab=pending&requestId=req_123"
    assert payload["requester_label"] == "Codex Local Workspace"
    assert payload["requester_image_url"] == "https://example.com/logo.png"
    assert payload["requester_website_url"] == "https://example.com"
    assert payload["reason"] == "Portfolio insights"
    assert payload["expiry_hours"] == 24
    assert payload["approval_timeout_minutes"] == 5
    assert payload["approval_timeout_at"] == 1234569999


def test_connection_removed_sse_keeps_its_type_and_delivery_identity():
    event = {
        "type": "connection_removed",
        "message_id": "connection-removed:conn-1:episode-2:user-b",
        "connection_id": "conn-1",
        "action": "REMOVED",
    }

    assert _sse_event_id(event) == event["message_id"]
    assert _sse_payload_from_event_payload(event) == event


def test_circle_sse_keeps_its_type_transition_id_and_reconciliation_context():
    event = {
        "type": "location_circle_deleted",
        "user_id": "member-1",
        "message_id": "location_circle_deleted:event-1",
        "circle_id": "circle-1",
        "circle_name": "Family",
        "request_url": "/one/location?tab=people",
    }

    assert _sse_event_id(event) == event["message_id"]
    assert _sse_payload_from_event_payload(event) == event


@pytest.mark.parametrize(
    "event",
    [
        {
            "type": "location_settings_changed",
            "user_id": "member-1",
            "setting": "map_preferences",
            "sync_only": "true",
            "message_id": "location_settings_changed:event-1",
        },
        {
            "type": "location_pkm_changed",
            "user_id": "member-1",
            "domain": "location",
            "data_version": "7",
            "updated_at": "2026-09-20T00:00:00+00:00",
            "sync_only": "true",
            "message_id": "location_pkm_changed:event-2",
        },
    ],
)
def test_location_supporting_data_sse_preserves_metadata_doorbells(event):
    assert _sse_event_id(event) == event["message_id"]
    assert _sse_payload_from_event_payload(event) == event


@pytest.mark.asyncio
async def test_user_state_publisher_accepts_supporting_data_doorbells(monkeypatch):
    published: list[tuple[str, str, str]] = []

    class Connection:
        async def execute(self, sql, channel, payload):
            published.append((sql, channel, payload))

    class Pool:
        async def acquire(self):
            return Connection()

        async def release(self, _connection):
            return None

    async def get_pool():
        return Pool()

    monkeypatch.setattr("db.connection.get_pool", get_pool)

    accepted = await consent_listener._publish_user_state_event(
        "member-1",
        {
            "type": "location_settings_changed",
            "setting": "auto_approve",
            "sync_only": "true",
            "message_id": "location_settings_changed:event-1",
        },
    )

    assert accepted is True
    assert len(published) == 1
    _sql, channel, serialized = published[0]
    assert channel == consent_listener.USER_STATE_CHANNEL
    assert json.loads(serialized) == {
        "type": "location_settings_changed",
        "setting": "auto_approve",
        "sync_only": "true",
        "message_id": "location_settings_changed:event-1",
        "user_id": "member-1",
    }


@pytest.mark.asyncio
async def test_user_state_publisher_rejects_unrelated_event_types(monkeypatch):
    async def fail_if_called():
        raise AssertionError("unrelated events must not reach the shared state channel")

    monkeypatch.setattr("db.connection.get_pool", fail_if_called)

    accepted = await consent_listener._publish_user_state_event(
        "member-1",
        {"type": "unrelated_event", "message_id": "event-1"},
    )

    assert accepted is False


@pytest.mark.asyncio
async def test_consent_sse_unsubscribes_its_private_queue_on_disconnect(monkeypatch):
    queue = object()
    calls: list[tuple] = []

    async def subscribe(user_id):
        calls.append(("subscribe", user_id))
        return queue

    async def unsubscribe(user_id, subscribed_queue):
        calls.append(("unsubscribe", user_id, subscribed_queue))

    async def no_recent_events(self, **kwargs):
        return []

    monkeypatch.setattr(consent_listener, "subscribe_consent_queue", subscribe)
    monkeypatch.setattr(consent_listener, "unsubscribe_consent_queue", unsubscribe)
    monkeypatch.setattr(ConsentDBService, "get_recent_consent_events", no_recent_events)

    request = SimpleNamespace(is_disconnected=lambda: _return_true())
    events = [event async for event in consent_event_generator("member-1", request)]

    assert events == []
    assert calls == [
        ("subscribe", "member-1"),
        ("unsubscribe", "member-1", queue),
    ]


async def _return_true():
    return True


@pytest.mark.asyncio
async def test_general_feed_hint_and_listener_gap_only_emit_snapshot_metadata():
    import asyncio

    request = SimpleNamespace(is_disconnected=lambda: asyncio.sleep(0, result=False))
    stream = document_feed_event_generator("feed-owner", request)
    assert (await anext(stream))["event"] == "feed_reset"
    await consent_listener._push_to_consent_queue(
        "feed-owner", {"type": "feed_changed", "private_content": "must-not-escape"}
    )
    assert await anext(stream) == {"event": "feed_changed", "data": "{}"}
    await consent_listener.broadcast_local_resync()
    assert await anext(stream) == {"event": "feed_reset", "data": "{}"}
    await stream.aclose()
    assert "feed-owner" not in consent_listener._consent_notify_queues


@pytest.mark.asyncio
@pytest.mark.parametrize("busy", [False, True])
async def test_feed_stream_revalidates_shared_authority_even_with_busy_queue(monkeypatch, busy):
    import asyncio

    from fastapi import HTTPException

    calls = []

    def denied(token):
        calls.append(token)
        raise HTTPException(status_code=401, detail="expired")

    monkeypatch.setattr(sse_routes, "verify_firebase_bearer", denied)
    monkeypatch.setattr(sse_routes, "FEED_AUTH_RECHECK_SECONDS", 0 if busy else 0.01)
    request = SimpleNamespace(is_disconnected=lambda: asyncio.sleep(0, result=False))
    stream = document_feed_event_generator("expired-owner", request, authorization="Bearer expired")
    assert (await anext(stream))["event"] == "feed_reset"
    if busy:
        for _ in range(110):
            await consent_listener._push_to_consent_queue("expired-owner", {"type": "feed_changed"})
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(anext(stream), timeout=1)
    assert calls == ["Bearer expired"]
    assert "expired-owner" not in consent_listener._consent_notify_queues


@pytest.mark.asyncio
async def test_feed_stream_finite_lifetime_does_not_depend_on_idle_queue(monkeypatch):
    import asyncio

    monkeypatch.setattr(sse_routes, "FEED_STREAM_LIFETIME_SECONDS", 0)
    request = SimpleNamespace(is_disconnected=lambda: asyncio.sleep(0, result=False))
    stream = document_feed_event_generator("finite-owner", request)
    assert (await anext(stream))["event"] == "feed_reset"
    await consent_listener._push_to_consent_queue("finite-owner", {"type": "feed_changed"})
    with pytest.raises(StopAsyncIteration):
        await anext(stream)
    assert "finite-owner" not in consent_listener._consent_notify_queues


@pytest.mark.asyncio
async def test_feed_overflow_resets_without_erasing_legacy_consent_events(monkeypatch):
    import asyncio

    async def backfill(self, **kwargs):
        return [{"request_id": "initial", "action": "REQUESTED"}]

    async def connected():
        # Queue retention is the contract here, not scheduler responsiveness
        # while repeatedly yielding a synthetic disconnect probe under xdist.
        return False

    monkeypatch.setattr(ConsentDBService, "get_recent_consent_events", backfill)
    request = SimpleNamespace(is_disconnected=connected)
    feed = document_feed_event_generator("mixed-owner", request)
    legacy = consent_event_generator("mixed-owner", request)
    try:
        assert (await anext(feed))["event"] == "feed_reset"
        assert (await anext(legacy))["id"] == "initial"
        for index in range(101):
            await consent_listener._push_to_consent_queue(
                "mixed-owner", {"request_id": f"request-{index}", "action": "REQUESTED"}
            )
        for _ in range(120):
            await consent_listener._push_to_consent_queue("mixed-owner", {"type": "feed_changed"})
        await consent_listener.broadcast_local_resync()
        subscriptions = consent_listener._consent_notify_queues["mixed-owner"]
        assert len(subscriptions) == 2
        legacy_queue = next(queue for queue in subscriptions if type(queue) is asyncio.Queue)
        assert legacy_queue.qsize() == 100
        # The legacy subscriber retains its newest 100 actionable events,
        # unaffected by opaque Feed hints or the listener reconnect reset.
        events = [await asyncio.wait_for(anext(legacy), timeout=1) for _ in range(100)]
        assert [event["id"] for event in events] == [f"request-{i}" for i in range(1, 101)]
        assert (await asyncio.wait_for(anext(feed), timeout=1))["event"] == "feed_reset"
        assert (await asyncio.wait_for(anext(feed), timeout=1))["event"] == "feed_changed"
    finally:
        await feed.aclose()
        await legacy.aclose()
    assert "mixed-owner" not in consent_listener._consent_notify_queues


@pytest.mark.asyncio
async def test_feed_response_times_out_blocked_send_and_releases_subscription(monkeypatch):
    import asyncio

    from sse_starlette.sse import SendTimeoutError

    monkeypatch.setattr(
        sse_routes, "verify_firebase_bearer", lambda _authorization: "stalled-owner"
    )
    monkeypatch.setattr(sse_routes, "FEED_SEND_TIMEOUT_SECONDS", 0.01)
    request = SimpleNamespace(is_disconnected=lambda: asyncio.sleep(0, result=False))
    response = await sse_routes.document_feed_events(
        "stalled-owner", request, authorization="Bearer synthetic-token"
    )
    blocked = asyncio.Event()
    body_started = False

    async def send(message):
        nonlocal body_started
        if message["type"] == "http.response.body":
            body_started = True
            assert "stalled-owner" in consent_listener._consent_notify_queues
            await blocked.wait()

    async def receive():
        await blocked.wait()
        return {"type": "http.disconnect"}

    with pytest.raises(ExceptionGroup) as failure:
        await asyncio.wait_for(response({"type": "http"}, receive, send), timeout=1)
    assert failure.value.subgroup(SendTimeoutError) is not None
    assert body_started
    assert "stalled-owner" not in consent_listener._consent_notify_queues
