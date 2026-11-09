"""Which Follow-ups the owner sees, and when, on disposable PostgreSQL.

Covers temporal eligibility and ranking before paging, restated and replaced
obligations, bounded reassessment, and the 454 migration's compatibility. All
model output here is synthetic: these tests prove what the host enforces around
a verdict, not how a live model judges an email.
"""

from __future__ import annotations

import dataclasses
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import Response
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from api.routes.one import calendar_email_followups as routes
from hushh_mcp.services.calendar_email_followup_extraction import CompleteAssessment
from hushh_mcp.services.calendar_email_followup_relevance import ASSESSMENT_VERSION
from hushh_mcp.services.calendar_email_followup_store_types import FollowupStateError
from tests.google_oauth_postgres_support import OWNER
from tests.services.test_calendar_email_followup_oauth_postgres import (
    MIGRATIONS,
    _add_calendar,
    _connect_mail,
)
from tests.services.test_calendar_email_followup_oauth_postgres import (
    followup_pg as followup_pg,
)
from tests.services.test_calendar_email_followup_store_postgres import (
    _candidate,
    _commit,
    _message,
    _monitored_account,
    _reassess,
)
from tests.services.test_external_connector_lifecycle_postgres import (
    connector_postgres_url as connector_postgres_url,
)

# The owner's local day is 10 Nov 2026 (Asia/Kolkata).
TODAY = datetime(2026, 11, 10, 6, 0, tzinfo=UTC)
NPTEL = "NPTEL <onlinecourses@nptel.ac.in>"
NPTEL_ALT = "NPTEL Exams <noreply@exams.nptel.ac.in>"


def _ask(message, quote, title, due, *, after_date="owed", **fields):
    """A dated deadline the owner is responsible for, in the synthetic verdict's shape."""
    base = {
        "kind": "deadline",
        "title": title,
        "responsibility": "owner",
        "ambiguities": (),
        "due_date": due,
        "due_relation": "before",
        "category": "deliverable_deadline",
        "after_date": after_date,
    }
    return _candidate(message, quote, **{**base, **fields})


def _titles(listing) -> list[str]:
    return [
        conversation["preview_requests"][0]["title"] for conversation in listing["conversations"]
    ]


_put = _commit


async def _listing(store, account_id, view="upcoming", now=TODAY, **kwargs):
    monitor = await store.monitor(user_id=OWNER, account_id=account_id)
    return await store.list_conversations(monitor, limit=50, view=view, now=now, **kwargs)


async def _request_for(store, account_id, title):
    monitor = await store.monitor(user_id=OWNER, account_id=account_id)
    for view in ("upcoming", "overdue", "snoozed", "history"):
        for conversation in (
            await store.list_conversations(monitor, limit=50, view=view, now=TODAY)
        )["conversations"]:
            for request in (await store.detail(monitor, conversation["id"], now=TODAY))["requests"]:
                if request["title"] == title:
                    return monitor, request
    raise AssertionError(f"no request titled {title!r}")


def _rows(engine):
    with engine.begin() as connection:
        return [
            dict(row)
            for row in connection.execute(
                text(
                    """SELECT state,suppressed_at IS NOT NULL AS suppressed,merged_into,
                suppression_reason,after_date,assessment_version,revision,
                reminder_at IS NOT NULL AS has_reminder
                FROM calendar_email_followup_requests ORDER BY created_at,id"""
                )
            )
            .mappings()
            .all()
        ]


async def _account(service, tag, email):
    account_id = await _add_calendar(service, tag, email)
    await _connect_mail(service, account_id, tag)
    await routes.preferences(
        routes.PreferenceChange(
            user_id=OWNER,
            account_id=account_id,
            enabled=True,
            historical_start_at=datetime(2026, 10, 1, tzinfo=UTC),
            time_zone="Asia/Kolkata",
        ),
        response=Response(),
        firebase_uid=OWNER,
        owner={"user_id": OWNER},
    )
    return account_id


@pytest.mark.asyncio
async def test_expired_opportunity_leaves_upcoming_and_overdue_work_stays_reachable(followup_pg):
    service, store, engine = followup_pg
    account_id = await _monitored_account(service)
    window = _message("m-window", "Register for the July exam by 17 August.")
    agreement = _message("m-agreement", "Send the signed agreement before 30 October.")
    legacy = _message("m-legacy", "Pay the invoice before 1 October.")
    exam = _message("m-exam", "Your exam is on 12 November.")
    doc = _message("m-doc", "Send the project documents before 20 November.")
    await _put(
        store,
        account_id,
        window,
        _ask(
            window,
            "Register for the July exam by 17 August.",
            "Register for the July exam",
            "2026-08-17",
            after_date="lapses",
        ),
    )
    await _put(
        store,
        account_id,
        agreement,
        _ask(
            agreement,
            "Send the signed agreement before 30 October.",
            "Send the signed agreement",
            "2026-10-30",
        ),
    )
    # A row from before the date effect existed: unknown must never read as expired.
    await _put(
        store,
        account_id,
        legacy,
        _ask(
            legacy,
            "Pay the invoice before 1 October.",
            "Pay the invoice",
            "2026-10-01",
            after_date="unspecified",
        ),
    )
    await _put(
        store,
        account_id,
        exam,
        _ask(
            exam,
            "Your exam is on 12 November.",
            "Attend the exam",
            "2026-11-12",
            after_date="lapses",
            category="scheduled_event",
            due_relation="on",
        ),
    )
    await _put(
        store,
        account_id,
        doc,
        _ask(
            doc,
            "Send the project documents before 20 November.",
            "Send the project documents",
            "2026-11-20",
        ),
    )
    before = _rows(engine)

    upcoming = await _listing(store, account_id)
    assert _titles(upcoming) == ["Attend the exam", "Send the project documents"]
    assert upcoming["view_counts"] == {"upcoming": 2, "overdue": 2, "snoozed": 0, "history": 1}
    assert _titles(await _listing(store, account_id, "overdue")) == [
        "Send the signed agreement",
        "Pay the invoice",
    ]
    assert _titles(await _listing(store, account_id, "history")) == ["Register for the July exam"]
    # Reading moves nothing: no state, revision or reminder changed, nothing deleted.
    assert _rows(engine) == before
    assert {row["state"] for row in before} <= {"pending", "needs_review"}


@pytest.mark.asyncio
async def test_a_deadline_that_passes_moves_between_lists_without_any_write(followup_pg):
    service, store, engine = followup_pg
    account_id = await _monitored_account(service)
    message = _message("m-clock", "Send the report before 12 November.")
    await _put(
        store,
        account_id,
        message,
        _ask(message, "Send the report before 12 November.", "Send the report", "2026-11-12"),
    )
    assert _titles(await _listing(store, account_id, now=TODAY)) == ["Send the report"]
    later = datetime(2026, 11, 11, 18, 30, tzinfo=UTC)  # start of 12 Nov in Asia/Kolkata
    assert _titles(await _listing(store, account_id, now=later - timedelta(seconds=1))) == [
        "Send the report"
    ]
    assert _titles(await _listing(store, account_id, now=later)) == []
    assert _titles(await _listing(store, account_id, "overdue", now=later)) == ["Send the report"]
    assert [row["state"] for row in _rows(engine)] == ["pending"]


@pytest.mark.asyncio
async def test_eligibility_and_ranking_happen_before_the_15_item_page_is_chosen(followup_pg):
    """Old expired items rank first by date; they must not occupy a page slot."""
    service, store, _ = followup_pg
    account_id = await _monitored_account(service)
    for index in range(6):
        message = _message(f"m-old-{index}", f"Register for round {index} by 1 August.")
        await _put(
            store,
            account_id,
            message,
            _ask(
                message,
                f"Register for round {index} by 1 August.",
                f"Register for round {index}",
                f"2026-08-{index + 1:02d}",
                after_date="lapses",
            ),
        )
    for index in range(16):
        message = _message(f"m-new-{index}", f"Submit item {index} before 30 November.")
        await _put(
            store,
            account_id,
            message,
            _ask(
                message,
                f"Submit item {index} before 30 November.",
                f"Submit item {index}",
                f"2026-11-{12 + index:02d}",
            ),
        )
    first = await routes.list_followups(
        routes.ListSelection(user_id=OWNER, account_id=account_id),
        response=Response(),
        firebase_uid=OWNER,
        owner={"user_id": OWNER},
    )
    assert routes.FOLLOWUP_PAGE_SIZE == 15
    assert len(first["conversations"]) == 15
    assert first["total_conversations"] == 16
    assert first["next_offset"] == 15
    assert all("Submit item" in title for title in _titles(first))
    second = await routes.list_followups(
        routes.ListSelection(user_id=OWNER, account_id=account_id, offset=15),
        response=Response(),
        firebase_uid=OWNER,
        owner={"user_id": OWNER},
    )
    assert _titles(second) == ["Submit item 15"] and second["next_offset"] is None
    history = await routes.list_followups(
        routes.ListSelection(user_id=OWNER, account_id=account_id, view="history"),
        response=Response(),
        firebase_uid=OWNER,
        owner={"user_id": OWNER},
    )
    assert history["total_conversations"] == 6


@pytest.mark.asyncio
async def test_urgent_dated_and_owner_work_rank_first_and_stale_undated_asks_fall_to_history(
    followup_pg,
):
    service, store, _ = followup_pg
    account_id = await _monitored_account(service)

    async def put(message_id, **fields):
        quote = f"Please handle {message_id}."
        message = _message(message_id, quote)
        await _put(
            store,
            account_id,
            message,
            _candidate(
                message,
                quote,
                **{"title": message_id, "kind": "deadline", "ambiguities": (), **fields},
            ),
        )

    await put("later", responsibility="owner", due_date="2026-12-20", due_relation="by")
    await put("soon", responsibility="owner", due_date="2026-11-12", due_relation="by")
    await put("urgent-undated", responsibility="owner", urgency="asap", ambiguities=("date",))
    await put("soon-unclear", responsibility="unclear", due_date="2026-11-11", due_relation="by")
    # An undated ask first seen long ago is history, not a current request.
    stale_ms = int(datetime(2026, 8, 1, tzinfo=UTC).timestamp() * 1000)
    stale = _message("stale", "Please handle stale.")
    stale = dataclasses.replace(stale, internal_date_ms=stale_ms)
    await _put(
        store,
        account_id,
        stale,
        _candidate(
            stale,
            "Please handle stale.",
            title="stale",
            kind="action",
            responsibility="owner",
            ambiguities=("date",),
            urgency="asap",
        ),
    )
    assert _titles(await _listing(store, account_id)) == [
        "soon",
        "urgent-undated",
        "soon-unclear",
        "later",
    ]
    assert _titles(await _listing(store, account_id, "history")) == ["stale"]


@pytest.mark.asyncio
async def test_snooze_until_is_respected_and_returns_when_it_lapses(followup_pg):
    service, store, _ = followup_pg
    account_id = await _monitored_account(service)
    real_now = datetime.now(UTC)
    until = real_now + timedelta(days=30)
    due = (real_now + timedelta(days=60)).date().isoformat()
    message = _message("m-snooze", "Send the deck before the date.")
    await _put(
        store,
        account_id,
        message,
        _ask(message, "Send the deck before the date.", "Send the deck", due),
    )
    monitor, request = await _request_for(store, account_id, "Send the deck")
    await store.mutate_request(
        monitor,
        request_id=request["id"],
        expected_revision=request["revision"],
        idempotency_key=str(uuid.uuid4()),
        action="snooze",
        reminder_at=until,
    )
    before = real_now + timedelta(days=1)
    assert _titles(await _listing(store, account_id, now=before)) == []
    assert _titles(await _listing(store, account_id, "snoozed", now=before)) == ["Send the deck"]
    after = until + timedelta(days=1)
    assert _titles(await _listing(store, account_id, now=after)) == ["Send the deck"]


@pytest.mark.asyncio
async def test_the_same_obligation_in_two_emails_is_one_request_that_keeps_both_sources(
    followup_pg,
):
    service, store, engine = followup_pg
    account_id = await _monitored_account(service)
    first = _message("m-first", "Register for the July 2026 exam before 20 November.", sender=NPTEL)
    second = _message(
        "m-second",
        "Reminder: register for July 2026 NPTEL exam before 20 November.",
        sender=NPTEL_ALT,
    )
    await _put(
        store,
        account_id,
        first,
        _ask(
            first,
            "Register for the July 2026 exam before 20 November.",
            "Register for July 2026 exam",
            "2026-11-20",
            after_date="lapses",
        ),
    )
    await _put(
        store,
        account_id,
        second,
        _ask(
            second,
            "Reminder: register for July 2026 NPTEL exam before 20 November.",
            "Register for July 2026 NPTEL exam",
            "2026-11-20",
            after_date="lapses",
        ),
    )
    listing = await _listing(store, account_id)
    assert listing["total_conversations"] == 1
    rows = _rows(engine)
    assert len(rows) == 2  # the restating email's source is retained, not dropped
    merged = next(row for row in rows if row["merged_into"])
    assert merged["suppressed"] and merged["suppression_reason"] == "repeat_of_other_message"
    # One obligation, one reminder: the restating email must not alert a second time.
    assert not merged["has_reminder"]
    assert sum(row["has_reminder"] for row in rows) == 1
    monitor = await store.monitor(user_id=OWNER, account_id=account_id)
    detail = await store.detail(monitor, listing["conversations"][0]["id"], now=TODAY)
    assert [request["repeat_count"] for request in detail["requests"]] == [1]
    with engine.begin() as connection:
        old_id = connection.execute(
            text("SELECT id FROM calendar_email_followup_requests WHERE merged_into IS NOT NULL")
        ).scalar_one()
    target = await routes.resolve_followup(
        routes.RequestSelection(user_id=OWNER, account_id=account_id, request_id=old_id),
        response=Response(),
        firebase_uid=OWNER,
        owner={"user_id": OWNER},
    )
    assert target == {
        "account_id": account_id,
        "conversation_id": detail["id"],
        "request_id": detail["requests"][0]["id"],
    }
    # The owner's decision on the survivor holds for the obligation.
    request = detail["requests"][0]
    await store.mutate_request(
        monitor,
        request_id=request["id"],
        expected_revision=request["revision"],
        idempotency_key=str(uuid.uuid4()),
        action="dismiss",
    )
    assert (await _listing(store, account_id))["total_conversations"] == 0


@pytest.mark.asyncio
async def test_a_restatement_of_a_finished_obligation_does_not_bring_it_back(followup_pg):
    service, store, _ = followup_pg
    account_id = await _monitored_account(service)
    first = _message("m-a", "Send the signed agreement before 20 November.", sender=NPTEL)
    await _put(
        store,
        account_id,
        first,
        _ask(
            first,
            "Send the signed agreement before 20 November.",
            "Send the signed agreement",
            "2026-11-20",
        ),
    )
    monitor, request = await _request_for(store, account_id, "Send the signed agreement")
    await store.mutate_request(
        monitor,
        request_id=request["id"],
        expected_revision=request["revision"],
        idempotency_key=str(uuid.uuid4()),
        action="done",
    )
    again = _message(
        "m-b", "Please send the signed agreement before 20 November.", sender=NPTEL_ALT
    )
    await _put(
        store,
        account_id,
        again,
        _ask(
            again,
            "Please send the signed agreement before 20 November.",
            "Send the signed agreement",
            "2026-11-20",
        ),
    )
    assert (await _listing(store, account_id))["total_conversations"] == 0
    assert _titles(await _listing(store, account_id, "history")) == ["Send the signed agreement"]


@pytest.mark.asyncio
async def test_ambiguous_restatements_stay_separate(followup_pg):
    service, store, engine = followup_pg
    account_id = await _monitored_account(service)
    other = await _account(service, "synthetic-c", "c@example.test")

    async def add(account, message_id, title, due, sender=NPTEL):
        message = _message(message_id, f"{title} before {due}.", sender=sender)
        await _put(store, account, message, _ask(message, f"{title} before {due}.", title, due))

    await add(account_id, "m-1", "Submit assignment 1", "2026-11-20")
    await add(account_id, "m-2", "Submit assignment 2", "2026-11-20")  # another number
    await add(account_id, "m-3", "Submit assignment 1", "2026-11-21")  # another date
    await add(
        account_id, "m-4", "Submit assignment 1", "2026-11-20", sender="Dean <dean@college.test>"
    )  # another sender
    await add(other, "m-5", "Submit assignment 1", "2026-11-20")  # another account
    await add(account_id, "m-6", "Submit signed Form W-9 to Finance", "2026-11-20")
    await add(account_id, "m-7", "Submit signed Form W-9 to Legal", "2026-11-20")
    assert (await _listing(store, account_id))["total_conversations"] == 6
    assert (await _listing(store, other))["total_conversations"] == 1
    assert not any(row["merged_into"] for row in _rows(engine))


async def _extended(store, account_id, *, supersedes, source_delta_ms=1):
    """A later email in the same thread moves the deadline, naming the request it replaces."""
    first = _message("m-original", "Register for the exam before 15 November.")
    later = dataclasses.replace(
        _message("m-extended", "The deadline is extended to 20 November."),
        thread_id=first.thread_id,
        internal_date_ms=first.internal_date_ms + source_delta_ms,
    )
    candidate = _ask(
        later,
        "The deadline is extended to 20 November.",
        "Register for July 2026 exam",
        "2026-11-20",
        after_date="lapses",
        supersedes_request_id=supersedes(),
    )
    await _put(store, account_id, later, candidate)


async def _original(store, service_account, *, decision=None):
    first = _message("m-original", "Register for the exam before 15 November.")
    await _put(
        store,
        service_account,
        first,
        _ask(
            first,
            "Register for the exam before 15 November.",
            "Register for July 2026 exam",
            "2026-11-15",
            after_date="lapses",
        ),
    )
    monitor, request = await _request_for(store, service_account, "Register for July 2026 exam")
    if decision:
        await store.mutate_request(
            monitor,
            request_id=request["id"],
            expected_revision=request["revision"],
            idempotency_key=str(uuid.uuid4()),
            action=decision,
        )
    return request["id"]


@pytest.mark.asyncio
@pytest.mark.parametrize("decision", [None, "dismiss", "done"])
async def test_a_proven_extension_replaces_the_earlier_request_and_keeps_the_decision(
    followup_pg, decision
):
    service, store, engine = followup_pg
    account_id = await _monitored_account(service)
    original = await _original(store, account_id, decision=decision)
    await _extended(store, account_id, supersedes=lambda: original)
    rows = _rows(engine)
    assert len(rows) == 2 and rows[0]["merged_into"] is not None  # source kept, linked
    upcoming = await _listing(store, account_id)
    if decision is None:
        assert _titles(upcoming) == ["Register for July 2026 exam"]
        monitor = await store.monitor(user_id=OWNER, account_id=account_id)
        shown = (await store.detail(monitor, upcoming["conversations"][0]["id"], now=TODAY))[
            "requests"
        ]
        assert [request["due_date"] for request in shown] == ["2026-11-20"]
    else:
        assert upcoming["total_conversations"] == 0  # the decision followed the new date
        assert (await _listing(store, account_id, "history"))["total_conversations"] == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(("action", "state"), [("set_reminder", "pending"), ("snooze", "snoozed")])
async def test_a_replacement_keeps_the_owners_future_reminder(followup_pg, action, state):
    service, store, engine = followup_pg
    account_id = await _monitored_account(service)
    original = await _original(store, account_id)
    monitor, request = await _request_for(store, account_id, "Register for July 2026 exam")
    reminder = datetime.now(UTC) + timedelta(days=1)
    await store.mutate_request(
        monitor,
        request_id=original,
        expected_revision=request["revision"],
        idempotency_key=str(uuid.uuid4()),
        action=action,
        reminder_at=reminder,
    )

    await _extended(store, account_id, supersedes=lambda: original)
    rows = _rows(engine)
    assert rows[0]["merged_into"] and not rows[0]["has_reminder"]
    with engine.begin() as connection:
        kept = connection.execute(
            text("""SELECT state,reminder_at,reminder_is_manual
                 FROM calendar_email_followup_requests WHERE merged_into IS NULL""")
        ).one()
    assert tuple(kept) == (state, reminder, True)


@pytest.mark.asyncio
async def test_an_older_message_cannot_replace_a_newer_request(followup_pg):
    service, store, engine = followup_pg
    account_id = await _monitored_account(service)
    original = await _original(store, account_id)
    await _extended(store, account_id, supersedes=lambda: original, source_delta_ms=-1)
    assert len(_rows(engine)) == 2
    assert not any(row["merged_into"] for row in _rows(engine))


@pytest.mark.asyncio
async def test_an_unproven_replacement_claim_keeps_both_requests(followup_pg):
    service, store, engine = followup_pg
    account_id = await _monitored_account(service)
    await _original(store, account_id)
    # An ID the model was never offered cannot replace anything.
    await _extended(store, account_id, supersedes=lambda: str(uuid.uuid4()))
    assert not any(row["merged_into"] for row in _rows(engine))
    # Different wording is a different obligation even when the ID is real.
    other = _message("m-other", "Submit the lab record before 22 November.")
    original = (await _request_for(store, account_id, "Register for July 2026 exam"))[1]["id"]
    other = dataclasses.replace(other, thread_id=_message("m-original", "x").thread_id)
    await _put(
        store,
        account_id,
        other,
        _ask(
            other,
            "Submit the lab record before 22 November.",
            "Submit the lab record",
            "2026-11-22",
            supersedes_request_id=original,
        ),
    )
    rows = _rows(engine)
    assert len(rows) == 3 and not any(row["merged_into"] for row in rows)


@pytest.mark.asyncio
async def test_two_claims_on_one_request_are_ambiguous_and_replace_nothing(followup_pg):
    service, store, engine = followup_pg
    account_id = await _monitored_account(service)
    original = await _original(store, account_id)
    later = dataclasses.replace(
        _message("m-twice", "Deadline extended to 20 November. Also due 21 November."),
        thread_id=_message("m-original", "x").thread_id,
    )
    claims = tuple(
        _ask(
            later,
            quote,
            "Register for July 2026 exam",
            due,
            after_date="lapses",
            supersedes_request_id=original,
        )
        for quote, due in (
            ("Deadline extended to 20 November.", "2026-11-20"),
            ("Also due 21 November.", "2026-11-21"),
        )
    )
    monitor = await store.acquire_scan(user_id=OWNER, account_id=account_id)
    await store.commit_message(
        monitor,
        later,
        CompleteAssessment(
            expected_sections=len(later.sections),
            completed_sections=len(later.sections),
            candidates=claims,
            updates=(),
        ),
        now=TODAY,
    )
    await store.release_scan(monitor)
    rows = _rows(engine)
    assert len(rows) == 3 and not any(row["merged_into"] for row in rows)


@pytest.mark.asyncio
async def test_a_replacement_cannot_cross_owner_or_account(followup_pg):
    service, store, engine = followup_pg
    account_a = await _monitored_account(service)
    account_b = await _account(service, "synthetic-c", "c@example.test")
    original = await _original(store, account_a)
    await _extended(store, account_b, supersedes=lambda: original)
    assert not any(row["merged_into"] for row in _rows(engine))
    assert (await _listing(store, account_a))["total_conversations"] == 1


@pytest.mark.asyncio
async def test_version_bump_rereads_only_messages_that_back_an_older_request(followup_pg):
    service, store, engine = followup_pg
    account_id = await _monitored_account(service)
    visible = _message("m-visible", "Send the signed agreement before 20 November.")
    settled = _message("m-settled", "Weekly newsletter.")
    await _put(
        store,
        account_id,
        visible,
        _ask(
            visible,
            "Send the signed agreement before 20 November.",
            "Send the signed agreement",
            "2026-11-20",
        ),
    )
    monitor = await store.acquire_scan(user_id=OWNER, account_id=account_id)
    await store.commit_message(
        monitor,
        settled,
        CompleteAssessment(
            expected_sections=len(settled.sections),
            completed_sections=len(settled.sections),
            candidates=(),
            updates=(),
        ),
        now=TODAY,
    )
    await store.release_scan(monitor)
    with engine.begin() as connection:
        connection.execute(text("UPDATE calendar_email_followup_monitors SET next_scan_at=NOW()"))
    # The previous contract assessed both; only one still backs a visible request.
    with engine.begin() as connection:
        connection.execute(text("UPDATE calendar_email_followup_requests SET assessment_version=2"))
        connection.execute(
            text("UPDATE calendar_email_followup_scanned_messages SET assessment_version=2")
        )
    monitor = await store.monitor(user_id=OWNER, account_id=account_id)
    assert (await store.scanned_state(monitor, settled.message_id)).current
    assert not (await store.scanned_state(monitor, visible.message_id)).current
    assert await store.stale_assessment_threads(monitor, cutoff_ms=0) == [visible.thread_id]
    # Reassessing it keeps the owner's decision and settles it at the current contract.
    monitor, request = await _request_for(store, account_id, "Send the signed agreement")
    await store.mutate_request(
        monitor,
        request_id=request["id"],
        expected_revision=request["revision"],
        idempotency_key=str(uuid.uuid4()),
        action="done",
    )
    await _reassess(
        store,
        account_id,
        visible,
        [
            _ask(
                visible,
                "Send the signed agreement before 20 November.",
                "Send the signed agreement",
                "2026-11-20",
            )
        ],
    )
    monitor = await store.monitor(user_id=OWNER, account_id=account_id)
    assert (await store.scanned_state(monitor, visible.message_id)).current
    assert await store.stale_assessment_threads(monitor, cutoff_ms=0) == []
    assert [(row["state"], row["assessment_version"]) for row in _rows(engine)] == [
        ("done", ASSESSMENT_VERSION)
    ]


@pytest.mark.asyncio
async def test_reassessed_noise_is_hidden_not_deleted(followup_pg):
    service, store, engine = followup_pg
    account_id = await _monitored_account(service)
    promo = _message("m-promo", "Upgrade to Ultra before 2 November.")
    await _put(
        store,
        account_id,
        promo,
        _ask(promo, "Upgrade to Ultra before 2 November.", "Upgrade to Ultra", "2026-11-02"),
    )
    with engine.begin() as connection:
        connection.execute(text("UPDATE calendar_email_followup_requests SET assessment_version=2"))
        connection.execute(
            text("UPDATE calendar_email_followup_scanned_messages SET assessment_version=2")
        )
    await _reassess(store, account_id, promo, [])  # the current contract finds nothing
    rows = _rows(engine)
    assert len(rows) == 1 and rows[0]["suppressed"]
    assert rows[0]["suppression_reason"] == "reassessed_not_relevant"
    assert {
        name: (await _listing(store, account_id, name))["total_conversations"]
        for name in ("upcoming", "overdue", "history")
    } == {"upcoming": 0, "overdue": 0, "history": 0}


@pytest.mark.asyncio
async def test_migration_454_is_compatible_with_the_previous_producer_and_reapplies(followup_pg):
    service, store, engine = followup_pg
    account_id = await _monitored_account(service)
    message = _message("m-compat", "Send the signed agreement before 20 November.")
    await _put(
        store,
        account_id,
        message,
        _ask(
            message,
            "Send the signed agreement before 20 November.",
            "Send the signed agreement",
            "2026-11-20",
        ),
    )
    migration = (MIGRATIONS / "454_calendar_email_followup_temporal.sql").read_text()
    rollback = (
        MIGRATIONS / "rollback" / "454_calendar_email_followup_temporal.rollback.sql"
    ).read_text()

    def run(sql):
        body = sql.replace("BEGIN;", "").replace("COMMIT;", "")
        body = body.replace("SELECT install_account_deletion_write_guards();", "")
        with engine.begin() as connection:
            connection.exec_driver_sql(body)

    # Upgrade path: a database that has real rows but not yet 454, then 454 applied.
    run(rollback)
    with engine.begin() as connection:
        assert not connection.execute(
            text("""SELECT 1 FROM information_schema.columns
            WHERE table_name='calendar_email_followup_requests' AND column_name='after_date'""")
        ).first()
        assert (
            connection.execute(
                text("SELECT count(*) FROM calendar_email_followup_requests")
            ).scalar_one()
            == 1
        )
    run(migration)
    run(migration)  # re-applying is a no-op
    row = _rows(engine)[0]
    # The earlier schema could not hold after_date, so the rolled-back row is unspecified.
    assert (row["state"], row["after_date"], row["merged_into"]) == (
        "pending",
        "unspecified",
        None,
    )
    with engine.begin() as connection:
        existing = dict(
            connection.execute(text("SELECT * FROM calendar_email_followup_requests"))
            .mappings()
            .one()
        )
    # The previous producer names none of the new columns; its INSERT still works.
    old_columns = (
        "conversation_id,user_id,account_id,evidence_hmac,source_message_hmac,"
        "source_message_ref_ciphertext,source_body_digest,source_internal_date_ms,kind,state,"
        "title_ciphertext,quote_ciphertext,responsibility,last_source_internal_date_ms"
    )
    with engine.begin() as connection:
        connection.execute(
            text(
                f"""INSERT INTO calendar_email_followup_requests ({old_columns})
            SELECT conversation_id,user_id,account_id,:key,source_message_hmac,
            source_message_ref_ciphertext,source_body_digest,source_internal_date_ms,kind,
            'needs_review',title_ciphertext,quote_ciphertext,responsibility,
            last_source_internal_date_ms FROM calendar_email_followup_requests LIMIT 1"""
            ),
            {"key": "e" * 64},
        )
        added = connection.execute(
            text(
                """SELECT after_date,merged_into FROM calendar_email_followup_requests
            WHERE evidence_hmac=:key"""
            ),
            {"key": "e" * 64},
        ).one()
    assert tuple(added) == ("unspecified", None) and existing["state"] == "pending"
    # The new vocabulary is enforced by the database, not only by the application.
    for column, value in (("after_date", "expired"), ("category", "promotion")):
        with pytest.raises(DBAPIError), engine.begin() as connection:
            connection.execute(
                text(f"UPDATE calendar_email_followup_requests SET {column}=:value"),
                {"value": value},
            )
    with engine.begin() as connection:
        connection.execute(
            text("UPDATE calendar_email_followup_requests SET category='scheduled_event'")
        )


@pytest.mark.asyncio
async def test_rolling_back_454_hides_scheduled_events_instead_of_deleting_them(followup_pg):
    service, store, engine = followup_pg
    account_id = await _monitored_account(service)
    message = _message("m-event", "Your exam is on 12 November.")
    await _put(
        store,
        account_id,
        message,
        _ask(
            message,
            "Your exam is on 12 November.",
            "Attend the exam",
            "2026-11-12",
            category="scheduled_event",
            due_relation="on",
            after_date="lapses",
        ),
    )
    rollback = (
        MIGRATIONS / "rollback" / "454_calendar_email_followup_temporal.rollback.sql"
    ).read_text()
    with engine.begin() as connection:
        connection.exec_driver_sql(rollback.replace("BEGIN;", "").replace("COMMIT;", ""))
        row = connection.execute(
            text(
                """SELECT suppressed_at IS NOT NULL,suppression_reason,category
            FROM calendar_email_followup_requests"""
            )
        ).one()
    assert tuple(row) == (True, "rollback_scheduled_event", None)


@pytest.mark.asyncio
async def test_viewing_the_list_and_detail_writes_nothing(followup_pg):
    service, store, engine = followup_pg
    account_id = await _monitored_account(service)
    message = _message("m-read", "Send the signed agreement before 20 November.")
    await _put(
        store,
        account_id,
        message,
        _ask(
            message,
            "Send the signed agreement before 20 November.",
            "Send the signed agreement",
            "2026-11-20",
        ),
    )
    with engine.begin() as connection:
        before = connection.execute(
            text(
                "SELECT id,state,revision,reminder_at,updated_at FROM calendar_email_followup_requests"
            )
        ).all()
        feed = connection.execute(text("SELECT count(*) FROM feed_events")).scalar_one()
        outbox = connection.execute(text("SELECT count(*) FROM system_push_outbox")).scalar_one()
    for view in ("upcoming", "overdue", "snoozed", "history"):
        listing = await _listing(store, account_id, view)
        monitor = await store.monitor(user_id=OWNER, account_id=account_id)
        for conversation in listing["conversations"]:
            await store.detail(monitor, conversation["id"], now=TODAY)
    with engine.begin() as connection:
        assert (
            before
            == connection.execute(
                text(
                    "SELECT id,state,revision,reminder_at,updated_at FROM calendar_email_followup_requests"
                )
            ).all()
        )
        assert feed == connection.execute(text("SELECT count(*) FROM feed_events")).scalar_one()
        assert (
            outbox
            == connection.execute(text("SELECT count(*) FROM system_push_outbox")).scalar_one()
        )


@pytest.mark.asyncio
async def test_read_projections_are_owner_and_account_scoped(followup_pg):
    service, store, engine = followup_pg
    account_id = await _monitored_account(service)
    other_id = await _account(service, "synthetic-c", "c@example.test")
    first = _message("m-owner", "Send the signed agreement before 20 November.")
    other = _message("m-other-account", "Submit the lab record before 20 November.")
    await _put(store, account_id, first, _ask(first, first.body, "Signed agreement", "2026-11-20"))
    await _put(store, other_id, other, _ask(other, other.body, "Lab record", "2026-11-20"))

    first_page = await _listing(store, account_id)
    other_page = await _listing(store, other_id)
    assert _titles(first_page) == ["Signed agreement"]
    assert _titles(other_page) == ["Lab record"]
    assert (
        first_page["view_counts"]
        == other_page["view_counts"]
        == {
            "upcoming": 1,
            "overdue": 0,
            "snoozed": 0,
            "history": 0,
        }
    )
    conversation = first_page["conversations"][0]["id"]
    first_request = first_page["conversations"][0]["preview_requests"][0]["id"]
    other_request = other_page["conversations"][0]["preview_requests"][0]["id"]
    monitor = await store.monitor(user_id=OWNER, account_id=account_id)
    other_monitor = await store.monitor(user_id=OWNER, account_id=other_id)
    foreign_owner = dataclasses.replace(monitor, user_id="synthetic-other-owner")
    assert (await store.list_conversations(foreign_owner, now=TODAY))["total_conversations"] == 0
    for foreign_monitor in (other_monitor, foreign_owner):
        with pytest.raises(FollowupStateError, match="conversation_unavailable"):
            await store.detail(foreign_monitor, conversation, now=TODAY)
    with pytest.raises(FollowupStateError, match="invalid_view"):
        await _listing(store, account_id, view="upcoming') OR TRUE --")

    # The ID-only FK can accept a malformed edge outside the canonical writer.
    with engine.begin() as connection:
        connection.execute(
            text("""UPDATE calendar_email_followup_requests SET merged_into=CAST(:target AS UUID)
                 WHERE id=CAST(:request AS UUID)"""),
            {"target": first_request, "request": other_request},
        )
    detail = await store.detail(monitor, conversation, now=TODAY)
    assert [request["repeat_count"] for request in detail["requests"]] == [0]
    with pytest.raises(FollowupStateError, match="request_unavailable"):
        await store.resolve_request(other_monitor, other_request)
