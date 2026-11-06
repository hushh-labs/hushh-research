"""Frozen-clock complete-mail follow-up lifecycle on disposable PostgreSQL."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

import httpx
import pytest
from fastapi import Response
from sqlalchemy import text

from api.routes.one import calendar_email_followups as routes
from db.db_client import DatabaseClient
from hushh_mcp.services import calendar_email_followup_extraction as extraction
from hushh_mcp.services import calendar_email_followup_reminders as reminders
from hushh_mcp.services import calendar_email_followup_scan as scan
from hushh_mcp.services import system_push_delivery
from hushh_mcp.services.calendar_email_followup_reconcile import reconcile_candidates
from hushh_mcp.services.calendar_email_followup_store import CalendarEmailFollowupStore
from hushh_mcp.services.feed_service import FeedService
from tests.google_oauth_postgres_support import OWNER
from tests.services.calendar_email_followup_jhumma_fakes import (
    CORRECTION_QUOTE,
    DOCUMENT_QUOTE,
    MEETING_QUOTE,
    _mock_messages,
    _response,
)
from tests.services.test_calendar_email_followup_oauth_postgres import (
    _add_calendar,
    _connect_mail,
)
from tests.services.test_calendar_email_followup_oauth_postgres import (
    followup_pg as followup_pg,
)
from tests.services.test_external_connector_lifecycle_postgres import (
    connector_postgres_url as connector_postgres_url,
)


def _candidate(index: int, section: str, quote: str, **fields):
    """A model candidate for ``quote`` with the fields every case here shares."""
    return {
        "local_index": fields.pop("local_index", 0),
        "section_index": index,
        "quote_start": section.index(quote),
        "source_quote": quote,
        "responsibility": "owner",
        "time_zone": "Asia/Kolkata",
        "ambiguities": [],
        "relevance": "actionable",
        **fields,
    }


async def _synthetic_gene(**kwargs):
    prompt = __import__("json").loads(kwargs["prompt"])
    section = prompt["section_text"]
    index = prompt["section_index"]
    candidates = []
    updates = []
    if DOCUMENT_QUOTE in section:
        candidates.append(
            _candidate(
                index,
                section,
                DOCUMENT_QUOTE,
                kind="deadline",
                title="Send the research document",
                original_due_wording="before 26 October",
                due_date="2026-10-26",
                due_relation="before",
                category="deliverable_deadline",
                urgency="time_bound",
                evidence_reason="The sender asks the owner to send a document by a date.",
            )
        )
        candidates.append(
            _candidate(
                index,
                section,
                MEETING_QUOTE,
                local_index=1,
                kind="meeting",
                title="Call with Jhumma",
                original_due_wording="on 27 October",
                proposed_date="2026-10-27",
                ambiguities=["time", "duration"],
                category="meeting_request",
                meeting_state="proposed",
                evidence_reason="The sender proposes a call on a specific day.",
            )
        )
    if CORRECTION_QUOTE in section:
        prior = next(
            item
            for item in prompt["prior_requests"]
            if item["title"] == "Send the research document"
        )
        updates.append(
            {
                "section_index": index,
                "quote_start": section.index(CORRECTION_QUOTE),
                "source_quote": CORRECTION_QUOTE,
                "target_request_id": prior["request_id"],
                "outcome": "corrected",
                "explanation": "The deadline moved two days later.",
            }
        )
        candidates.append(
            _candidate(
                index,
                section,
                CORRECTION_QUOTE,
                kind="deadline",
                title="Send the research document",
                original_due_wording="by 28 October",
                due_date="2026-10-28",
                due_relation="by",
                category="deliverable_deadline",
                urgency="time_bound",
                evidence_reason="The sender moves the document deadline to a new date.",
            )
        )
    return {"candidates": candidates, "updates": updates, "overflow": False}


async def _assess_with_synthetic_model(**kwargs):
    return await extraction.assess_section(**kwargs, gene_runner=_synthetic_gene)


async def _no_events(**_kwargs):
    return {"events": [], "truncated": False}


async def _reconcile_with_empty_calendar(**kwargs):
    # The owner's Calendar has nothing on the proposed day, so the proposal stands.
    return await reconcile_candidates(**kwargs, list_events=_no_events)


async def _scan_and_assert_initial(store, engine, selected, transport, provider):
    first = await scan.scan_once(
        user_id=OWNER,
        account_id=selected,
        store=store,
        now=datetime(2026, 10, 11, tzinfo=UTC),
        transport=transport,
        max_sections=1,
    )
    assert first["messages"] == 1
    # Reconstruct the service after the first durable checkpoint, as a worker restart would.
    restarted = CalendarEmailFollowupStore(db=SimpleNamespace(engine=engine), cipher=store.cipher)
    for _ in range(8):
        outcome = await scan.scan_once(
            user_id=OWNER,
            account_id=selected,
            store=restarted,
            now=datetime(2026, 10, 11, tzinfo=UTC),
            transport=transport,
        )
        if outcome["state"] == "complete":
            break
    assert outcome["state"] == "complete"
    listing = await restarted.list_conversations(
        await restarted.monitor(user_id=OWNER, account_id=selected)
    )
    assert listing["total_conversations"] == 1
    detail = await restarted.detail(
        await restarted.monitor(user_id=OWNER, account_id=selected),
        listing["conversations"][0]["id"],
    )
    assert len(detail["requests"]) == 2
    doc = next(item for item in detail["requests"] if item["kind"] == "deadline")
    call = next(item for item in detail["requests"] if item["kind"] == "meeting")
    assert doc["original_due_wording"] == "before 26 October"
    assert doc["reminder_at"] == "2026-10-25T03:30:00+00:00"
    assert call["proposed_date"] == "2026-10-27"
    assert call["booking_state"] == "not_booked"
    assert call["reminder_at"] is None
    assert provider["read_ids"].count("msg-jhumma") >= 1

    return restarted, listing, doc, call


async def _queue_and_assert_delivery(store, restarted, engine, selected, transport, doc, listing):
    due = datetime(2026, 10, 25, 4, tzinfo=UTC)
    with engine.begin() as connection:
        grant_current = connection.execute(
            text("""SELECT calendar_email_followup_grant_current(m)
        FROM calendar_email_followup_monitors m WHERE user_id=:owner AND account_id=:account"""),
            {"owner": OWNER, "account": selected},
        ).scalar_one()
    assert grant_current is True
    queued = await reminders.drain_due_reminders(store=restarted, now=due, transport=transport)
    assert queued["queued"] == 1, queued
    assert (await reminders.drain_due_reminders(store=store, now=due, transport=transport))[
        "queued"
    ] == 0
    with engine.begin() as connection:
        outbox = (
            connection.execute(
                text("""SELECT * FROM system_push_outbox
        WHERE source_kind='calendar_email_followup'""")
            )
            .mappings()
            .one()
        )
        assert str(outbox["source_id"]) == doc["id"]
        assert outbox["due_at"] == due
        assert (
            connection.execute(
                text("""SELECT count(*) FROM feed_events
        WHERE source_domain='calendar_email_followup'""")
            ).scalar_one()
            == 1
        )

    feed = FeedService()
    feed._db = DatabaseClient(engine=engine)
    for method in (
        "_with_counterpart_photos",
        "_with_direct_message_previews",
        "_with_wallet_card_grants",
        "_with_wallet_card_requests",
        "_with_drive_payment_status",
    ):
        setattr(feed, method, lambda _user, rows: rows)
    visible = feed.list_feed(OWNER)
    assert len(visible["items"]) == 1
    reminder_item = visible["items"][0]
    assert reminder_item["source_domain"] == "calendar_email_followup"
    assert reminder_item["event_type"] == "followup_reminder"
    assert reminder_item["metadata"] == {"account_id": selected, "request_id": doc["id"]}
    with engine.begin() as connection:
        source = system_push_delivery._source(connection, dict(outbox))
        assert source is not None
        notification = system_push_delivery._notification(connection, dict(outbox), source)
    target = urlparse(notification["request_url"])
    assert target.path == "/one/calendar"
    assert parse_qs(target.query) == {
        "followupAccount": [selected],
        "followupRequest": [doc["id"]],
    }
    assert (
        await restarted.conversation_for_request(
            await restarted.monitor(user_id=OWNER, account_id=selected),
            reminder_item["metadata"]["request_id"],
        )
        == listing["conversations"][0]["id"]
    )

    return outbox, feed


async def _correct_and_assert(
    restarted, engine, selected, transport, doc, call, listing, outbox, feed, provider
):
    provider["deleted"] = True
    assert (
        await reminders.verify_pending_push_source(
            user_id=OWNER,
            request_id=doc["id"],
            revision=int(outbox["source_revision"]),
            store=restarted,
            transport=transport,
        )
        == "unavailable"
    )
    provider["deleted"] = False

    provider["corrected"] = True
    assert (
        await reminders.verify_pending_push_source(
            user_id=OWNER,
            request_id=doc["id"],
            revision=int(outbox["source_revision"]),
            store=restarted,
            transport=transport,
        )
        == "defer"
    )
    with engine.begin() as connection:
        connection.execute(
            text("""UPDATE calendar_email_followup_monitors SET
        next_scan_at=NOW()-interval '1 minute' WHERE user_id=:owner AND account_id=:account"""),
            {"owner": OWNER, "account": selected},
        )
    for _ in range(8):
        outcome = await scan.scan_once(
            user_id=OWNER,
            account_id=selected,
            store=restarted,
            now=datetime(2026, 10, 25, 12, tzinfo=UTC),
            transport=transport,
        )
        if outcome["state"] == "complete":
            break
    assert outcome["state"] == "complete"
    detail = await restarted.detail(
        await restarted.monitor(user_id=OWNER, account_id=selected),
        listing["conversations"][0]["id"],
    )
    old = next(item for item in detail["requests"] if item["id"] == doc["id"])
    revised = next(
        item for item in detail["requests"] if item["original_due_wording"] == "by 28 October"
    )
    assert old["state"] == "cancelled" and old["reminder_at"] is None
    assert feed.list_feed(OWNER)["items"] == []
    assert revised["reminder_at"] == "2026-10-27T03:30:00+00:00"
    assert (
        next(item for item in detail["requests"] if item["id"] == call["id"])["booking_state"]
        == "not_booked"
    )
    assert (
        await reminders.verify_pending_push_source(
            user_id=OWNER,
            request_id=doc["id"],
            revision=int(outbox["source_revision"]),
            store=restarted,
            transport=transport,
        )
        == "unavailable"
    )


async def _assert_stale_retry_suppressed(restarted, engine, doc, monkeypatch):
    # A delayed outbox retry after the correction cannot publish even a live
    # in-app alert. The worker is restarted with an independent store instance.
    with engine.begin() as connection:
        connection.execute(
            text("""UPDATE system_push_outbox SET
        status='pending', due_at=NOW()-interval '1 minute',
        expires_at=NOW()+interval '1 hour' WHERE source_id=CAST(:id AS UUID)"""),
            {"id": doc["id"]},
        )
    monkeypatch.setattr(reminders, "CalendarEmailFollowupStore", lambda: restarted)
    alerts = []
    from api import consent_listener

    monkeypatch.setattr(
        consent_listener, "publish_user_state_event_threadsafe", lambda *_: alerts.append(1)
    )
    assert (
        await asyncio.to_thread(
            system_push_delivery.dispatch_system_pushes, SimpleNamespace(engine=engine)
        )
        == 1
    )
    assert alerts == []
    with engine.begin() as connection:
        assert (
            connection.execute(
                text("""SELECT status FROM system_push_outbox
        WHERE source_id=CAST(:id AS UUID)"""),
                {"id": doc["id"]},
            ).scalar_one()
            == "suppressed"
        )


async def _assert_booking_requires_confirmation(restarted, selected, call, listing, monkeypatch):
    # The meeting remains merely proposed through the reminder/correction
    # sequence. A separately confirmed Calendar event is the only booked path.
    calendar = SimpleNamespace(
        get_event=AsyncMock(
            return_value={
                "event": {"id": "synthetic-confirmed-calendar-event", "status": "confirmed"},
            }
        )
    )
    selected_accounts = []
    monkeypatch.setattr(
        routes,
        "account_schedule",
        lambda account_id: (
            selected_accounts.append(account_id) or SimpleNamespace(calendar=calendar)
        ),
    )
    confirmation = await routes.confirm_booking(
        routes.BookingConfirmed(
            user_id=OWNER,
            account_id=selected,
            request_id=call["id"],
            expected_revision=call["revision"],
            idempotency_key=uuid4(),
            event_id="synthetic-confirmed-calendar-event",
        ),
        response=Response(),
        firebase_uid=OWNER,
        owner={"user_id": OWNER},
    )
    assert selected_accounts == [selected]
    calendar.get_event.assert_awaited_once_with(
        user_id=OWNER, calendar_id="primary", event_id="synthetic-confirmed-calendar-event"
    )
    assert confirmation["booking_state"] == "booked"
    booked = await restarted.detail(
        await restarted.monitor(user_id=OWNER, account_id=selected),
        listing["conversations"][0]["id"],
    )
    assert (
        next(item for item in booked["requests"] if item["id"] == call["id"])["booking_state"]
        == "booked"
    )


@pytest.mark.asyncio
async def test_jhumma_complete_body_restart_reminder_and_correction(followup_pg, monkeypatch):
    service, store, engine = followup_pg
    selected = await _add_calendar(service, "synthetic-jhumma-owner", "owner@example.test")
    await _connect_mail(service, selected, "synthetic-jhumma-owner")
    await routes.preferences(
        routes.PreferenceChange(
            user_id=OWNER,
            account_id=selected,
            enabled=True,
            notifications_enabled=True,
            historical_start_at=datetime(2026, 10, 1, tzinfo=UTC),
            time_zone="Asia/Kolkata",
            reminder_lead_days=1,
            reminder_hour=9,
        ),
        response=Response(),
        firebase_uid=OWNER,
        owner={"user_id": OWNER},
    )

    messages = _mock_messages()
    provider = {"corrected": False, "deleted": False, "read_ids": []}
    monkeypatch.setattr(scan, "reconcile_candidates", _reconcile_with_empty_calendar)
    monkeypatch.setattr(scan, "assess_section", _assess_with_synthetic_model)
    transport = httpx.MockTransport(lambda request: _response(request, provider, messages))

    restarted, listing, doc, call = await _scan_and_assert_initial(
        store, engine, selected, transport, provider
    )
    outbox, feed = await _queue_and_assert_delivery(
        store, restarted, engine, selected, transport, doc, listing
    )
    await _correct_and_assert(
        restarted, engine, selected, transport, doc, call, listing, outbox, feed, provider
    )
    await _assert_stale_retry_suppressed(restarted, engine, doc, monkeypatch)
    await _assert_booking_requires_confirmation(restarted, selected, call, listing, monkeypatch)


# --- Acceptance: initial scan, incremental sync, isolation, reconciliation ------------
