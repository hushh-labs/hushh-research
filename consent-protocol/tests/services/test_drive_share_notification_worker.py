"""Real PostgreSQL leases for generic Drive-share notification delivery."""

# ruff: noqa: F811 -- shared isolated PostgreSQL fixtures.

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import text

from hushh_mcp.services.drive_share_notification_store import DriveShareNotificationStore
from hushh_mcp.services.drive_share_notification_worker import (
    DriveShareNotificationWorker,
    notification_payload,
)
from tests.services.test_drive_sharing_store import (  # noqa: F401
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    request,
    rows,
    sharing,
)

MIGRATIONS = Path(__file__).resolve().parents[2] / "db" / "migrations"


@pytest.fixture
async def notification_store(sharing):
    with sharing.db.engine.begin() as connection:
        migration = text((MIGRATIONS / "235_drive_share_notification_outbox.sql").read_text())
        connection.execute(migration)
        # Release migrations must remain replayable in an already-provisioned
        # environment, including after all constraints/indexes exist.
        connection.execute(migration)
    return DriveShareNotificationStore(db=sharing.db)


def event(store):
    return rows(store, "drive_share_events")[0]


def make_due(store, event_id):
    with store.db.engine.begin() as connection:
        connection.execute(
            text("""
            UPDATE drive_share_events
            SET notification_next_attempt_at=clock_timestamp()-INTERVAL '1 second'
            WHERE event_id=:event
            """),
            {"event": event_id},
        )


@pytest.mark.asyncio
async def test_document_event_push_is_opaque_deduped_and_settled_as_dispatch_only(
    sharing, notification_store
):
    await request(sharing)
    before = event(notification_store)
    send = MagicMock(return_value=1)

    result = await DriveShareNotificationWorker(notification_store, send_push=send).run()

    assert result == {
        "schema_version": "drive.share_notifications.worker.v1",
        "outcomes": {"settled": 1},
    }
    send.assert_called_once()
    args, kwargs = send.call_args
    assert args == ("owner",)
    assert kwargs == {
        "notification_type": "document_share_request",
        "notification_tag": f"drive-share-event:{before['event_id']}",
        "data": {
            "type": "document_share_request",
            "request_id": str(before["request_id"]),
            "event_id": str(before["event_id"]),
            "message_id": f"drive-share-event:{before['event_id']}",
        },
        # The generic FCM adapter requires presentation/link arguments. They
        # are fixed fallbacks, never a dynamic request/provider URL; the client
        # derives its review route from the closed type + opaque UUID above.
        "title": "Document request",
        "body": "Open One to review.",
        "deep_link": "/one/feed",
        "notification_category": "ONE_DOCUMENT_SHARING",
        "show_alert": True,
        "include_user_id": False,
    }
    # The store leaves encrypted request data unopened; the generic outbound
    # payload contains neither identity/provider metadata nor document details.
    serialized = json.dumps(kwargs, sort_keys=True)
    for private in ("Private six-month", "recipient@example.invalid", "1234567"):
        assert private not in serialized
    assert "document_share_request" in serialized
    assert str(before["request_id"]) in serialized

    after = event(notification_store)
    assert after["notification_state"] == "settled"
    assert after["notification_settled_at"] is not None
    assert after["delivered_at"] is not None
    assert after["notification_lease_id"] is None
    assert after["notification_attempt_count"] == 1
    # A settled record is an attempted generic push handoff, not a device/user
    # receipt. A later drain cannot duplicate the event-id tag.
    assert (await DriveShareNotificationWorker(notification_store, send_push=send).run())[
        "outcomes"
    ] == {}
    send.assert_called_once()


@pytest.mark.asyncio
async def test_feature_disabled_inspects_but_never_claims_or_dispatches(
    sharing, notification_store, monkeypatch
):
    await request(sharing)
    monkeypatch.setenv("DRIVE_DOCUMENT_SHARING", "false")
    send = MagicMock(return_value=1)

    result = await DriveShareNotificationWorker(notification_store, send_push=send).run()

    assert result == {
        "schema_version": "drive.share_notifications.worker.v1",
        "outcomes": {"disabled": 1},
    }
    assert event(notification_store)["notification_state"] == "queued"
    send.assert_not_called()


@pytest.mark.asyncio
async def test_concurrent_workers_claim_one_event_once(sharing, notification_store):
    await request(sharing)
    send = MagicMock(return_value=1)
    first = DriveShareNotificationWorker(notification_store, send_push=send)
    second = DriveShareNotificationWorker(notification_store, send_push=send)

    await asyncio.gather(first.run(), second.run())

    send.assert_called_once()
    assert event(notification_store)["notification_state"] == "settled"


@pytest.mark.asyncio
async def test_expired_lease_is_recovered_without_a_stale_worker_settling_new_work(
    sharing, notification_store
):
    await request(sharing)
    before = event(notification_store)
    old = await notification_store.claim(event_id=str(before["event_id"]))
    assert old is not None
    with notification_store.db.engine.begin() as connection:
        connection.execute(
            text("""
            UPDATE drive_share_events
            SET notification_lease_expires_at=clock_timestamp()-INTERVAL '1 second'
            WHERE event_id=:event
            """),
            {"event": before["event_id"]},
        )

    new = await notification_store.claim(event_id=str(before["event_id"]))
    assert new is not None and new["notification_lease_id"] != old["notification_lease_id"]
    assert not await notification_store.settle(old)
    assert await notification_store.settle(new)

    after = event(notification_store)
    assert after["notification_state"] == "settled"
    assert after["notification_attempt_count"] == 2


@pytest.mark.asyncio
async def test_dispatch_failures_retry_with_a_bound_then_settle_unavailable(
    sharing, notification_store
):
    await request(sharing)
    initial = event(notification_store)
    send = MagicMock(side_effect=RuntimeError("synthetic transport failure"))
    worker = DriveShareNotificationWorker(notification_store, send_push=send)

    for attempt in range(1, 4):
        result = await worker.run()
        current = event(notification_store)
        if attempt < 3:
            assert result["outcomes"] == {"retry_scheduled": 1}
            assert current["notification_state"] == "queued"
            assert current["notification_settled_at"] is None
            assert current["notification_error_code"] == "notification_unavailable"
            make_due(notification_store, initial["event_id"])
        else:
            assert result["outcomes"] == {"settled_unavailable": 1}
            assert current["notification_state"] == "settled"
            assert current["notification_settled_at"] is not None
            assert current["delivered_at"] is not None
            assert current["notification_error_code"] == "notification_unavailable"
        assert current["notification_attempt_count"] == attempt
    assert send.call_count == 3
    assert (await worker.run())["outcomes"] == {}


def test_payload_refuses_nonopaque_event_or_request_identifiers():
    with pytest.raises(ValueError):
        notification_payload(
            {
                "event_id": "not-an-event",
                "request_id": "not-a-request",
                "event_type": "document_share_request",
            }
        )


def test_payload_suppresses_unreviewed_event_types():
    assert (
        notification_payload(
            {
                "event_id": "11111111-1111-4111-8111-111111111111",
                "request_id": "22222222-2222-4222-8222-222222222222",
                "event_type": "document_share_unreviewed_future_event",
            }
        )
        is None
    )


@pytest.mark.asyncio
async def test_unreviewed_event_type_is_suppressed_before_the_push_adapter_is_called():
    store = SimpleNamespace(suppress=AsyncMock(return_value=True))
    send = MagicMock()
    worker = DriveShareNotificationWorker(store=store, send_push=send)
    job = {
        "event_id": "11111111-1111-4111-8111-111111111111",
        "request_id": "22222222-2222-4222-8222-222222222222",
        "event_type": "document_share_unreviewed_future_event",
        "user_id": "opaque-user",
        "notification_lease_id": "33333333-3333-4333-8333-333333333333",
    }

    assert await worker._dispatch(job) == "suppressed"
    store.suppress.assert_awaited_once_with(job)
    send.assert_not_called()


@pytest.mark.asyncio
async def test_zero_push_delivery_is_retried_not_falsely_settled():
    store = SimpleNamespace(retry=AsyncMock(return_value="retry_scheduled"), settle=AsyncMock())
    send = MagicMock(return_value=0)
    worker = DriveShareNotificationWorker(store=store, send_push=send)
    job = {
        "event_id": "11111111-1111-4111-8111-111111111111",
        "request_id": "22222222-2222-4222-8222-222222222222",
        "event_type": "document_share_request",
        "user_id": "opaque-user",
        "notification_lease_id": "33333333-3333-4333-8333-333333333333",
    }

    assert await worker._dispatch(job) == "retry_scheduled"
    store.retry.assert_awaited_once_with(job)
    store.settle.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bounds",
    [{"max_jobs": 0}, {"max_jobs": 21}, {"max_jobs": True}, {"deadline_seconds": 541}],
)
async def test_notification_worker_bounds_are_enforced(bounds):
    worker = DriveShareNotificationWorker(DriveShareNotificationStore(db=MagicMock()))
    with pytest.raises(ValueError, match="invalid worker bounds"):
        await worker.run(**bounds)


def test_every_surface_shares_one_type_list_and_the_same_words():
    """The backend worker, the web worker and the app must agree, or a new type
    is silently dropped on one surface (five hard-coded lists before 244)."""
    import re

    from hushh_mcp.services.drive_share_notification_worker import (
        DOCUMENT_SHARE_NOTIFICATION_COPY,
    )

    web = Path(__file__).resolve().parents[3] / "hushh-webapp"
    for relative in ("public/firebase-messaging-sw.js", "lib/consent/document-share-consent.ts"):
        source = (web / relative).read_text()
        allowlist = re.search(
            r"DOCUMENT_SHARE_NOTIFICATION_TYPES = new Set\(\[(.*?)\]\)", source, re.S
        )
        assert allowlist, relative
        assert set(re.findall(r'"(document_share_[a-z_]+)"', allowlist.group(1))) == set(
            DOCUMENT_SHARE_NOTIFICATION_COPY
        ), relative
        for title, body in DOCUMENT_SHARE_NOTIFICATION_COPY.values():
            assert f'"{title}"' in source and f'"{body}"' in source, (relative, title)


@pytest.mark.asyncio
async def test_a_dispatch_logs_counts_only(caplog, monkeypatch):
    import logging

    event_id = "11111111-1111-4111-8111-111111111111"
    request_id = "22222222-2222-4222-8222-222222222222"
    job = {
        "event_id": event_id,
        "request_id": request_id,
        "event_type": "document_share_question",
        "user_id": "opaque-user",
        "notification_lease_id": "33333333-3333-4333-8333-333333333333",
    }
    store = SimpleNamespace(
        due=AsyncMock(side_effect=[[{"event_id": event_id, "user_id": "opaque-user"}], []]),
        claim=AsyncMock(return_value=job),
        settle=AsyncMock(return_value=True),
    )
    monkeypatch.setattr(
        "hushh_mcp.services.drive_share_notification_worker.connector_feature_enabled",
        lambda *_: True,
    )
    with caplog.at_level(logging.INFO):
        await DriveShareNotificationWorker(store, send_push=MagicMock(return_value=1)).run()
    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert "drive_notify.run settled=1" in logged
    assert "opaque-user" not in logged and event_id not in logged and request_id not in logged
