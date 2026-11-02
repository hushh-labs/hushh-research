"""Reassessment keeps the owner's decisions on disposable PostgreSQL.

The evidence key includes the model's title, which a fresh model run rarely
repeats, so these tests key candidates the way the extractor does.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import text

from hushh_mcp.services.calendar_email_followup_extraction import (
    ValidatedCandidate,
    _evidence_identity,
)
from tests.google_oauth_postgres_support import OWNER
from tests.services.test_calendar_email_followup_oauth_postgres import (
    followup_pg as followup_pg,
)
from tests.services.test_calendar_email_followup_store_postgres import (
    _candidate,
    _message,
    _monitored_account,
    _reassess,
    _store_legacy,
)
from tests.services.test_external_connector_lifecycle_postgres import (
    connector_postgres_url as connector_postgres_url,
)

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


@pytest.mark.asyncio
async def test_reassessment_retires_followups_of_mail_the_provider_no_longer_lists(followup_pg):
    """A trashed security alert could never be reassessed, so its row stayed visible."""
    service, store, engine = followup_pg
    account_id = await _monitored_account(service)
    messages = {name: _message(name, _SIGNED) for name in ("m-trashed", "m-listed", "m-finished")}
    for message in messages.values():
        await _store_legacy(
            store, account_id, message, _worded(store, account_id, message, "Send signed doc")
        )
    monitor = await store.monitor(user_id=OWNER, account_id=account_id)
    for conversation in (await store.list_conversations(monitor, limit=10))["conversations"]:
        if conversation["subject"] != "Subject m-finished":
            continue
        request = (await store.detail(monitor, conversation["id"]))["requests"][0]
        await store.mutate_request(
            monitor,
            request_id=request["id"],
            expected_revision=request["revision"],
            idempotency_key=str(uuid.uuid4()),
            action="done",
        )

    leased = await store.acquire_scan(user_id=OWNER, account_id=account_id)
    # Thread listings are complete: the trashed and finished threads list nothing.
    assert await store.retire_unlisted_stale(leased, "thread-m-trashed", []) == 1
    assert await store.retire_unlisted_stale(leased, "thread-m-listed", ["m-listed"]) == 0
    assert await store.retire_unlisted_stale(leased, "thread-m-finished", []) == 0
    # Replaying the same listing changes nothing.
    assert await store.retire_unlisted_stale(leased, "thread-m-trashed", []) == 0
    await store.release_scan(leased)

    assert _message_rows(engine, store, account_id, messages["m-trashed"]) == [
        ("source_unavailable", False, 1)
    ]
    assert _message_rows(engine, store, account_id, messages["m-listed"]) == [("pending", False, 1)]
    # The owner's decision is never rewritten.
    assert _message_rows(engine, store, account_id, messages["m-finished"]) == [("done", False, 1)]
    monitor = await store.monitor(user_id=OWNER, account_id=account_id)
    # Only the thread the provider still lists is left to reassess.
    assert await store.stale_assessment_threads(monitor, cutoff_ms=0, limit=10) == [
        "thread-m-listed"
    ]
