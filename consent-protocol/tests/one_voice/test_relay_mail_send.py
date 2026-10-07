"""A voice mail draft becomes open only after the client mounts its review card."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
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


@pytest.mark.asyncio
async def test_an_unrecordable_mounted_report_is_unverified_never_opened(
    draft_session, monkeypatch
):
    """Storage cannot record the mount: no draft_opened, no "sent", no new
    draft and no silence -- the person hears the state could not be verified,
    the card reads "may be open", and the session keeps running."""
    from hushh_mcp.one_voice.pending_actions import PendingActionStorageError

    session, transport, live, pending, row_id, step, _now = draft_session

    async def unavailable(**_kwargs):
        raise PendingActionStorageError("Voice storage is temporarily unavailable.")

    monkeypatch.setattr(pending, "settle_mail_draft_step", unavailable)
    await session._client_step_result(
        protocol.ClientStepResultFrame(
            type="client_step.result",
            step_id=step["step_id"],
            status="ok",
            payload={"mounted": True},
        )
    )

    resolved = transport.frames("pending_action.resolved")[-1]
    assert resolved["pending_action_id"] == row_id
    assert resolved["result_public"] == {
        "status": "draft_open_unconfirmed",
        "needs": None,
        "reason_code": "storage_unavailable",
    }
    assert _events(live)[-1] == {
        "kind": "client_step",
        "step": "open_mail_draft",
        "status": "failed",
        "reason_code": "storage_unavailable",
        "spoken_facts": ["I couldn't verify the draft review state just now. Nothing was sent."],
    }
    assert not any(event.get("status") == "ok" for event in _events(live))
    assert session.close_code is None
    assert len(transport.frames("client_step.request")) == 1, "no second draft"
    # The ledger row is left for storage's own recovery, never marked opened.
    assert pending.rows[row_id].result == {"status": "draft_open_requested", "needs": "client_step"}


@pytest.mark.asyncio
async def test_a_draft_row_that_can_no_longer_be_settled_is_reported_unverified(draft_session):
    """The earlier resolve never landed (or storage already recovered the row):
    the mounted report proves nothing to the ledger, so it is not silence and
    not success."""
    session, transport, live, pending, row_id, step, _now = draft_session
    pending.rows[row_id].status = "confirmed"
    pending.rows[row_id].result = None
    pending.rows[row_id].args["_sealed_args"] = "v1:still-at-rest"

    await session._client_step_result(
        protocol.ClientStepResultFrame(
            type="client_step.result",
            step_id=step["step_id"],
            status="ok",
            payload={"mounted": True},
        )
    )

    resolved = transport.frames("pending_action.resolved")[-1]
    assert resolved["result_public"]["status"] == "draft_open_unconfirmed"
    assert resolved["result_public"]["reason_code"] == "draft_not_settled"
    assert _events(live)[-1]["status"] == "failed"
    assert _events(live)[-1]["spoken_facts"] == [
        "I couldn't verify the draft review state just now. Nothing was sent."
    ]
    # The ledger row is closed the way storage's own recovery would close it,
    # and the sealed dictation does not stay at rest until expiry.
    assert pending.rows[row_id].status == "failed"
    assert pending.rows[row_id].result == {"status": "draft_open_unconfirmed", "needs": None}
    assert "_sealed_args" not in pending.rows[row_id].args


@pytest.fixture
async def reviewed_mail(draft_session, monkeypatch):
    from unittest.mock import AsyncMock

    from hushh_mcp.one_voice.tools import mail_recipients
    from hushh_mcp.one_voice.tools.mail_compose import MailComposeRuntime

    session, transport, live, pending, *_ = draft_session
    monkeypatch.setattr(
        mail_recipients,
        "get_core_security_settings",
        lambda: SimpleNamespace(app_signing_key="voice-mail-test-signing-key"),
    )
    delivery = SimpleNamespace(
        prepare=AsyncMock(
            return_value={
                "action_id": "22222222-2222-4222-8222-222222222222",
                "state": "prepared",
                "sender_token": "private-sender-review",
                "sender_label": "owner@example.com",
                "expires_at": datetime.now(timezone.utc) + timedelta(minutes=10),
            }
        ),
        execute=AsyncMock(
            return_value={"action_id": "22222222-2222-4222-8222-222222222222", "state": "sent"}
        ),
        cancel_prepared=AsyncMock(return_value={"cancelled": True, "state": "cancelled"}),
    )
    session.ctx.services["mail_compose"] = MailComposeRuntime(review_supported=True)
    session.ctx.services["gmail_delivery"] = delivery
    session.executor._actor_proof = AsyncMock(return_value="ok")
    created = await session.executor.call(
        session.ctx,
        "compose_mail",
        {"recipients": [{"kind": "address", "address": "friend@example.com"}], "message": "Hi"},
    )
    assert created.result.status == "review_requested"
    await session._after_execution(created, source="voice", origin_turn_id=session.turn.turn_id)
    step = transport.frames("client_step.request")[-1]
    assert step["kind"] == "review_mail_draft"
    return session, transport, live, pending, delivery, created, step


async def _ack_review(harness, **override):
    session, _transport, _live, _pending, _delivery, created, step = harness
    payload = {
        "mounted": True,
        "draft_ref": created.result.draft_ref,
        "revision": created.result.revision,
        "action_id": "22222222-2222-4222-8222-222222222222",
        **override,
    }
    await session._client_step_result(
        protocol.ClientStepResultFrame(
            type="client_step.result", step_id=step["step_id"], status="ok", payload=payload
        )
    )


@pytest.mark.asyncio
async def test_spoken_send_requires_exact_render_and_fresh_send_approval(reviewed_mail):
    session, transport, live, pending, delivery, created, _ = reviewed_mail
    args = {"draft_ref": created.result.draft_ref, "revision": created.result.revision}
    before = await session.executor.call(session.ctx, "send_reviewed_mail", args)
    assert before.result.reason_code == "draft_not_reviewed"
    await _ack_review(reviewed_mail)
    assert _events(live)[-1]["status"] == "review_ready"
    proposal = await session.executor.call(
        session.ctx, "send_reviewed_mail", args, origin_turn_id=session.turn.turn_id
    )
    assert proposal.result.status == "confirmation_required", proposal.result.public()
    delivery.execute.assert_not_awaited()
    assert proposal.pending is not None
    await pending.mark_shown(user_id=OWNER, pending_action_id=proposal.pending.id)
    confirmed = await session.executor.call(
        session.ctx, "confirm_pending_action", {"pending_action_id": proposal.pending.id}
    )
    assert confirmed.result.status == "sent"
    delivery.execute.assert_awaited_once()
    assert "Hi" not in str(confirmed.result.model_public())
    again = await session.executor.call(
        session.ctx, "confirm_pending_action", {"pending_action_id": proposal.pending.id}
    )
    assert again.result.status != "sent"
    delivery.execute.assert_awaited_once()


@pytest.mark.asyncio
async def test_foreign_review_ack_cannot_enable_send(reviewed_mail):
    session, _transport, _live, _pending, delivery, created, _ = reviewed_mail
    await _ack_review(reviewed_mail, action_id="33333333-3333-4333-8333-333333333333")
    refused = await session.executor.call(
        session.ctx, "send_reviewed_mail", {"draft_ref": created.result.draft_ref, "revision": 1}
    )
    assert refused.result.reason_code == "draft_not_reviewed"
    delivery.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_typed_invalid_edit_revokes_approval_before_validation(reviewed_mail):
    session, transport, _live, pending, delivery, created, _ = reviewed_mail
    await _ack_review(reviewed_mail)
    proposal = await session.executor.call(
        session.ctx, "send_reviewed_mail", {"draft_ref": created.result.draft_ref, "revision": 1}
    )
    frame = protocol.parse_client_frame(
        json.dumps(
            {
                "type": "mail_draft.changed",
                "draft_ref": created.result.draft_ref,
                "revision": 1,
                "operation_id": "bad-edit-123",
                "draft": {"body": ["malformed"]},
            }
        )
    )
    await session._handle_client_frame(frame)
    assert pending.rows[proposal.pending.id].status == "cancelled"
    delivery.cancel_prepared.assert_awaited()
    delivery.execute.assert_not_awaited()
    assert transport.frames("client_step.request")[-1]["payload"]["status"] == "needs_input"


@pytest.mark.asyncio
async def test_batch_cannot_confirm_and_edit_current_email(reviewed_mail):
    session, _transport, _live, _pending, delivery, created, _ = reviewed_mail
    await _ack_review(reviewed_mail)
    proposal = await session.executor.call(
        session.ctx, "send_reviewed_mail", {"draft_ref": created.result.draft_ref, "revision": 1}
    )
    calls = [
        {"name": "confirm_pending_action", "args": {"pending_action_id": proposal.pending.id}},
        {
            "name": "edit_mail_draft",
            "args": {"draft_ref": created.result.draft_ref, "revision": 1, "message": "Corrected"},
        },
    ]
    rejected = await session._conflicting_batch_calls(calls)
    assert set(rejected) == {0, 1}
    delivery.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_prepared_null_draft_mount_is_not_send_review(reviewed_mail):
    from hushh_mcp.services.gmail_delivery_service import GmailDeliveryError

    session, transport, live, _pending, delivery, created, _ = reviewed_mail
    runtime = session.ctx.services["mail_compose"]
    delivery.prepare.side_effect = GmailDeliveryError("GMAIL_SEND_DISABLED", "disabled")
    await runtime.invalidate(session.ctx, created.result.draft_ref, 1)
    changed = await runtime.edit(
        session.ctx, created.result.draft_ref, 1, {"body": "Keep this"}, operation_id="retry-123"
    )
    from hushh_mcp.one_voice.tools.executor import ToolCallOutcome

    await session._after_execution(
        ToolCallOutcome(result=changed), source="voice", origin_turn_id=session.turn.turn_id
    )
    step = transport.frames("client_step.request")[-1]
    assert step["payload"]["prepared"] is None
    await session._client_step_result(
        protocol.ClientStepResultFrame(
            type="client_step.result",
            step_id=step["step_id"],
            status="ok",
            payload={"mounted": True, "draft_ref": changed.draft_ref, "revision": changed.revision},
        )
    )
    assert _events(live)[-1]["status"] == "needs_input"
    delivery.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_generic_voice_cancel_emits_mail_draft_outcome(reviewed_mail):
    session, transport, _live, _pending, delivery, created, _ = reviewed_mail
    await _ack_review(reviewed_mail)

    await session._dispatch_tool_call_inner(
        name="edit_mail_draft",
        call_id="cancel-voice",
        args={
            "draft_ref": created.result.draft_ref,
            "revision": created.result.revision,
            "cancel": True,
        },
        origin_turn_id=session.turn.turn_id,
    )

    outcome_frame = transport.frames("client_step.request")[-1]
    outcome = outcome_frame["payload"]
    assert outcome_frame["kind"] == "mail_draft_outcome"
    assert outcome["status"] == "cancelled"
    assert outcome["draft_ref"] == created.result.draft_ref
    assert outcome["action_id"] is None
    delivery.execute.assert_not_awaited()
