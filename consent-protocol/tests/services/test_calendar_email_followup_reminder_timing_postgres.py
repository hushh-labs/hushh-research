"""Changing reminder timing never re-sends a reminder the owner already received."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from fastapi import Response
from sqlalchemy import text

from api.routes.one import calendar_email_followups as routes
from hushh_mcp.services.calendar_email_followup_extraction import CompleteAssessment
from tests.google_oauth_postgres_support import OWNER
from tests.services.test_calendar_email_followup_oauth_postgres import (
    followup_pg as followup_pg,
)
from tests.services.test_calendar_email_followup_store_postgres import (
    NOW,
    _candidate,
    _message,
    _monitored_account,
)
from tests.services.test_external_connector_lifecycle_postgres import (
    connector_postgres_url as connector_postgres_url,
)

SENT_QUOTE = "Please send the signed document before 26 November."
OPEN_QUOTE = "Please send the signed invoice before 27 November."
AFTER = datetime(2026, 11, 25, 12, 0, tzinfo=UTC)


async def _store(store, account_id, message, quote, **fields):
    monitor = await store.acquire_scan(user_id=OWNER, account_id=account_id)
    candidate = _candidate(
        message,
        quote,
        kind="deadline",
        title=quote[:30],
        responsibility="owner",
        ambiguities=(),
        due_relation="before",
        **fields,
    )
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


async def _retime(monitor, account_id, hour):
    await routes.preferences(
        routes.PreferenceChange(
            user_id=OWNER,
            account_id=account_id,
            enabled=True,
            historical_start_at=monitor.historical_start_at,
            time_zone=monitor.time_zone,
            reminder_lead_days=monitor.reminder_lead_days,
            reminder_hour=hour,
            notifications_enabled=True,
        ),
        response=Response(),
        firebase_uid=OWNER,
        owner={"user_id": OWNER},
    )


@pytest.mark.asyncio
async def test_new_reminder_hour_retimes_unsent_reminders_but_never_resends_sent_ones(followup_pg):
    service, store, engine = followup_pg
    account_id = await _monitored_account(service)
    sent = _message("m-sent", SENT_QUOTE)
    unsent = _message("m-unsent", OPEN_QUOTE)
    await _store(store, account_id, sent, SENT_QUOTE, due_date="2026-11-26")
    with engine.begin() as connection:
        connection.execute(
            text("UPDATE calendar_email_followup_monitors SET notifications_enabled=TRUE")
        )
    claim = await store.claim_due(now=AFTER)
    assert claim is not None
    assert await store.queue_due(claim, now=AFTER)
    await _store(store, account_id, unsent, OPEN_QUOTE, due_date="2026-12-20")

    def rows():
        with engine.begin() as connection:
            return {
                row[0]: row[1:]
                for row in connection.execute(
                    text(
                        """SELECT due_date::text,revision,reminder_sent_revision,reminder_at
                        FROM calendar_email_followup_requests"""
                    )
                ).all()
            }

    before = rows()
    monitor = await store.monitor(user_id=OWNER, account_id=account_id)
    await _retime(monitor, account_id, (monitor.reminder_hour + 1) % 24)
    after = rows()

    # The reminder already received is left exactly as it was: nothing to send again.
    assert after["2026-11-26"] == before["2026-11-26"]
    assert await store.claim_due(now=AFTER) is None
    # A reminder not yet sent follows the new hour.
    assert after["2026-12-20"][0] == before["2026-12-20"][0] + 1
    assert after["2026-12-20"][2] != before["2026-12-20"][2]
