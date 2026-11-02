"""Store contracts on disposable PostgreSQL: ordering, non-destructive opt-in, backoff.

Each test reproduces a UAT defect found while tracing the Follow-ups flow.
"""

from __future__ import annotations

import hashlib
import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import Response
from sqlalchemy import text

from api.routes.one import calendar_email_followups as routes
from hushh_mcp.services.calendar_email_followup_extraction import (
    CompleteAssessment,
    ValidatedCandidate,
    _evidence_identity,
)
from hushh_mcp.services.calendar_email_followup_reader import (
    CompleteMailMessage,
    split_complete_body,
)
from tests.google_oauth_postgres_support import OWNER
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

HISTORICAL = datetime(2026, 10, 1, tzinfo=UTC)
NOW = datetime(2026, 11, 1, 6, 0, tzinfo=UTC)


async def _monitored_account(service, *, lookback: datetime = HISTORICAL) -> str:
    account_id = await _add_calendar(service, "synthetic-b", "b@example.test")
    await _connect_mail(service, account_id, "synthetic-b")
    await routes.preferences(
        routes.PreferenceChange(
            user_id=OWNER,
            account_id=account_id,
            enabled=True,
            historical_start_at=lookback,
            time_zone="Asia/Kolkata",
        ),
        response=Response(),
        firebase_uid=OWNER,
        owner={"user_id": OWNER},
    )
    return account_id


def _message(message_id: str, body: str, *, sender: str = "Jhumma <j@example.test>"):
    return CompleteMailMessage(
        message_id=message_id,
        thread_id="thread-" + message_id,
        internal_date_ms=int(datetime(2026, 10, 10, tzinfo=UTC).timestamp() * 1000),
        subject="Subject " + message_id,
        sender=sender,
        body=body,
        body_digest=hashlib.sha256(body.encode()).hexdigest(),
        sections=split_complete_body(body, max_section_bytes=4000, overlap_chars=120),
    )


def _candidate(message: CompleteMailMessage, quote: str, **fields) -> ValidatedCandidate:
    base = dict(
        evidence_key=hashlib.sha256((message.message_id + quote).encode()).hexdigest(),
        message_id=message.message_id,
        thread_id=message.thread_id,
        body_digest=message.body_digest,
        source_internal_date_ms=message.internal_date_ms,
        kind="action",
        global_quote_start=message.body.index(quote),
        quote=quote,
        title=quote[:60],
        original_due_wording=None,
        due_date=None,
        due_relation=None,
        proposed_date=None,
        proposed_at=None,
        time_zone=None,
        responsibility="unclear",
        ambiguities=("date",),
    )
    base.update(fields)
    return ValidatedCandidate(**base)


async def _commit(store, account_id, message, candidate) -> None:
    monitor = await store.acquire_scan(user_id=OWNER, account_id=account_id)
    assert monitor is not None
    await store.commit_message(
        monitor,
        message,
        CompleteAssessment(
            expected_sections=len(message.sections),
            completed_sections=len(message.sections),
            candidates=(candidate,),
            updates=(),
        ),
        now=NOW,
    )
    await store.release_scan(monitor)
    with store.db.engine.begin() as connection:
        connection.execute(text("UPDATE calendar_email_followup_monitors SET next_scan_at=NOW()"))


@pytest.mark.asyncio
async def test_undated_review_item_never_outranks_a_dated_request(followup_pg):
    """Rank 0 used to be an undated needs_review row, so noise led the card."""
    service, store, _ = followup_pg
    account_id = await _monitored_account(service)
    noisy = _message("m-noise", "Please check your account activity.")
    dated = _message("m-dated", "Please send the signed document before 26 November.")
    await _commit(
        store, account_id, noisy, _candidate(noisy, "Please check your account activity.")
    )
    await _commit(
        store,
        account_id,
        dated,
        _candidate(
            dated,
            "Please send the signed document before 26 November.",
            kind="deadline",
            title="Send the signed document",
            responsibility="owner",
            ambiguities=(),
            due_date="2026-11-26",
            due_relation="before",
        ),
    )
    monitor = await store.monitor(user_id=OWNER, account_id=account_id)
    listing = await store.list_conversations(monitor, limit=10)
    titles = [item["preview_requests"][0]["title"] for item in listing["conversations"]]
    assert titles[0] == "Send the signed document"


@pytest.mark.asyncio
async def test_changing_lookback_or_regranting_keeps_requests_and_user_decisions(followup_pg):
    """configure() deleted the monitor, and with it every request, on these changes."""
    service, store, _ = followup_pg
    account_id = await _monitored_account(service)
    message = _message("m-keep", "Please send the signed document before 26 November.")
    await _commit(
        store,
        account_id,
        message,
        _candidate(
            message,
            "Please send the signed document before 26 November.",
            kind="deadline",
            title="Send the signed document",
            responsibility="owner",
            ambiguities=(),
            due_date="2026-11-26",
            due_relation="before",
        ),
    )
    monitor = await store.monitor(user_id=OWNER, account_id=account_id)
    request = (
        await store.detail(
            monitor, (await store.list_conversations(monitor))["conversations"][0]["id"]
        )
    )["requests"][0]
    await store.mutate_request(
        monitor,
        request_id=request["id"],
        expected_revision=request["revision"],
        idempotency_key="00000000-0000-4000-8000-000000000001",
        action="done",
    )
    grant = await __import__(
        "hushh_mcp.services.calendar_email_followup_account", fromlist=["x"]
    ).open_selected_mail_grant(user_id=OWNER, account_id=account_id)

    # A wider lookback and a re-issued grant epoch for the same mailbox.
    await store.configure(
        user_id=OWNER,
        account_id=account_id,
        enabled=True,
        grant_epoch_digest="f" * 64,
        provider_subject_sha256=grant.provider_subject_sha256,
        mail_generation=grant.mail_generation,
        calendar_connected_at=grant.calendar_connected_at,
        calendar_grant_revision=grant.calendar_grant_revision,
        historical_start_at=HISTORICAL - timedelta(days=60),
        time_zone="Asia/Kolkata",
        notifications_enabled=False,
    )
    with store.db.engine.begin() as connection:
        survivors = connection.execute(
            text("SELECT state FROM calendar_email_followup_requests WHERE user_id=:owner"),
            {"owner": OWNER},
        ).all()
    assert [row[0] for row in survivors] == ["done"]


@pytest.mark.asyncio
async def test_reminder_timing_change_keeps_scan_progress(followup_pg):
    """A schedule edit reset the generation and checkpoint, forcing a full rescan."""
    service, store, _ = followup_pg
    account_id = await _monitored_account(service)
    monitor = await store.acquire_scan(user_id=OWNER, account_id=account_id)
    await store.save_checkpoint(
        monitor, {"version": 1, "mode": "history", "history_id": "42"}, state="complete"
    )
    await store.release_scan(monitor)
    before = await store.monitor(user_id=OWNER, account_id=account_id)
    grant = await __import__(
        "hushh_mcp.services.calendar_email_followup_account", fromlist=["x"]
    ).open_selected_mail_grant(user_id=OWNER, account_id=account_id)
    after = await store.configure(
        user_id=OWNER,
        account_id=account_id,
        enabled=True,
        grant_epoch_digest=before.grant_epoch_digest,
        provider_subject_sha256=grant.provider_subject_sha256,
        mail_generation=grant.mail_generation,
        calendar_connected_at=grant.calendar_connected_at,
        calendar_grant_revision=grant.calendar_grant_revision,
        historical_start_at=before.historical_start_at,
        time_zone="Asia/Kolkata",
        notifications_enabled=True,
        reminder_lead_days=2,
        reminder_hour=8,
    )
    assert after.generation == before.generation
    assert (after.checkpoint or {}).get("history_id") == "42"


@pytest.mark.asyncio
async def test_failed_scan_backs_off_instead_of_retrying_every_scheduler_tick(followup_pg):
    """Any non-complete state used to set next_scan_at=NOW(): a retry storm."""
    service, store, _ = followup_pg
    account_id = await _monitored_account(service)
    for failures in (1, 2, 3):
        monitor = await store.acquire_scan(user_id=OWNER, account_id=account_id)
        assert monitor is not None
        await store.save_checkpoint(
            monitor,
            {"version": 1, "mode": "history", "history_id": "42"},
            state="partial",
            error_code="mail_temporarily_unavailable",
        )
        await store.release_scan(monitor)
        with store.db.engine.begin() as connection:
            delay = connection.execute(
                text(
                    """SELECT EXTRACT(EPOCH FROM (next_scan_at-NOW())) FROM
                    calendar_email_followup_monitors WHERE user_id=:owner"""
                ),
                {"owner": OWNER},
            ).scalar_one()
            connection.execute(
                text("UPDATE calendar_email_followup_monitors SET next_scan_at=NOW()")
            )
        assert delay > 15 * (2 ** (failures - 1)) * 0.5, (failures, delay)
        assert delay <= 15 * 60 + 1


async def _store_legacy(store, account_id, message, candidate) -> None:
    """Write a row the way the earlier release did: no relevance assessment."""
    await _commit(store, account_id, message, candidate)
    with store.db.engine.begin() as connection:
        connection.execute(text("UPDATE calendar_email_followup_requests SET assessment_version=1"))
        connection.execute(
            text("UPDATE calendar_email_followup_scanned_messages SET assessment_version=1")
        )


async def _reassess(store, account_id, message, candidates) -> None:
    monitor = await store.acquire_scan(user_id=OWNER, account_id=account_id)
    assert monitor is not None
    await store.commit_message(
        monitor,
        message,
        CompleteAssessment(
            expected_sections=len(message.sections),
            completed_sections=len(message.sections),
            candidates=tuple(candidates),
            updates=(),
        ),
        now=NOW,
        reassess=True,
    )
    await store.release_scan(monitor)


async def _seed_legacy_rows(store, engine, account_id):
    """Three rows stored by the earlier release: two false positives and one real ask."""
    alert = _message("m-alert", "Google security alert. Please check activity on your account.")
    real = _message("m-real", "Please send the signed document before 26 November.")
    decided = _message("m-decided", "Please review your account activity today.")
    real_candidate = _candidate(
        real,
        "Please send the signed document before 26 November.",
        kind="deadline",
        title="Send the signed document",
        responsibility="owner",
        ambiguities=(),
        due_date="2026-11-26",
        due_relation="before",
    )
    await _store_legacy(
        store, account_id, alert, _candidate(alert, "Please check activity on your account.")
    )
    await _store_legacy(store, account_id, real, real_candidate)
    await _store_legacy(
        store,
        account_id,
        decided,
        _candidate(decided, "Please review your account activity today."),
    )
    ids = {}
    with engine.begin() as connection:
        for message in (alert, real, decided):
            ids[message.message_id] = str(
                connection.execute(
                    text(
                        "SELECT id FROM calendar_email_followup_requests "
                        "WHERE source_message_hmac=:h"
                    ),
                    {"h": store.cipher.digest(OWNER, account_id, "message", message.message_id)},
                ).scalar_one()
            )
    return (alert, real, decided), real_candidate, ids


def _add_reminder_event(engine, account_id, request_id):
    with engine.begin() as connection:
        connection.execute(
            text(
                """INSERT INTO feed_events (user_id,source_domain,event_type,source_row_id,metadata)
                VALUES (:owner,'calendar_email_followup','followup_reminder',:row,
                        CAST(:meta AS JSONB))"""
            ),
            {
                "owner": OWNER,
                "row": request_id + ":1",
                "meta": '{"request_id": "%s", "account_id": "%s"}' % (request_id, account_id),
            },
        )


def _row_states(engine, ids):
    with engine.begin() as connection:
        state = {
            message_id: connection.execute(
                text(
                    """SELECT state,suppressed_at IS NOT NULL,assessment_version,
                    reminder_at IS NOT NULL FROM calendar_email_followup_requests
                    WHERE id=CAST(:id AS UUID)"""
                ),
                {"id": request_id},
            ).one()
            for message_id, request_id in ids.items()
        }
        feed_left = connection.execute(
            text("SELECT count(*) FROM feed_events WHERE source_domain='calendar_email_followup'")
        ).scalar_one()
    return state, feed_left


@pytest.mark.asyncio
async def test_reassessment_hides_false_positives_but_keeps_real_requests_and_decisions(
    followup_pg,
):
    """Existing rows from the earlier release are corrected without losing owner choices."""
    service, store, engine = followup_pg
    account_id = await _monitored_account(service)
    (alert, real, decided), real_candidate, ids = await _seed_legacy_rows(store, engine, account_id)
    monitor = await store.monitor(user_id=OWNER, account_id=account_id)
    # The owner already dismissed one false positive; a reminder sits in the Feed for another.
    await store.mutate_request(
        monitor,
        request_id=ids["m-decided"],
        expected_revision=1,
        idempotency_key="00000000-0000-4000-8000-000000000002",
        action="dismiss",
    )
    _add_reminder_event(engine, account_id, ids["m-alert"])

    stale = await store.stale_assessment_threads(monitor, cutoff_ms=0, limit=10)
    assert sorted(stale) == ["thread-m-alert", "thread-m-decided", "thread-m-real"]

    # The current assessment stands behind only the real request.
    await _reassess(store, account_id, alert, [])
    await _reassess(store, account_id, real, [real_candidate])
    await _reassess(store, account_id, decided, [])

    monitor = await store.monitor(user_id=OWNER, account_id=account_id)
    visible = [
        request["title"]
        for conversation in (await store.list_conversations(monitor, limit=10))["conversations"]
        for request in conversation["preview_requests"]
    ]
    assert visible == ["Send the signed document"]
    state, feed_left = _row_states(engine, ids)
    assert state["m-alert"][:2] == ("needs_review", True)
    assert state["m-alert"][3] is False
    # The owner's own decision is preserved, not rewritten by reclassification.
    assert state["m-decided"][:2] == ("dismissed", True)
    assert state["m-real"][:3] == ("pending", False, 2)
    assert state["m-real"][3] is True
    assert feed_left == 0
    assert await store.stale_assessment_threads(monitor, cutoff_ms=0, limit=10) == []


@pytest.mark.asyncio
async def test_deleted_source_mail_retires_active_followups_and_keeps_finished_ones(followup_pg):
    service, store, engine = followup_pg
    account_id = await _monitored_account(service)
    open_message = _message("m-open", "Please send the signed document before 26 November.")
    done_message = _message("m-done", "Please send the signed invoice before 27 November.")
    for message, quote, title in (
        (open_message, "Please send the signed document before 26 November.", "Send the document"),
        (done_message, "Please send the signed invoice before 27 November.", "Send the invoice"),
    ):
        await _commit(
            store,
            account_id,
            message,
            _candidate(
                message,
                quote,
                kind="deadline",
                title=title,
                responsibility="owner",
                ambiguities=(),
                due_date="2026-11-26",
                due_relation="before",
            ),
        )
    monitor = await store.monitor(user_id=OWNER, account_id=account_id)
    done_id = None
    for conversation in (await store.list_conversations(monitor, limit=10))["conversations"]:
        for request in (await store.detail(monitor, conversation["id"]))["requests"]:
            if request["title"] == "Send the invoice":
                done_id = request
    await store.mutate_request(
        monitor,
        request_id=done_id["id"],
        expected_revision=done_id["revision"],
        idempotency_key="00000000-0000-4000-8000-000000000003",
        action="done",
    )

    leased = await store.acquire_scan(user_id=OWNER, account_id=account_id)
    gone = [("m-open", "thread-m-open"), ("m-done", "thread-m-done")]
    assert await store.mark_messages_gone(leased, gone) == 1
    # A restart that replays the same history page repeats a no-op.
    assert await store.mark_messages_gone(leased, gone) == 0
    await store.release_scan(leased)

    with engine.begin() as connection:
        states = sorted(
            row[0]
            for row in connection.execute(
                text("SELECT state FROM calendar_email_followup_requests")
            ).all()
        )
    assert states == ["done", "source_unavailable"]
    monitor = await store.monitor(user_id=OWNER, account_id=account_id)
    assert (await store.list_conversations(monitor, limit=10))["total_conversations"] == 0


_SIGNED = "Please send the signed document before 26 November."


def _worded(store, account_id, message, title, **fields) -> ValidatedCandidate:
    """A candidate keyed the way the extractor keys it, so the title is part of the key."""
    identity = _evidence_identity(
        message,
        SimpleNamespace(kind="deadline", source_quote=_SIGNED, title=title),
        message.body.index(_SIGNED),
        store.cipher.evidence_key(OWNER, account_id),
    )
    return _candidate(
        message,
        _SIGNED,
        evidence_key=identity,
        kind="deadline",
        title=title,
        responsibility="owner",
        ambiguities=(),
        **{"due_date": "2026-11-26", "due_relation": "before", **fields},
    )


def _message_rows(engine, store, account_id, message):
    with engine.begin() as connection:
        return connection.execute(
            text(
                """SELECT state,suppressed_at IS NOT NULL,assessment_version
                FROM calendar_email_followup_requests
                WHERE user_id=:owner AND account_id=:account AND source_message_hmac=:hmac
                ORDER BY created_at"""
            ),
            {
                "owner": OWNER,
                "account": account_id,
                "hmac": store.cipher.digest(OWNER, account_id, "message", message.message_id),
            },
        ).all()


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["done", "dismiss"])
async def test_reassessment_keeps_a_decision_when_the_model_rewords_the_title(followup_pg, action):
    """The evidence key includes the title, which a fresh model run rarely repeats."""
    service, store, engine = followup_pg
    account_id = await _monitored_account(service)
    message = _message("m-reworded", _SIGNED)
    await _store_legacy(
        store, account_id, message, _worded(store, account_id, message, "Send signed doc")
    )
    monitor = await store.monitor(user_id=OWNER, account_id=account_id)
    request = None
    for conversation in (await store.list_conversations(monitor, limit=10))["conversations"]:
        request = (await store.detail(monitor, conversation["id"]))["requests"][0]
    await store.mutate_request(
        monitor,
        request_id=request["id"],
        expected_revision=request["revision"],
        idempotency_key=str(uuid.uuid4()),
        action=action,
    )
    closed = "done" if action == "done" else "dismissed"

    reworded = _worded(store, account_id, message, "Send the signed document")
    await _reassess(store, account_id, message, [reworded])
    # The same row stands behind the new wording: decision kept, nothing duplicated.
    assert _message_rows(engine, store, account_id, message) == [(closed, False, 2)]
    # Reassessing again finds the adopted row by its new key and adds nothing.
    await _reassess(store, account_id, message, [reworded])
    assert _message_rows(engine, store, account_id, message) == [(closed, False, 2)]
    monitor = await store.monitor(user_id=OWNER, account_id=account_id)
    assert (await store.list_conversations(monitor, limit=10))["total_conversations"] == 0


@pytest.mark.asyncio
async def test_reassessment_does_not_adopt_a_row_for_a_different_obligation(followup_pg):
    service, store, engine = followup_pg
    account_id = await _monitored_account(service)
    message = _message("m-different", _SIGNED)
    await _store_legacy(
        store, account_id, message, _worded(store, account_id, message, "Send signed doc")
    )
    # Similar wording, but the assessment now reads a different deadline: a new obligation.
    await _reassess(
        store,
        account_id,
        message,
        [_worded(store, account_id, message, "Send the signed document", due_date="2026-12-01")],
    )
    assert _message_rows(engine, store, account_id, message) == [
        ("pending", True, 1),
        ("pending", False, 2),
    ]
