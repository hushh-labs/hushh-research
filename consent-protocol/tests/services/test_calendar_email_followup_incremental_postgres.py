"""Incremental, multi-account and Calendar-reconciled follow-up scans on disposable PostgreSQL.

Synthetic Gmail transport and a synthetic extraction model; these prove the
scan's bookkeeping (what is fetched, skipped, deleted and linked), not model
quality.
"""

from __future__ import annotations

import base64
from datetime import UTC, datetime

import httpx
import pytest
from fastapi import Response
from sqlalchemy import text

from api.routes.one import calendar_email_followups as routes
from hushh_mcp.services import calendar_email_followup_extraction as extraction
from hushh_mcp.services import calendar_email_followup_scan as scan
from hushh_mcp.services.calendar_email_followup_reconcile import reconcile_candidates
from tests.google_oauth_postgres_support import OWNER
from tests.services.calendar_email_followup_jhumma_fakes import (
    MEETING_QUOTE,
    _mock_messages,
    _response,
)
from tests.services.test_calendar_email_followup_jhumma_postgres import (
    _assess_with_synthetic_model,
    _reconcile_with_empty_calendar,
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


class _Gmail:
    """Counts every provider request so tests can prove what was not fetched."""

    def __init__(self, handler) -> None:
        self.calls: list[tuple[str, str]] = []
        self._handler = handler
        self.transport = httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.calls.append((request.url.path, request.headers.get("authorization", "")))
        return self._handler(request)

    def fetched(self, message_id: str) -> int:
        return sum(1 for path, _ in self.calls if path.endswith("/messages/" + message_id))


def _make_due(engine) -> None:
    with engine.begin() as connection:
        connection.execute(text("UPDATE calendar_email_followup_monitors SET next_scan_at=NOW()"))


async def _enable(selected: str, *, lookback=datetime(2026, 10, 1, tzinfo=UTC), notify=True):
    await routes.preferences(
        routes.PreferenceChange(
            user_id=OWNER,
            account_id=selected,
            enabled=True,
            notifications_enabled=notify,
            historical_start_at=lookback,
            time_zone="Asia/Kolkata",
            reminder_lead_days=1,
            reminder_hour=9,
        ),
        response=Response(),
        firebase_uid=OWNER,
        owner={"user_id": OWNER},
    )


async def _drain(store, engine, selected, transport, *, now, limit=30) -> list[dict]:
    """Run scans the way the scheduler would until one reports a terminal result."""
    outcomes = []
    for _ in range(limit):
        outcome = await scan.scan_once(
            user_id=OWNER, account_id=selected, store=store, now=now, transport=transport
        )
        outcomes.append(outcome)
        if outcome["state"] in {"complete", "not_due"} or "reason" in outcome:
            return outcomes
    raise AssertionError(f"scan did not settle: {outcomes[-3:]}")


@pytest.mark.asyncio
async def test_incremental_sync_reads_only_new_mail_and_reopening_repeats_nothing(
    followup_pg, monkeypatch
):
    """Day 1 scans the mailbox; day 2 analyzes only the new message; reopening is free."""
    service, store, engine = followup_pg
    selected = await _add_calendar(service, "synthetic-sync-owner", "owner@example.test")
    await _connect_mail(service, selected, "synthetic-sync-owner")
    await _enable(selected)
    messages = _mock_messages()
    provider = {"corrected": False, "deleted": False, "read_ids": []}
    gmail = _Gmail(lambda request: _response(request, provider, messages))
    assessed: list[str] = []

    async def recording_model(**kwargs):
        assessed.append(kwargs["message"].message_id)
        return await _assess_with_synthetic_model(**kwargs)

    monkeypatch.setattr(scan, "reconcile_candidates", _reconcile_with_empty_calendar)
    monkeypatch.setattr(scan, "assess_section", recording_model)
    day_one = datetime(2026, 10, 11, tzinfo=UTC)
    day_two = datetime(2026, 10, 21, tzinfo=UTC)

    await _drain(store, engine, selected, gmail.transport, now=day_one)
    assert set(assessed) == {"msg-jhumma"}
    status = await routes.status(
        routes._Selection(user_id=OWNER, account_id=selected), firebase_uid=OWNER
    )
    assert status["coverage"]["coverage"] == "complete"
    assert status["monitor_current"] is True

    # Reopening Insights before the next scheduled pass is answered from state.
    calls = len(gmail.calls)
    reopened = await scan.scan_once(
        user_id=OWNER,
        account_id=selected,
        store=store,
        now=day_one,
        transport=gmail.transport,
    )
    assert reopened["state"] == "not_due"
    assert len(gmail.calls) == calls

    provider["corrected"] = True
    _make_due(engine)
    await _drain(store, engine, selected, gmail.transport, now=day_two)
    # The earlier message is listed by thread but never fetched or analyzed again.
    assert gmail.fetched("msg-jhumma") == 1
    assert gmail.fetched("msg-correction") == 1
    assert assessed.count("msg-jhumma") == assessed.count("msg-correction") == 1

    # Nothing changed since: one history call and no message reads.
    _make_due(engine)
    calls = len(gmail.calls)
    await _drain(store, engine, selected, gmail.transport, now=day_two)
    assert not [path for path, _ in gmail.calls[calls:] if "/messages/" in path]
    assert gmail.fetched("msg-jhumma") == 1


def _paged_provider(state: dict):
    """Five messages over three result pages: short, long, flaky, image-only, last."""
    day = 24 * 3600 * 1000
    base = int(datetime(2026, 9, 1, tzinfo=UTC).timestamp() * 1000)
    long_body = ("Background paragraph with ordinary detail. " * 500) + (
        "\n\nPlease send the signed agreement before 30 October."
    )
    bodies = {
        "m1": ("Thanks for yesterday, nothing needed from you.", base + 1 * day, "t1"),
        "m2": (long_body, base + 20 * day, "t2"),
        "m3": ("Could we have a call on 28 October?", base + 30 * day, "t3"),
        "m4": (None, base + 40 * day, "t4"),
        "m5": ("Plain note with no request.", base + 50 * day, "t5"),
    }
    pages = {None: (["m1", "m2"], "p2"), "p2": (["m3", "m4"], "p3"), "p3": (["m5"], None)}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/profile"):
            return httpx.Response(200, json={"historyId": "500"})
        if path.endswith("/messages"):
            ids, following = pages[request.url.params.get("pageToken")]
            body = {"messages": [{"id": i, "threadId": bodies[i][2]} for i in ids]}
            if following:
                body["nextPageToken"] = following
            return httpx.Response(200, json=body)
        if path.endswith("/history"):
            return httpx.Response(200, json={"historyId": "500", "history": []})
        for message_id, (text_body, received, thread) in bodies.items():
            if path.endswith("/threads/" + thread):
                return httpx.Response(
                    200,
                    json={
                        "id": thread,
                        "messages": [
                            {
                                "id": message_id,
                                "threadId": thread,
                                "internalDate": str(received),
                                "labelIds": ["INBOX"],
                            }
                        ],
                    },
                )
            if path.endswith("/messages/" + message_id):
                if message_id == "m3" and state["flaky"]:
                    state["flaky"] = False
                    return httpx.Response(503)
                headers = [
                    {"name": "Subject", "value": "Subject " + message_id},
                    {"name": "From", "value": "Sender <sender@example.test>"},
                ]
                if text_body is None:
                    payload = {"mimeType": "image/png", "body": {"size": 10}, "headers": headers}
                else:
                    data = base64.urlsafe_b64encode(text_body.encode()).decode().rstrip("=")
                    payload = {
                        "mimeType": "text/plain",
                        "body": {"data": data, "size": len(text_body)},
                        "headers": headers,
                    }
                return httpx.Response(
                    200,
                    json={
                        "id": message_id,
                        "threadId": thread,
                        "internalDate": str(received),
                        "payload": payload,
                    },
                )
        return httpx.Response(404)

    return handler


def _agreement_model(sections_seen: dict[str, int]):
    """A synthetic model that finds one agreement deadline and records section counts."""

    async def model(**kwargs):
        message = kwargs["message"]
        sections_seen[message.message_id] = len(message.sections)
        section = kwargs["section"].text
        quote = "Please send the signed agreement before 30 October."
        if quote not in section:
            return [], []
        gene = {
            "candidates": [
                {
                    "local_index": 0,
                    "section_index": kwargs["section"].index,
                    "kind": "deadline",
                    "quote_start": section.index(quote),
                    "source_quote": quote,
                    "title": "Send the signed agreement",
                    "due_date": "2026-10-30",
                    "due_relation": "before",
                    "responsibility": "owner",
                    "time_zone": "Asia/Kolkata",
                    "relevance": "actionable",
                    "category": "deliverable_deadline",
                    "evidence_reason": "The sender asks for the agreement by a date.",
                }
            ],
            "updates": [],
        }

        async def runner(**_):
            return gene

        return await extraction.assess_section(**kwargs, gene_runner=runner)

    return model


@pytest.mark.asyncio
async def test_initial_scan_reads_every_page_long_body_and_recovers_a_provider_failure(
    followup_pg, monkeypatch
):
    service, store, engine = followup_pg
    selected = await _add_calendar(service, "synthetic-pages-owner", "owner@example.test")
    await _connect_mail(service, selected, "synthetic-pages-owner")
    await _enable(selected, lookback=datetime(2026, 8, 3, tzinfo=UTC))
    state = {"flaky": True}
    gmail = _Gmail(_paged_provider(state))
    sections_seen: dict[str, int] = {}

    monkeypatch.setattr(scan, "reconcile_candidates", _reconcile_with_empty_calendar)
    monkeypatch.setattr(scan, "assess_section", _agreement_model(sections_seen))
    now = datetime(2026, 11, 1, tzinfo=UTC)

    first = await _drain(store, engine, selected, gmail.transport, now=now)
    # A provider outage stops the pass and backs off; it is not reported as done.
    assert first[-1].get("reason") == "mail_temporarily_unavailable"
    mid = await routes.status(
        routes._Selection(user_id=OWNER, account_id=selected), firebase_uid=OWNER
    )
    assert mid["coverage"]["coverage"] == "catching_up"
    assert mid["coverage"]["attention"] is None
    blocked = await scan.scan_once(
        user_id=OWNER, account_id=selected, store=store, now=now, transport=gmail.transport
    )
    assert blocked["state"] == "not_due"

    _make_due(engine)
    await _drain(store, engine, selected, gmail.transport, now=now)
    # Every page was visited, and every readable message was assessed once.
    assert {i for i in sections_seen} == {"m1", "m2", "m3", "m5"}
    assert sections_seen["m2"] > 1
    assert gmail.fetched("m1") == gmail.fetched("m5") == 1
    # A long body is re-read once per bounded step, never once per pass.
    assert 1 <= gmail.fetched("m2") <= sections_seen["m2"]
    done = await routes.status(
        routes._Selection(user_id=OWNER, account_id=selected), firebase_uid=OWNER
    )
    # The image-only message is counted as unreadable; nothing is left "incomplete".
    assert done["coverage"]["coverage"] == "complete"
    assert done["coverage"]["unreadable_count"] == 1
    assert done["incomplete_source_count"] == 0
    monitor = await store.monitor(user_id=OWNER, account_id=selected)
    listing = await store.list_conversations(monitor, limit=10)
    titles = {
        item["title"]
        for conversation in listing["conversations"]
        for item in conversation["preview_requests"]
    }
    assert titles == {"Send the signed agreement"}


@pytest.mark.asyncio
async def test_each_account_scan_uses_only_its_own_mailbox_and_results(followup_pg, monkeypatch):
    service, store, engine = followup_pg
    account_a = await _add_calendar(service, "synthetic-iso-a", "a@example.test")
    await _connect_mail(service, account_a, "synthetic-iso-a")
    account_b = await _add_calendar(service, "synthetic-iso-b", "b@example.test")
    await _connect_mail(service, account_b, "synthetic-iso-b")
    await _enable(account_a)
    await _enable(account_b)
    messages = _mock_messages()
    gmail_a = _Gmail(
        lambda r: _response(r, {"corrected": False, "deleted": False, "read_ids": []}, messages)
    )
    gmail_b = _Gmail(lambda r: httpx.Response(200, json={"historyId": "9", "messages": []}))
    monkeypatch.setattr(scan, "reconcile_candidates", _reconcile_with_empty_calendar)
    monkeypatch.setattr(scan, "assess_section", _assess_with_synthetic_model)
    now = datetime(2026, 10, 11, tzinfo=UTC)

    await _drain(store, engine, account_a, gmail_a.transport, now=now)
    await _drain(store, engine, account_b, gmail_b.transport, now=now)

    assert {token for _, token in gmail_a.calls} == {"Bearer synthetic-mail-access-synthetic-iso-a"}
    assert {token for _, token in gmail_b.calls} == {"Bearer synthetic-mail-access-synthetic-iso-b"}
    listing_a = await store.list_conversations(
        await store.monitor(user_id=OWNER, account_id=account_a), limit=10
    )
    listing_b = await store.list_conversations(
        await store.monitor(user_id=OWNER, account_id=account_b), limit=10
    )
    assert listing_a["total_conversations"] == 1
    assert listing_b["total_conversations"] == 0


def _event(event_id: str, title: str, start: str) -> dict:
    return {
        "id": event_id,
        "title": title,
        "status": "confirmed",
        "start": {"dateTime": start},
        "end": {"dateTime": start},
    }


@pytest.mark.asyncio
async def test_existing_calendar_meeting_is_linked_not_recreated_and_new_one_needs_review(
    followup_pg, monkeypatch
):
    """ "Hushh Growth Sync" stays a Board event; a genuinely new proposal is still shown."""
    service, store, engine = followup_pg
    selected = await _add_calendar(service, "synthetic-recon-owner", "owner@example.test")
    await _connect_mail(service, selected, "synthetic-recon-owner")
    await _enable(selected)
    messages = _mock_messages()
    provider = {"corrected": False, "deleted": False, "read_ids": []}
    gmail = _Gmail(lambda request: _response(request, provider, messages))

    async def growth_sync_calendar(**_kwargs):
        return {
            "events": [_event("evt-sync", "Hushh Growth Sync", "2026-10-27T23:00:00+05:30")],
            "truncated": False,
        }

    async def reconcile(**kwargs):
        return await reconcile_candidates(**kwargs, list_events=growth_sync_calendar)

    async def model(**kwargs):
        async def runner(**_):
            section = kwargs["section"].text
            call = MEETING_QUOTE
            if call not in section:
                return {"candidates": [], "updates": []}
            return {
                "candidates": [
                    {
                        "local_index": 0,
                        "section_index": kwargs["section"].index,
                        "kind": "meeting",
                        "quote_start": section.index(call),
                        "source_quote": call,
                        "title": "Hushh Growth Sync",
                        "proposed_date": "2026-10-27",
                        "responsibility": "owner",
                        "relevance": "actionable",
                        "category": "meeting_request",
                        "meeting_state": "proposed",
                        "related_meeting_hint": "Hushh Growth Sync",
                        "evidence_reason": "The sender asks for a call on a day.",
                    }
                ],
                "updates": [],
            }

        return await extraction.assess_section(**kwargs, gene_runner=runner)

    monkeypatch.setattr(scan, "reconcile_candidates", reconcile)
    monkeypatch.setattr(scan, "assess_section", model)
    await _drain(store, engine, selected, gmail.transport, now=datetime(2026, 10, 11, tzinfo=UTC))
    monitor = await store.monitor(user_id=OWNER, account_id=selected)
    # The proposal is the meeting that is already on the Calendar: no follow-up.
    assert (await store.list_conversations(monitor, limit=10))["total_conversations"] == 0

    async def empty_calendar(**_kwargs):
        return {"events": [], "truncated": False}

    async def reconcile_new(**kwargs):
        return await reconcile_candidates(**kwargs, list_events=empty_calendar)

    with engine.begin() as connection:
        connection.execute(text("DELETE FROM calendar_email_followup_scanned_messages"))
        connection.execute(
            text("UPDATE calendar_email_followup_monitors SET checkpoint_ciphertext=NULL")
        )
    _make_due(engine)
    monkeypatch.setattr(scan, "reconcile_candidates", reconcile_new)
    await _drain(store, engine, selected, gmail.transport, now=datetime(2026, 10, 11, tzinfo=UTC))
    monitor = await store.monitor(user_id=OWNER, account_id=selected)
    listing = await store.list_conversations(monitor, limit=10)
    request = listing["conversations"][0]["preview_requests"][0]
    # Nothing was booked: it is surfaced as a proposal that still needs the owner.
    assert request["kind"] == "meeting" and request["meeting_state"] == "proposed"
    assert request["state"] == "needs_review"
