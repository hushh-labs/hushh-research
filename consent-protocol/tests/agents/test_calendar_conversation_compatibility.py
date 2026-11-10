"""Existing Chat-runner conversation shapes; scripted inference, never live UX proof."""

from __future__ import annotations

import time
from unittest.mock import AsyncMock

import pytest
from google.adk.events import Event, EventActions
from google.adk.sessions import InMemorySessionService
from google.genai import types

from hushh_mcp.agents.calendar import tools
from hushh_mcp.agents.calendar.guest_clarification import STATE_GUEST_CLARIFICATION
from tests.agents.test_calendar_contract_matrix import port_with_event
from tests.agents.test_calendar_guest_clarification import (
    GUEST,
    TERMS,
    GuestModel,
    agent,
    run_turn,
    scope,
    setup_question,
)
from tests.agents.test_calendar_request_scope import call


@pytest.mark.parametrize("personal", [False, True])
async def test_complete_request_goes_directly_to_one_review(monkeypatch, personal):
    monkeypatch.setenv("ENVIRONMENT", "test")
    prompt = (
        "Block my default Calendar for personal planning on 6 November 2030, "
        "09:00–09:30 Asia/Kolkata. No guests."
        if personal
        else "Book Planning on my default Calendar on 6 November 2030, "
        "09:00–09:30 Asia/Kolkata with guest@example.test."
    )
    guests = [] if personal else [GUEST]
    port = port_with_event(monkeypatch)
    port.propose.return_value["plan"].update(
        title="Planning",
        attendees=guests,
        start_at="2030-11-06T03:30:00Z",
        end_at="2030-11-06T04:00:00Z",
        time_zone="Asia/Kolkata",
    )
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: port)
    model = GuestModel(
        [
            [
                call(
                    "propose_calendar_event",
                    **TERMS,
                    attendees=guests,
                    account_id="default",
                    time_zone="Asia/Kolkata",
                )
            ],
            [types.Part(text="Review ready for your confirmation.")],
        ],
        [scope(prompt, allowed=True)],
    )
    store = InMemorySessionService()
    await store.create_session(app_name="one", user_id="owner", session_id="guests")
    responses = await run_turn(store, agent(model), prompt)
    assert len(responses) == 1 and responses[0]["status"] == "confirmation_required"
    assert responses[0]["directive"]["payload"]["attendees"] == guests
    assert not (
        await store.get_session(app_name="one", user_id="owner", session_id="guests")
    ).state.get(STATE_GUEST_CLARIFICATION)
    assert len(model._inputs) == 1 and model._root_calls == 2
    assert model._answers == ["Review ready for your confirmation."]
    port.propose.assert_awaited_once()
    port.list_events.assert_not_awaited()
    port.execute.assert_not_awaited()


@pytest.mark.parametrize(
    "prompt,question",
    [
        (
            "Book a 30-minute Planning meeting with guest@example.test on my default Calendar in Asia/Kolkata.",
            "Which date and start time should I use?",
        ),
        (
            "Book Planning with Alex on my default Calendar on 6 November 2030, 09:00–09:30 Asia/Kolkata.",
            "Which Alex should join? Please share their email address.",
        ),
        (
            "Block my default Calendar on 3 November 2030, 01:30–02:00 America/New_York.",
            "Do you mean the first or second 01:30 during the clock change?",
        ),
    ],
)
async def test_missing_or_ambiguous_details_allow_one_grouped_question(
    monkeypatch, prompt, question
):
    monkeypatch.setenv("ENVIRONMENT", "test")
    port = port_with_event(monkeypatch)
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: port)
    model = GuestModel([[types.Part(text=question)]], [])
    store = InMemorySessionService()
    await store.create_session(app_name="one", user_id="owner", session_id="guests")
    assert await run_turn(store, agent(model), prompt) == []
    assert model._answers == [question] and model._root_calls == 1 and model._inputs == []
    port.propose.assert_not_awaited()
    port.execute.assert_not_awaited()


async def test_ambiguous_account_is_one_question_before_staging(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    port = port_with_event(monkeypatch)
    port.connections.calendar_accounts_status = AsyncMock(
        return_value={
            "accounts": [
                {"account_id": "default", "google_email": "a@example.test"},
                {"account_id": "second", "google_email": "b@example.test"},
            ]
        }
    )
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: port)
    prompt = "Book Planning on 6 November 2030, 09:00–09:30 Asia/Kolkata with guest@example.test."
    model = GuestModel(
        [
            [call("propose_calendar_event", **TERMS, attendees=[GUEST])],
            [types.Part(text="Which connected Calendar account should I use?")],
        ],
        [scope(prompt, allowed=True)],
    )
    store = InMemorySessionService()
    await store.create_session(app_name="one", user_id="owner", session_id="guests")
    responses = await run_turn(store, agent(model), prompt)
    assert responses[0]["reason_code"] == "calendar_account_required"
    assert not responses[0].get("directive")
    port.connections.calendar_accounts_status.assert_awaited_once()
    port.connections.read_grant_binding.assert_not_awaited()
    port.propose.assert_not_awaited()
    port.execute.assert_not_awaited()
    assert len(model._inputs) == 1 and len(model._answers) == 1


@pytest.mark.parametrize(
    "failure,code,message,grant_reads",
    [
        (
            "expired",
            "calendar_guest_context_expired",
            "The booking context expired. Restate the booking request to prepare a fresh review.",
            0,
        ),
        (
            "revoked",
            "calendar_guest_context_revoked",
            "Reconnect the selected Calendar account, then restate the booking request.",
            1,
        ),
        (
            "changed",
            "calendar_connection_changed",
            "The Calendar connection changed. Restate the booking request using the current account.",
            1,
        ),
    ],
)
async def test_invalid_context_explains_specific_recovery_once_without_retry_reads(
    monkeypatch, failure, code, message, grant_reads
):
    store, port, session, _ = await setup_question(monkeypatch)
    if failure == "expired":
        pending = session.state[STATE_GUEST_CLARIFICATION]
        pending["expires_at"] = time.time() - 1
        await store.append_event(
            session,
            Event(
                author="one",
                invocation_id=pending["invocation_id"],
                actions=EventActions(state_delta={STATE_GUEST_CLARIFICATION: pending}),
            ),
        )
    port.connections.read_grant_binding.reset_mock()
    if failure != "expired":
        port.connections.read_grant_binding.return_value = (
            None if failure == "revoked" else ("new-grant",)
        )
    model = GuestModel(
        [
            [call("propose_calendar_event", **TERMS, attendees=[GUEST])],
            [call("propose_calendar_event", **TERMS, attendees=[GUEST])],
            [types.Part(text=message)],
        ],
        [scope(GUEST, allowed=True, continuation=True)],
    )
    responses = await run_turn(store, agent(model), GUEST, clock="2030-11-05T18:30:01Z")
    assert len(responses) == 2 and all(
        r["reason_code"] == code and not r.get("directive") for r in responses
    )
    assert model._answers == [message] and len(model._inputs) == 1
    assert model._recovery[-1]["reason_code"] == code
    assert port.connections.read_grant_binding.await_count == grant_reads
    port.propose.assert_not_awaited()
    port.execute.assert_not_awaited()


async def test_read_only_answer_is_useful_even_after_expired_booking(monkeypatch):
    store, port, session, _ = await setup_question(monkeypatch)
    pending = session.state[STATE_GUEST_CLARIFICATION]
    pending["expires_at"] = time.time() - 1
    await store.append_event(
        session,
        Event(
            author="one",
            invocation_id=pending["invocation_id"],
            actions=EventActions(state_delta={STATE_GUEST_CLARIFICATION: pending}),
        ),
    )
    prompt = "Read my meetings on 6 November 2030 in Asia/Kolkata. Do not book anything."
    answer = "Planning is at 23:00–23:30 Asia/Kolkata."
    model = GuestModel(
        [
            [
                call(
                    "calendar_events",
                    start_at="2030-11-06T00:00:00+05:30",
                    end_at="2030-11-07T00:00:00+05:30",
                )
            ],
            [types.Part(text=answer)],
        ],
        [scope(prompt)],
    )
    result = await run_turn(store, agent(model), prompt)
    assert result[0]["events"][0]["local_start_at"] == "2030-11-06T23:00:00+05:30"
    # A pure read needs no action assessment; the expired booking stays unstaged.
    assert model._answers == [answer] and model._inputs == []
    assert not (
        await store.get_session(app_name="one", user_id="owner", session_id="guests")
    ).state.get("hussh:pending_directive:calendar")
    port.list_events.assert_awaited_once()
    port.propose.assert_not_awaited()
    port.execute.assert_not_awaited()


@pytest.mark.parametrize(
    "reason",
    [
        "google_not_connected",
        "calendar_not_connected",
        "google_reauthorization_required",
        "calendar_reauthorization_required",
    ],
)
async def test_late_provider_revocation_keeps_one_recovery_without_retrying(monkeypatch, reason):
    from hushh_mcp.services.google_connection_contract import GoogleConnectionError

    store, port, _, _ = await setup_question(monkeypatch)
    port.connections.read_grant_binding.reset_mock()
    port.propose = AsyncMock(
        side_effect=GoogleConnectionError(
            "Provider authentication ended", status_code=401, reason_code=reason
        )
    )
    message = "Reconnect the selected Calendar account, then restate the booking request."
    model = GuestModel(
        [
            [call("propose_calendar_event", **TERMS, attendees=[GUEST])],
            [call("propose_calendar_event", **TERMS, attendees=[GUEST])],
            [types.Part(text=message)],
        ],
        [scope(GUEST, allowed=True, continuation=True)],
    )
    results = await run_turn(store, agent(model), GUEST)
    assert len(results) == 2 and all(
        r["reason_code"] == "calendar_guest_context_revoked" and not r.get("directive")
        for r in results
    )
    assert model._answers == [message] and len(model._inputs) == 1
    port.propose.assert_awaited_once()
    port.connections.read_grant_binding.assert_awaited_once()
    port.execute.assert_not_awaited()
