import json
from types import SimpleNamespace

import pytest

from api import consent_listener
from api.routes.sse import (
    _sse_event_id,
    _sse_payload_from_event_payload,
    consent_event_generator,
)
from hushh_mcp.services.consent_db import ConsentDBService


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
