"""A voice mail draft becomes open only after the client mounts its review card."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from hushh_mcp.one_voice import private_pending, protocol
from hushh_mcp.one_voice.config import OneVoiceLiveConfig
from hushh_mcp.one_voice.session import AuthResult, VoiceSession
from hushh_mcp.one_voice.tickets import TicketClaims
from hushh_mcp.one_voice.tools import mail
from hushh_mcp.one_voice.tools.executor import ToolExecutor
from tests.one_voice.fakes import (
    FakeLive,
    FakeTransport,
    MemoryConversationStore,
    MemoryPendingStore,
    live_factory_for,
)
from tests.one_voice.test_tools_people import AYESHA, OWNER, ConnectionsDouble, LocationDouble

CONV = "11111111-2222-4333-8444-555555555555"
MESSAGE = "I will send the demo tomorrow. " + "A" * 220
CONFIG = OneVoiceLiveConfig(
    enabled=True,
    model_id="gemini-live-2.5-flash-native-audio",
    location="us-central1",
    idle_close_seconds=5,
    session_max_minutes=30,
)
CLAIMS = TicketClaims(
    user_id=OWNER,
    session_id="mail-session",
    conversation_id=CONV,
    expires_at=9_999_999_999,
    nonce="test",
)
FIXTURE_TOKEN = "voice-mail-fixture"


@pytest.fixture
async def draft_session(monkeypatch):
    settings = SimpleNamespace(app_signing_key="voice-mail-test-signing-key")
    monkeypatch.setattr(mail, "get_core_security_settings", lambda: settings)
    monkeypatch.setattr(private_pending, "get_core_security_settings", lambda: settings)

    async def auth(_frame, _claims):
        return AuthResult(
            user_id=OWNER,
            vault_owner_token=FIXTURE_TOKEN,
            firebase_id_token=None,
            display_name="Owner",
        )

    now = [100.0]
    transport = FakeTransport()
    live = FakeLive([])
    pending = MemoryPendingStore()
    session = VoiceSession(
        transport=transport,
        config=CONFIG,
        claims=CLAIMS,
        verify_auth=auth,
        live_factory=live_factory_for(live),
        executor=ToolExecutor(pending_store=pending),
        conversations=MemoryConversationStore(),
        pending=pending,
        clock=lambda: now[0],
    )
    await session._open_conversation(
        AuthResult(
            user_id=OWNER,
            vault_owner_token=FIXTURE_TOKEN,
            firebase_id_token=None,
            display_name="Owner",
        )
    )
    session.live = live
    session.ctx.services.update({"connections": ConnectionsDouble(), "location": LocationDouble()})

    found = await session.executor.call(
        session.ctx,
        "resolve_person",
        {"spoken_name": "Ayesha Sharma", "pool": "connections"},
    )
    assert found.result.status in {"single_likely", "multiple"}
    assert AYESHA in session.ctx.entities.offered_person_ids
    confirmed_person = await session.executor.call(
        session.ctx, "confirm_person", {"user_id": AYESHA}
    )
    assert confirmed_person.result.status == "confirmed"

    turn_id = session.turn.turn_id
    session._latest_input_turn_id = turn_id
    prepared = await session.executor.call(
        session.ctx,
        "send_mail",
        {
            "recipient": {"user_id": AYESHA},
            "subject": "Demo tomorrow",
            "message": MESSAGE,
        },
        origin_turn_id=turn_id,
    )
    assert prepared.result.status == "confirmation_required"
    assert prepared.pending is not None
    row_id = prepared.pending.id
    await pending.mark_shown(user_id=OWNER, pending_action_id=row_id)
    confirmed = await session.executor.call(
        session.ctx, "confirm_pending_action", {"pending_action_id": row_id}
    )
    assert confirmed.result.status == "draft_open_requested"
    await session._after_execution(confirmed, source="voice", origin_turn_id=turn_id)
    step = transport.frames("client_step.request")[-1]
    assert step["kind"] == "open_mail_draft"
    return session, transport, live, pending, row_id, step, now


def _events(live: FakeLive) -> list[dict]:
    return [json.loads(event.removeprefix("[ONE_EVENT] ")) for event in live.events_sent]


@pytest.mark.asyncio
async def test_draft_remains_interim_until_the_review_card_reports_mounted(draft_session):
    session, transport, live, pending, row_id, step, _now = draft_session
    row = pending.rows[row_id]
    assert row.status == "executed"
    assert row.result == {"status": "draft_open_requested", "needs": "client_step"}
    assert transport.frames("tool.result")[-1]["ok"] is False
    assert transport.frames("state")[-1]["state"] != "complete"
    assert not any(event.get("status") == "draft_opened" for event in _events(live))

    await session._client_step_result(
        protocol.ClientStepResultFrame(
            type="client_step.result",
            step_id=step["step_id"],
            status="ok",
            payload={"mounted": True},
        )
    )
    assert row.result == {"status": "draft_opened", "needs": None}
    settled = transport.frames("pending_action.resolved")[-1]
    assert settled["pending_action_id"] == row_id
    assert settled["result_public"] == {"status": "draft_opened", "needs": None}
    assert _events(live)[-1] == {
        "kind": "client_step",
        "step": "open_mail_draft",
        "status": "ok",
        "spoken_facts": ["The draft is open for review. It has not been sent."],
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status,payload,expected",
    [
        ("failed", {}, "draft_not_opened"),
        ("ok", {"mounted": False}, "draft_not_opened"),
        ("failed", {"reason": "timeout"}, "draft_open_unconfirmed"),
    ],
)
async def test_failed_or_timed_out_client_step_never_claims_opened(
    draft_session, status, payload, expected
):
    session, transport, live, pending, row_id, step, _now = draft_session
    await session._client_step_result(
        protocol.ClientStepResultFrame(
            type="client_step.result", step_id=step["step_id"], status=status, payload=payload
        )
    )
    assert pending.rows[row_id].status == "failed"
    assert pending.rows[row_id].result == {"status": expected, "needs": None}
    assert transport.frames("pending_action.resolved")[-1]["result_public"]["status"] == expected
    assert _events(live)[-1]["status"] == "failed"
    assert "Nothing was sent" in _events(live)[-1]["spoken_facts"][0]


@pytest.mark.asyncio
async def test_late_mounted_report_does_not_claim_draft_opened(draft_session):
    session, transport, live, pending, row_id, step, now = draft_session
    now[0] = session.client_steps[step["step_id"]]["expires_at"] + 1
    await session._client_step_result(
        protocol.ClientStepResultFrame(
            type="client_step.result",
            step_id=step["step_id"],
            status="ok",
            payload={"mounted": True},
        )
    )
    assert pending.rows[row_id].status == "failed"
    assert transport.frames("pending_action.resolved")[-1]["result_public"]["status"] == (
        "draft_open_unconfirmed"
    )
    assert _events(live)[-1]["status"] == "failed"
    assert "couldn't confirm" in _events(live)[-1]["spoken_facts"][0]


@pytest.mark.asyncio
async def test_watchdog_settles_an_unreported_mail_step_as_unconfirmed(draft_session):
    session, transport, live, pending, row_id, step, now = draft_session
    now[0] = session.client_steps[step["step_id"]]["expires_at"] + 1
    session.started_at = now[0]
    session.last_activity = now[0]
    watchdog = asyncio.create_task(session._watchdog())
    try:
        await asyncio.wait_for(_wait_for_resolution(pending, row_id), timeout=3)
    finally:
        session._closed = True
        await asyncio.wait_for(watchdog, timeout=3)

    assert step["step_id"] not in session.client_steps
    assert pending.rows[row_id].status == "failed"
    assert pending.rows[row_id].result == {"status": "draft_open_unconfirmed", "needs": None}
    assert transport.frames("pending_action.resolved")[-1]["result_public"] == (
        pending.rows[row_id].result
    )
    assert _events(live)[-1]["status"] == "failed"
    assert "couldn't confirm" in _events(live)[-1]["spoken_facts"][0]


async def _wait_for_resolution(pending: MemoryPendingStore, row_id: str) -> None:
    while (pending.rows[row_id].result or {}).get("status") == "draft_open_requested":
        await asyncio.sleep(0.01)


@pytest.mark.asyncio
async def test_session_close_settles_unreported_mail_step_without_claiming_it_opened(draft_session):
    session, _transport, live, pending, row_id, step, _now = draft_session
    prior_events = list(live.events_sent)
    await session._close(protocol.CLOSE_ENDED, "ended")
    await session._record_close()

    assert step["step_id"] not in session.client_steps
    assert pending.rows[row_id].status == "failed"
    assert pending.rows[row_id].result == {"status": "draft_open_unconfirmed", "needs": None}
    assert live.events_sent == prior_events


@pytest.mark.asyncio
async def test_stale_ack_settles_its_own_card_without_replaying_client_payload(draft_session):
    session, transport, live, pending, row_id, step, _now = draft_session
    prior_events = list(live.events_sent)
    session._latest_input_turn_id = "newer-turn"
    marker = "client-only-untrusted-secret"
    await session._client_step_result(
        protocol.ClientStepResultFrame(
            type="client_step.result",
            step_id=step["step_id"],
            status="ok",
            payload={"mounted": True, "draft": {"body": marker}},
        )
    )
    assert pending.rows[row_id].result == {"status": "draft_opened", "needs": None}
    assert transport.frames("pending_action.resolved")[-1]["pending_action_id"] == row_id
    assert live.events_sent == prior_events
    assert marker not in "".join(live.events_sent)
