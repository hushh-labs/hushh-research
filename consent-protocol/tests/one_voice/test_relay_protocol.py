"""Relay protocol: auth handshake, tool dispatch, confirmations, client steps."""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Literal

import pytest
from google.genai import types as genai_types

from hushh_mcp.one_voice import protocol
from hushh_mcp.one_voice.config import OneVoiceLiveConfig
from hushh_mcp.one_voice.conversations import ConversationStorageError
from hushh_mcp.one_voice.live_client import LiveEvent, translate_message
from hushh_mcp.one_voice.pending_actions import PendingActionStorageError
from hushh_mcp.one_voice.session import (
    AuthResult,
    SessionClosed,
    VoiceSession,
    _failure_fingerprints,
)
from hushh_mcp.one_voice.tickets import TicketClaims
from hushh_mcp.one_voice.tools import location_state, registry
from hushh_mcp.one_voice.tools.base import (
    ConfirmationRequired,
    ConfirmedPerson,
    EntityContext,
    PersonRef,
    ToolInput,
    ToolPolicy,
    ToolResult,
    ToolSpec,
    now_iso,
    restore_context,
)
from hushh_mcp.one_voice.tools.executor import ToolCallOutcome, ToolExecutor
from tests.one_voice.fakes import (
    FakeLive,
    FakeTransport,
    MemoryConversationStore,
    MemoryPendingStore,
    live_factory_for,
)

USER = "user-1"
CONV = "11111111-2222-4333-8444-555555555555"
CLAIMS = TicketClaims(
    user_id=USER, session_id="sess-1", conversation_id=CONV, expires_at=9_999_999_999, nonce="n"
)
CONFIG = OneVoiceLiveConfig(
    enabled=True,
    model_id="gemini-live-2.5-flash-native-audio",
    location="us-central1",
    idle_close_seconds=5,
    session_max_minutes=30,
)


# --- a tiny test catalog (the real families are tested on their own) ---------


class EchoInput(ToolInput):
    text: str


class EchoResult(ToolResult):
    status: Literal["ok"]
    echoed: str


async def echo(ctx, args):
    return EchoResult(status="ok", echoed=args.text, spoken_facts=[f"You said {args.text}."])


class AskInput(ToolInput):
    person: PersonRef
    hours: int = 1


class AskResult(ToolResult):
    status: Literal["pending", "not_connected"]


async def ask(ctx, args):
    person = ctx.entities.person(args.person.user_id)
    return AskResult(
        status="pending", spoken_facts=[f"Asked {person.display_name}. They need to approve."]
    )


class DeleteInput(ToolInput):
    thing_id: str


class DeleteResult(ToolResult):
    status: Literal["deleted"]


async def delete(ctx, args):
    return DeleteResult(status="deleted", spoken_facts=["Deleted."])


class ShareInput(ToolInput):
    person: PersonRef


class ShareResult(ToolResult):
    status: Literal["grant_created"]
    client_step: dict


async def share(ctx, args):
    return ShareResult(
        status="grant_created",
        client_step={
            "kind": "publish_location_envelopes",
            "purpose": "share",
            "grant_ids": ["g-1"],
        },
        spoken_facts=["Share created; sending your position now."],
    )


RESUME = "resume_device_location_updates"
PAUSE = "pause_device_location_updates"
# The two device-switch tools are the real specs: their handlers and the
# settlement they feed are what this relay binds a client step to.
DEVICE_TOOLS = tuple(t for t in location_state.TOOLS if t.name in {RESUME, PAUSE})

TEST_TOOLS = (
    ToolSpec(
        name="echo",
        gateway_action_id="route.one_location",
        policy=ToolPolicy.read,
        input_model=EchoInput,
        output_model=EchoResult,
        description="Echo.",
        handler=echo,
    ),
    ToolSpec(
        name="ask",
        gateway_action_id="location.send_request",
        policy=ToolPolicy.confirm_voice,
        input_model=AskInput,
        output_model=AskResult,
        description="Ask.",
        handler=ask,
        person_args=("person",),
        summarize=lambda ctx, a: (
            f"ask {ctx.entities.person(a.person.user_id).display_name} for their location"
        ),
    ),
    ToolSpec(
        name="delete_thing",
        gateway_action_id="location.delete_circle",
        policy=ToolPolicy.confirm_tap,
        input_model=DeleteInput,
        output_model=DeleteResult,
        description="Delete.",
        handler=delete,
        summarize=lambda ctx, a: "delete the thing",
    ),
    ToolSpec(
        name="share",
        gateway_action_id="location.share_selected",
        policy=ToolPolicy.confirm_voice,
        input_model=ShareInput,
        output_model=ShareResult,
        description="Share.",
        handler=share,
        person_args=("person",),
        summarize=lambda ctx, a: "share your location",
    ),
    *DEVICE_TOOLS,
)


@pytest.fixture(autouse=True)
def _test_catalog(monkeypatch):
    by_name = {t.name: t for t in TEST_TOOLS}
    monkeypatch.setattr(registry, "all_tools", lambda: TEST_TOOLS)
    monkeypatch.setattr(registry, "get_tool", lambda name: by_name.get(str(name or "")))
    monkeypatch.setattr(
        registry,
        "declarations",
        lambda: [t.declaration() for t in TEST_TOOLS] + list(registry.SESSION_TOOL_DECLARATIONS),
    )


async def _ok_auth(frame, claims):
    return AuthResult(
        user_id=USER,
        vault_owner_token=frame.vault_owner_token,
        firebase_id_token=frame.firebase_id_token,
        display_name="Ayesha",
    )


AUTH = {"type": "auth", "vault_owner_token": "HCT:token", "conversation_id": CONV}


def _session(transport, fake_live, *, verify=_ok_auth, pending=None, conversations=None):
    pending = pending or MemoryPendingStore()
    return VoiceSession(
        transport=transport,
        config=CONFIG,
        claims=CLAIMS,
        verify_auth=verify,
        live_factory=live_factory_for(fake_live),
        executor=ToolExecutor(pending_store=pending),
        conversations=conversations or MemoryConversationStore(),
        pending=pending,
    )


async def _run(session, timeout=3.0):
    try:
        await asyncio.wait_for(session.run(), timeout=timeout)
    except asyncio.TimeoutError:
        pytest.fail("session did not close")


# --- auth ------------------------------------------------------------------


def test_grouped_failure_identifies_leaf_without_recording_private_error_text():
    try:
        raise ValueError("private mail body and token must not be logged")
    except ValueError as leaf:
        group = ExceptionGroup("private outer detail", [ExceptionGroup("nested", [leaf])])
    details = _failure_fingerprints(group)
    assert details[0]["type"] == "ValueError"
    assert details[0]["frames"][-1].startswith(
        "test_relay_protocol.py:test_grouped_failure_identifies_leaf_without_recording_private_error_text:"
    )
    assert "private" not in json.dumps(details).replace(
        "test_grouped_failure_identifies_leaf_without_recording_private_error_text", "test"
    )
    assert "token" not in json.dumps(details)


async def test_first_frame_must_be_auth():
    transport = FakeTransport([{"type": "ping"}])
    await _run(_session(transport, FakeLive([])))
    assert transport.closed[0] == protocol.CLOSE_AUTH
    assert transport.frames("error")[0]["code"] == "auth_required"


async def test_auth_user_must_match_ticket():
    async def _other(frame, claims):
        return AuthResult(user_id="someone-else", vault_owner_token="x", firebase_id_token=None)  # noqa: S106

    transport = FakeTransport([AUTH])
    await _run(_session(transport, FakeLive([]), verify=_other))
    assert transport.closed[0] == protocol.CLOSE_AUTH
    assert transport.frames("error")[0]["code"] == "auth_mismatch"


async def test_invalid_token_closes_without_provider(monkeypatch):
    async def _bad(frame, claims):
        raise PermissionError("Vault owner token is invalid.")

    fake = FakeLive([])
    transport = FakeTransport([AUTH])
    await _run(_session(transport, fake, verify=_bad))
    assert transport.closed[0] == protocol.CLOSE_AUTH
    assert not hasattr(fake, "live_config")


async def test_ready_then_end_records_close(caplog):
    conversations = MemoryConversationStore()
    transport = FakeTransport([AUTH, {"type": "end"}])
    fake = FakeLive([LiveEvent(kind="setup_complete")])
    with caplog.at_level(logging.INFO, logger="hushh_mcp.one_voice.session"):
        await _run(_session(transport, fake, conversations=conversations))
    ready = transport.frames("session.ready")[0]
    assert ready["conversation_id"] == CONV and ready["resumed"] is False
    assert ready["output_mime_type"] == "audio/pcm;rate=24000"
    assert ready["client_perf"] is True
    assert transport.closed == (protocol.CLOSE_ENDED, "ended")
    assert conversations.closes == [(1000, "ended", True)]
    assert (
        "system_instruction" in fake.live_config
        and "resolve_person" in fake.live_config["system_instruction"]
    )
    perf_logs = [
        record.message for record in caplog.records if "one_voice.session_perf" in record.message
    ]
    assert len(perf_logs) == 1 and "user_input_turns=0" in perf_logs[0]
    assert "per_user_input=" not in perf_logs[0]


# --- audio + transcripts ---------------------------------------------------


async def test_audio_is_forwarded_and_oversized_frames_dropped():
    big = "A" * (protocol.MAX_AUDIO_FRAME_BYTES * 4 // 3 + 400)
    transport = FakeTransport(
        [AUTH, {"type": "audio", "data": "AAAA"}, {"type": "audio", "data": big}, {"type": "end"}]
    )
    fake = FakeLive([])
    session = _session(transport, fake)
    await _run(session)
    assert fake.audio_in == ["AAAA"]
    assert session.dropped_audio_frames == 1


def test_perf_frame_accepts_only_bounded_content_free_measurements():
    frame = protocol.parse_client_frame(
        json.dumps(
            {
                "type": "perf",
                "metric": "audio_receive_to_audible",
                "duration_ms": 120_000,
                "turn_id": "abcdef123456",
            }
        )
    )
    assert isinstance(frame, protocol.PerfFrame)
    for invalid in (
        {"metric": "transcript", "duration_ms": 100},
        {"metric": "endpointing_client", "duration_ms": 120_001},
        {"metric": "endpointing_client", "duration_ms": True},
        {"metric": "endpointing_client", "duration_ms": 100, "turn_id": "private words"},
        {"metric": "endpointing_client", "duration_ms": 100, "route": "/private"},
    ):
        with pytest.raises(protocol.FrameError):
            protocol.parse_client_frame(json.dumps({"type": "perf", **invalid}))


async def test_perf_frame_is_logged_without_extending_idle_or_reaching_provider(caplog):
    transport, fake = FakeTransport(), FakeLive([])
    session = _session(transport, fake)
    before = session.last_activity
    frame = protocol.parse_client_frame(
        '{"type":"perf","metric":"endpointing_client","duration_ms":840,"turn_id":"abcdef123456"}'
    )
    with caplog.at_level(logging.INFO, logger="hushh_mcp.one_voice.session"):
        await session._handle_client_frame(frame)
        await session._send(protocol.turn("model_start", turn_id="abcdef123456"))
        await session._handle_client_frame(frame)
    assert session.last_activity == before
    assert fake.audio_in == [] and fake.events_sent == []
    assert "turn=none metric=endpointing_client ms=840" in caplog.text
    assert "turn=abcdef123456 metric=endpointing_client ms=840" in caplog.text


def test_pinned_sdk_activity_end_markers_translate_without_inferred_fields():
    activity = genai_types.LiveServerMessage(
        voice_activity=genai_types.VoiceActivity(
            voice_activity_type=genai_types.VoiceActivityType.ACTIVITY_END
        )
    )
    signal = genai_types.LiveServerMessage(
        voice_activity_detection_signal=genai_types.VoiceActivityDetectionSignal(
            vad_signal_type=genai_types.VadSignalType.VAD_SIGNAL_TYPE_EOS
        )
    )
    assert [(event.kind, event.activity_source) for event in translate_message(activity)] == [
        ("activity_end", "voice_activity")
    ]
    assert [(event.kind, event.activity_source) for event in translate_message(signal)] == [
        ("activity_end", "vad_signal")
    ]


async def test_eos_and_final_transcript_in_one_provider_message_are_correlated(caplog):
    message = genai_types.LiveServerMessage(
        voice_activity_detection_signal=genai_types.VoiceActivityDetectionSignal(
            vad_signal_type=genai_types.VadSignalType.VAD_SIGNAL_TYPE_EOS
        ),
        server_content=genai_types.LiveServerContent(
            input_transcription=genai_types.Transcription(text="private input", finished=True)
        ),
    )
    events = translate_message(message)
    assert [event.kind for event in events] == ["activity_end", "input_transcript"]
    assert events[0].same_message_input_transcript is True
    transport, fake = FakeTransport(), FakeLive([])
    session = _session(transport, fake)
    session.clock = lambda: 100.0
    await session._open_conversation(
        AuthResult(user_id=USER, vault_owner_token="HCT:token", firebase_id_token=None)  # noqa: S106 - synthetic test authority
    )
    session.live = fake
    with caplog.at_level(logging.INFO, logger="hushh_mcp.one_voice.session"):
        for event in events:
            await session._handle_live_event(event)
    assert "phase=provider_activity_end_to_transcript source=vad_signal ms=0" in caplog.text
    assert "private input" not in caplog.text


async def test_provider_activity_end_to_transcript_and_turn_counts_have_no_content(caplog):
    transport, fake = FakeTransport(), FakeLive([])
    session = _session(transport, fake)
    session.clock = lambda: 100.0
    await session._open_conversation(
        AuthResult(user_id=USER, vault_owner_token="HCT:token", firebase_id_token=None)  # noqa: S106 - synthetic test authority
    )
    session.live = fake
    with caplog.at_level(logging.INFO, logger="hushh_mcp.one_voice.session"):
        await session._handle_live_event(
            LiveEvent(kind="activity_start", activity_source="voice_activity")
        )
        await session._handle_live_event(
            LiveEvent(kind="activity_end", activity_source="voice_activity")
        )
        session.clock = lambda: 100.84
        await session._handle_live_event(
            LiveEvent(kind="input_transcript", text="private spoken words", finished=True)
        )
        await session._handle_live_event(LiveEvent(kind="turn_complete"))
        await session._handle_live_event(LiveEvent(kind="turn_complete"))
        session._log_session_perf()
    assert session._counters["user_input_turns"] == 1
    assert session._counters["provider_turns"] == 2
    assert "phase=provider_activity_end_to_transcript source=voice_activity ms=840" in caplog.text
    assert "provider_turns_per_user_input=2.00" in caplog.text
    assert "private spoken words" not in caplog.text


async def test_late_provider_end_is_not_assigned_to_the_next_transcript(caplog):
    transport, fake = FakeTransport(), FakeLive([])
    session = _session(transport, fake)
    await session._open_conversation(
        AuthResult(user_id=USER, vault_owner_token="HCT:token", firebase_id_token=None)  # noqa: S106 - synthetic test authority
    )
    session.live = fake
    with caplog.at_level(logging.INFO, logger="hushh_mcp.one_voice.session"):
        await session._handle_live_event(
            LiveEvent(kind="input_transcript", text="first input", finished=True)
        )
        await session._handle_live_event(LiveEvent(kind="turn_complete"))
        await session._handle_live_event(
            LiveEvent(kind="activity_end", activity_source="vad_signal")
        )
        await session._handle_live_event(
            LiveEvent(kind="input_transcript", text="second input", finished=True)
        )
    assert "phase=provider_activity_end_to_transcript" not in caplog.text


async def test_model_cancel_of_a_card_is_counted_as_a_cancelled_confirmation(caplog):
    """UAT circle naming: three model cancel_pending_action calls and one
    supersede were logged as confirmation_cancelled=1. A model cancel that
    really cancelled a card counts; one that found nothing pending does not."""
    session, transport, _fake, _pending = await _voice_card_session()
    await _model_calls(session, "c1", "ask", {"person": {"user_id": "u-priya"}})
    card = transport.frames("pending_action")[-1]["pending_action_id"]
    with caplog.at_level(logging.INFO, logger="hushh_mcp.one_voice.session"):
        await _model_calls(session, "c2", "cancel_pending_action", {"pending_action_id": card})
        assert session._counters.get("pending_cancelled", 0) == 1
        # Negative control: nothing left to cancel, so nothing is counted.
        await _model_calls(session, "c3", "cancel_pending_action", {"pending_action_id": card})
        session._log_session_perf()
    assert session._counters.get("pending_cancelled", 0) == 1
    assert "confirmation_cancelled=1 " in caplog.text
    assert "Priya" not in caplog.text and card not in caplog.text


async def test_confirm_tool_in_a_turn_without_its_own_input_is_logged(caplog):
    """UAT circle naming: a proposal came from a provider turn that received no
    input of its own; the relay attributed it to the previous input silently."""
    session, _transport, _fake, _pending = await _voice_card_session()
    with caplog.at_level(logging.INFO, logger="hushh_mcp.one_voice.session"):
        # Negative controls: a confirm tool in the input's own turn, and a read
        # tool in a model-only continuation, are not unprompted proposals.
        await _model_calls(session, "c1", "ask", {"person": {"user_id": "u-priya"}})
        await session._handle_live_event(LiveEvent(kind="turn_complete"))
        # Live answers the tool result in its own turn; after that nothing is owed.
        await _speak_and_end(session, "QUJD")
        await _model_calls(session, "c2", "echo", {"text": "private echo words"})
        assert "one_voice.tool.no_input" not in caplog.text
        await _model_calls(session, "c3", "delete_thing", {"thing_id": "private-thing-id"})
        session._log_session_perf()
    lines = [r.message for r in caplog.records if "one_voice.tool.no_input" in r.message]
    assert len(lines) == 1 and "tool=delete_thing after=none" in lines[0]
    assert session._counters.get("unprompted", 0) == 1
    assert "unprompted=1 chained=0" in caplog.text
    for private in ("Priya", "private echo words", "private-thing-id", "Ask Priya"):
        assert private not in caplog.text


async def test_confirm_tool_chained_after_a_tool_or_event_is_not_unprompted(caplog):
    """A lookup then a proposal, or a reply to an injected event, is Live
    answering what it was handed: logged with what opened the turn, counted as
    chained, never as unprompted."""
    session, _transport, _fake, _pending = await _voice_card_session()
    with caplog.at_level(logging.INFO, logger="hushh_mcp.one_voice.session"):
        await _model_calls(session, "c1", "echo", {"text": "private echo words"})
        await session._handle_live_event(LiveEvent(kind="turn_complete"))
        await _model_calls(session, "c2", "delete_thing", {"thing_id": "private-thing-id"})
        await session._handle_live_event(LiveEvent(kind="turn_complete"))
        await _speak_and_end(session, "QUJD")
        await session._inject_event({"kind": "private_event_kind"})
        await _model_calls(session, "c3", "delete_thing", {"thing_id": "private-other-id"})
        session._log_session_perf()
    lines = [r.message for r in caplog.records if "one_voice.tool.no_input" in r.message]
    assert len(lines) == 2
    assert "tool=delete_thing after=tool" in lines[0]
    assert "tool=delete_thing after=event" in lines[1]
    assert session._counters.get("unprompted", 0) == 0
    assert "unprompted=0 chained=2" in caplog.text
    for private in ("Priya", "private echo words", "private-thing-id", "private-other-id"):
        assert private not in caplog.text
    assert "private_event_kind" not in caplog.text


# --- a proposal Live makes on its own while a card waits --------------------

ASK_1H = {"person": {"user_id": "u-priya"}, "hours": 1}
ASK_2H = {"person": {"user_id": "u-priya"}, "hours": 2}


def _circle_catalog(monkeypatch) -> list[str]:
    """The real create_circle spec, prepare hook included, with a handler that
    records what it would create instead of calling the circles service."""
    from dataclasses import replace

    from hushh_mcp.one_voice.tools import circles

    created: list[str] = []

    async def _create(ctx, args):
        created.append(args.name)
        return ToolResult(status="created", spoken_facts=["Created."])

    real = next(tool for tool in circles.TOOLS if tool.name == "create_circle")
    tools = {tool.name: tool for tool in (*TEST_TOOLS, replace(real, handler=_create))}
    monkeypatch.setattr(registry, "get_tool", lambda name: tools.get(str(name or "")))
    return created


async def _card_read_back_then_silence(session, transport, call_id, name, args) -> str:
    """One proposes in the input's own turn; Live closes that turn, reads the
    card back in a fresh one and closes that too; the person says nothing."""
    await _model_calls(session, call_id, name, args)
    card = transport.frames("pending_action")[-1]["pending_action_id"]
    await session._handle_client_frame(
        protocol.PendingShownFrame(type="pending_action.shown", pending_action_id=card)
    )
    await session._handle_live_event(LiveEvent(kind="turn_complete"))
    await _speak_and_end(session, "QUJD")
    return card


@pytest.mark.parametrize("changed", [True, False], ids=["different_args", "same_args"])
async def test_a_proposal_live_makes_in_silence_leaves_the_waiting_card_alone(
    monkeypatch, caplog, changed
):
    """UAT 2026-10-06 circle naming: 14.5 s after One read proposal 4 back, with
    no input transcript, Live proposed again with different arguments, and that
    proposal replaced the card the person was about to answer. A confirm-tier
    call Live makes on its own while a card waits never reaches the executor:
    the card and its id survive, the model is told the card is waiting, and the
    person's yes confirms what they were shown, once."""
    created = _circle_catalog(monkeypatch)
    session, transport, fake = await _relay_on_live()
    original = {"name": "HUSSH GARAGE V04", "spelled_words": ["HUSSH"]}
    await _say(session, "Create a circle called hussh garage v04")
    card = await _card_read_back_then_silence(session, transport, "c1", "create_circle", original)
    silent = {"name": "HUSSH GARAGE V4", "spelled_words": ["HUSSH"]} if changed else original
    with caplog.at_level(logging.INFO, logger="hushh_mcp.one_voice.session"):
        await _model_calls(session, "c2", "create_circle", silent)
        session._log_session_perf()

    rows = session.pending.rows
    assert [(row.id, row.status) for row in rows.values()] == [(card, "pending")]
    assert len(transport.frames("pending_action")) == 1
    assert transport.frames("pending_action.resolved") == []
    held = _responses(fake, "create_circle")[-1]
    assert held["status"] == "confirmation_waiting" and held["needs"] == "confirmation"
    assert held["pending_action_id"] == card and held["reason_code"] == "awaiting_answer"
    assert held["spoken_facts"] == [] and "note" not in held
    result = transport.frames("tool.result")[-1]
    assert result["ok"] is False and result["result_public"]["pending_action_id"] == card
    assert transport.frames("state")[-1]["state"] == "confirming"
    assert session._counters.get("held") == 1
    assert "one_voice.tool.held tool=create_circle after=none" in caplog.text
    assert " held=1" in caplog.text
    assert "garage" not in caplog.text.lower() and card not in caplog.text

    # Live acknowledges the held answer; the person then answers the card.
    await session._handle_live_event(LiveEvent(kind="turn_complete"))
    await _speak_and_end(session, "QkJC")
    await _say(session, "Yes")
    await _model_calls(session, "c3", "confirm_pending_action", {"pending_action_id": card})
    assert rows[card].status == "executed"
    assert created == ["HUSSH GARAGE V04"]


@pytest.mark.parametrize(
    "read_fails",
    [None, "same_turn", "next_continuation"],
    ids=[
        "cards_read",
        "read_fails_once_retry_same_turn",
        "read_fails_once_retry_next_continuation",
    ],
)
@pytest.mark.parametrize("tool", ["confirm_pending_action", "cancel_pending_action"])
async def test_live_never_answers_the_waiting_card_in_silence(
    monkeypatch, caplog, tool, read_fails
):
    """Only the person answers a card. A confirm made in silence would approve
    an action nobody said yes to; a cancel made in silence would clear the way
    for an unprompted re-proposal. Both are held like a proposal made in
    silence: the card stays pending and the person's own yes still runs it once.
    When the open cards cannot be read for the hold, the answer fails closed
    instead of reaching the executor, which confirms or cancels by id without
    that read: nothing changes and Live gets nothing to say. That answer is a
    held one for what follows, so Live retrying at once, in the same provider
    turn or the next continuation, is held even with storage back."""
    created = _circle_catalog(monkeypatch)
    session, transport, fake = await _relay_on_live()
    original = {"name": "HUSSH GARAGE V04", "spelled_words": ["HUSSH"]}
    await _say(session, "Create a circle called hussh garage v04")
    card = await _card_read_back_then_silence(session, transport, "c1", "create_circle", original)
    if read_fails:
        read_open = session.pending.list_open

        async def _fails_once(**kwargs):
            monkeypatch.setattr(session.pending, "list_open", read_open)
            raise PendingActionStorageError("unavailable")

        monkeypatch.setattr(session.pending, "list_open", _fails_once)
    with caplog.at_level(logging.INFO, logger="hushh_mcp.one_voice.session"):
        await _model_calls(session, "c2", tool, {"pending_action_id": card})

    assert session.pending.rows[card].status == "pending"
    assert created == []
    held = _responses(fake, tool)[-1]
    if read_fails:
        assert held["status"] == "rejected" and held["reason_code"] == "storage_unavailable"
        assert held["spoken_facts"] == [] and "op=hold" in caplog.text
        if read_fails == "next_continuation":
            await session._handle_live_event(LiveEvent(kind="turn_complete"))
        await _model_calls(session, "c2r", tool, {"pending_action_id": card})
        assert session.pending.rows[card].status == "pending"
        assert created == []
        retried = _responses(fake, tool)[-1]
        assert retried["status"] == "confirmation_waiting" and retried["pending_action_id"] == card
        assert session._counters.get("held") == 1
    else:
        assert held["status"] == "confirmation_waiting" and held["pending_action_id"] == card
        assert held["spoken_facts"] == [] and held["reason_code"] == "awaiting_answer"
        assert f"one_voice.tool.held tool={tool} after=none" in caplog.text

    await session._handle_live_event(LiveEvent(kind="turn_complete"))
    await _speak_and_end(session, "QkJC")
    await _say(session, "Yes")
    await _model_calls(session, "c3", "confirm_pending_action", {"pending_action_id": card})
    assert session.pending.rows[card].status == "executed"
    assert created == ["HUSSH GARAGE V04"]


async def _yes_refused_as_not_shown(session, transport) -> str:
    """The card is read back and the person says yes before the client reports
    it shown, so Live's confirm is refused as card_not_shown and the yes waits
    for that report."""
    await _say(session, "Create a circle called hussh garage v04")
    await _model_calls(session, "c1", "create_circle", {"name": "HUSSH GARAGE V04"})
    card = transport.frames("pending_action")[-1]["pending_action_id"]
    await session._handle_live_event(LiveEvent(kind="turn_complete"))
    await _speak_and_end(session, "QUJD")
    await _say(session, "Yes")
    await _model_calls(session, "c2", "confirm_pending_action", {"pending_action_id": card})
    assert session.pending.rows[card].status == "pending"
    return card


async def _live_steps(session, card: str, steps: tuple[str, ...]) -> None:
    """Provider events in order; ``shown`` is the client reporting the card
    shown, and ``lookup`` a read tool Live calls."""
    for step in steps:
        if step == "shown":
            await session._handle_client_frame(
                protocol.PendingShownFrame(type="pending_action.shown", pending_action_id=card)
            )
        elif step == "lookup":
            await _model_calls(session, "l1", "echo", {"text": "hi"})
        elif step == "audio":
            await session._handle_live_event(LiveEvent(kind="audio", audio_b64="QkJC"))
        else:
            await session._handle_live_event(LiveEvent(kind=step))


@pytest.mark.parametrize(
    "steps",
    [
        ("turn_complete", "audio", "turn_complete", "shown"),
        ("turn_complete", "audio", "shown", "interrupted"),
        ("turn_complete", "audio", "shown", "interrupted", "turn_complete"),
        ("turn_complete", "audio", "shown", "audio", "turn_complete"),
        ("turn_complete", "audio", "shown", "turn_complete"),
        ("shown", "turn_complete", "audio", "turn_complete"),
    ],
    ids=[
        "while_idle",
        "mid_reply_then_interrupted",
        "mid_reply_then_interrupted_and_turn_complete",
        "mid_reply_then_more_audio",
        "mid_reply_then_turn_complete",
        "before_the_reply",
    ],
)
async def test_a_confirm_answering_an_app_event_is_not_held(monkeypatch, steps):
    """Negative control for the hold, and its gap 4 regression: the person said
    yes before the card was reported shown, so that confirm was refused. When
    the client reports the card shown, the app tells Live, and the relay
    records that card with the input whose yes was refused. Live's confirm of
    that card is the person's answer, not one made in silence. The report can
    land while Live is idle, while it is still speaking its reply to the
    refusal (the event interrupts it, with or without the turn_complete that
    closes an interrupted turn, or it finishes with or without more audio), or
    before it has replied at all. In every case the person's yes runs the card
    once and nothing is held: holding it lost the yes, and every retry was
    held again."""
    created = _circle_catalog(monkeypatch)
    session, transport, fake = await _relay_on_live()
    card = await _yes_refused_as_not_shown(session, transport)
    await _live_steps(session, card, steps)
    assert len(fake.events_sent) == 1 and "pending_shown" in fake.events_sent[0]
    await _model_calls(session, "c3", "confirm_pending_action", {"pending_action_id": card})
    assert session.pending.rows[card].status == "executed"
    assert created == ["HUSSH GARAGE V04"]
    assert session._counters.get("held", 0) == 0


@pytest.mark.parametrize("silent_call", ["create_circle", "confirm_pending_action"])
@pytest.mark.parametrize("event", ["ui_settled", "session_ending_soon"])
@pytest.mark.parametrize("lands", ["before_its_turn_closes", "before_the_read_back"])
async def test_an_app_event_the_person_did_not_cause_never_answers_the_card(
    monkeypatch, lands, event, silent_call
):
    """The UAT 2026-10-06 incident shape with an app event nobody asked for:
    Live navigates and proposes in the input's own turn, and the client
    settling that navigation, or the session-ending warning, arrives before
    Live reads the card back. The read-back answers the tool result and the
    event together. A proposal or confirm Live then makes in silence is held:
    the card stays pending and nothing runs. Only a person's yes refused as
    card_not_shown lets a later confirm of that card through."""
    created = _circle_catalog(monkeypatch)
    session, transport, fake = await _relay_on_live()
    await _say(session, "Open my circles and create one called hussh garage v04")
    await session._emit_side_effects(
        ToolCallOutcome(
            result=ToolResult(
                status="navigation_dispatched", gateway_action_id="route.circles", screen="circles"
            )
        ),
        call_id="nav-1",
        origin_turn_id=session.turn.turn_id,
    )
    directive_id = transport.frames("ui_directive")[-1]["directive_id"]
    await _model_calls(session, "c1", "create_circle", {"name": "HUSSH GARAGE V04"})
    card = transport.frames("pending_action")[-1]["pending_action_id"]
    await session._handle_client_frame(
        protocol.PendingShownFrame(type="pending_action.shown", pending_action_id=card)
    )

    async def _app_event() -> None:
        if event == "ui_settled":
            await session._handle_client_frame(
                protocol.UiSettledFrame(
                    type="ui.settled", directive_id=directive_id, status="opened"
                )
            )
        else:
            await session._inject_event({"kind": "session_ending_soon", "seconds_left": 60})

    if lands == "before_its_turn_closes":
        await _app_event()
    await session._handle_live_event(LiveEvent(kind="turn_complete"))
    if lands == "before_the_read_back":
        await _app_event()
    assert len(fake.events_sent) == 1 and event in fake.events_sent[0]
    await _speak_and_end(session, "QUJD")
    silent = (
        {"name": "HUSSH GARAGE V4"}
        if silent_call == "create_circle"
        else {"pending_action_id": card}
    )
    await _model_calls(session, "c2", silent_call, silent)
    assert [(row.id, row.status) for row in session.pending.rows.values()] == [(card, "pending")]
    assert created == []
    assert session._counters.get("held") == 1


async def test_a_recovered_yes_lets_one_confirm_through(monkeypatch, caplog):
    """The recorded yes is spent on Live's first confirm of that card. If that
    confirm does not run the card (storage blinked), a confirm Live makes
    later in silence is held like any other. The recovery is logged once,
    without the card."""
    created = _circle_catalog(monkeypatch)
    session, transport, fake = await _relay_on_live()
    card = await _yes_refused_as_not_shown(session, transport)
    # The card shows while Live is still answering the refusal aloud.
    await _live_steps(session, card, ("turn_complete", "audio", "shown", "audio", "turn_complete"))
    read_row = session.pending.get

    async def _fails_once(**kwargs):
        monkeypatch.setattr(session.pending, "get", read_row)
        raise PendingActionStorageError("unavailable")

    monkeypatch.setattr(session.pending, "get", _fails_once)
    with caplog.at_level(logging.INFO, logger="hushh_mcp.one_voice.session"):
        await _model_calls(session, "c3", "confirm_pending_action", {"pending_action_id": card})
        assert _responses(fake, "confirm_pending_action")[-1]["reason_code"] == (
            "storage_unavailable"
        )
        assert session._counters.get("held", 0) == 0

        await session._handle_live_event(LiveEvent(kind="turn_complete"))
        await _speak_and_end(session, "Q0ND")
        await _model_calls(session, "c4", "confirm_pending_action", {"pending_action_id": card})
    assert session.pending.rows[card].status == "pending"
    assert created == []
    assert session._counters.get("held") == 1
    recovered = [r.message for r in caplog.records if "one_voice.tool.recovered" in r.message]
    assert len(recovered) == 1 and card not in caplog.text


async def test_a_recovered_yes_is_dropped_once_the_person_speaks_again(monkeypatch):
    """The recorded yes answers the card only while it is the person's latest
    input. Once they say something new and Live answers that, a confirm Live
    makes in silence is held: the earlier yes no longer answers the card."""
    created = _circle_catalog(monkeypatch)
    session, transport, fake = await _relay_on_live()
    card = await _yes_refused_as_not_shown(session, transport)
    await _live_steps(session, card, ("turn_complete", "audio", "shown"))
    await _say(session, "Wait")
    await _live_steps(session, card, ("turn_complete", "audio", "turn_complete"))
    await _model_calls(session, "c3", "confirm_pending_action", {"pending_action_id": card})
    assert session.pending.rows[card].status == "pending"
    assert created == []
    assert session._counters.get("held") == 1


async def _card_waiting(session, transport):
    await _card_read_back_then_silence(session, transport, "n0", "ask", ASK_1H)


async def _owed_a_lookup(session, transport):
    await _card_waiting(session, transport)
    await _say(session, "Make it two hours")
    await _model_calls(session, "n1", "echo", {"text": "hi"})
    await session._handle_live_event(LiveEvent(kind="turn_complete"))


async def _lookup_answered_aloud(session, transport):
    await _owed_a_lookup(session, transport)
    await session._handle_live_event(LiveEvent(kind="audio", audio_b64="Q0ND"))


async def _after_an_app_event(session, transport):
    await _card_waiting(session, transport)
    await session._inject_event({"kind": "ui_settled", "status": "opened"})


async def _with_new_input(session, transport):
    await _card_waiting(session, transport)
    await _say(session, "No, make it two hours")


async def _while_the_person_speaks(session, transport):
    await _card_waiting(session, transport)
    await session._handle_live_event(
        LiveEvent(kind="input_transcript", text="No, make it", finished=False)
    )
    await session._handle_live_event(LiveEvent(kind="turn_complete"))


async def _no_card_open(session, transport):
    await _speak_and_end(session, "QUJD")


async def _lookup_after_a_hold(session, transport):
    await _card_waiting(session, transport)
    await _model_calls(session, "n1", "ask", ASK_2H)
    assert session._counters.get("held") == 1
    await session._handle_live_event(LiveEvent(kind="turn_complete"))
    await _model_calls(session, "n2", "echo", {"text": "hi"})


@pytest.mark.parametrize(
    ("setup", "tool", "args", "expected"),
    [
        (_owed_a_lookup, "ask", ASK_2H, "confirmation_required"),
        (_lookup_answered_aloud, "ask", ASK_2H, "confirmation_required"),
        (_after_an_app_event, "ask", ASK_2H, "confirmation_required"),
        (_with_new_input, "ask", ASK_2H, "confirmation_required"),
        (_while_the_person_speaks, "ask", ASK_2H, "confirmation_required"),
        (_no_card_open, "ask", ASK_2H, "confirmation_required"),
        (_lookup_after_a_hold, "ask", ASK_2H, "confirmation_required"),
        (_card_waiting, "echo", {"text": "hi"}, "ok"),
    ],
    ids=[
        "reply_owed_to_a_lookup",
        "lookup_answered_aloud_first",
        "after_an_app_event",
        "correction_with_new_input",
        "while_the_person_speaks",
        "no_card_open",
        "lookup_after_a_hold",
        "read_while_a_card_waits",
    ],
)
async def test_calls_with_something_to_answer_are_never_held(setup, tool, args, expected):
    """Negative controls: Live answering a tool result (even after saying a
    word about it), an app event, or the person's own new words, a first
    proposal with nothing waiting, and a read, all run as the model asked."""
    session, transport, fake, _pending = await _voice_card_session()
    await setup(session, transport)
    held_before = session._counters.get("held", 0)
    await _model_calls(session, "n9", tool, args)
    answer = _responses(fake, tool)[-1]
    assert answer["status"] == expected and answer.get("reason_code") != "awaiting_answer"
    assert session._counters.get("held", 0) == held_before


async def test_held_proposals_note_the_waiting_card_from_the_third_and_new_input_restarts(
    caplog,
):
    """Live kept proposing in silence: from the third hold the answer also says,
    off the spoken path, that the proposal waits for the person. The count is
    per input; once the person speaks, a later hold starts again at one."""
    session, transport, fake, pending = await _voice_card_session()
    card = await _card_read_back_then_silence(session, transport, "c1", "ask", ASK_1H)
    with caplog.at_level(logging.INFO, logger="hushh_mcp.one_voice.session"):
        # Second hold: Live's next call, before it says a word about the first.
        await _model_calls(session, "c2", "ask", ASK_2H)
        await session._handle_live_event(LiveEvent(kind="turn_complete"))
        await _model_calls(session, "c3", "ask", ASK_2H)
        await session._handle_live_event(LiveEvent(kind="turn_complete"))
        await _speak_and_end(session, "QkJC")
        await _model_calls(session, "c4", "ask", ASK_2H)
    held = _responses(fake, "ask")[1:]
    assert [answer["reason_code"] for answer in held] == ["awaiting_answer"] * 3
    assert "note" not in held[0] and "note" not in held[1] and held[2]["note"]
    assert all(answer["spoken_facts"] == [] for answer in held)
    lines = [r.message for r in caplog.records if "one_voice.tool.held" in r.message]
    assert [line.split(" session=")[0] for line in lines] == [
        "one_voice.tool.held tool=ask after=none",
        "one_voice.tool.held tool=ask after=tool",
        "one_voice.tool.held tool=ask after=none",
    ]

    await session._handle_live_event(LiveEvent(kind="turn_complete"))
    await _speak_and_end(session, "Q0ND")
    await _say(session, "Sorry, what was that?")
    await _speak_and_end(session, "RERE")
    await _model_calls(session, "c5", "ask", ASK_2H)
    restarted = _responses(fake, "ask")[-1]
    assert restarted["reason_code"] == "awaiting_answer" and "note" not in restarted
    assert session._counters["held"] == 4
    assert [(row.id, row.status) for row in pending.rows.values()] == [(card, "pending")]
    assert "Priya" not in caplog.text


async def test_a_question_typed_while_the_waiting_card_is_read_gets_the_stale_answer():
    """The open cards are read before a proposal is held. A question typed
    during that read makes the call stale: it gets the answer every stale call
    gets, and the waiting card is still left alone."""
    session, transport, fake, pending = await _voice_card_session()
    card = await _card_read_back_then_silence(session, transport, "c1", "ask", ASK_1H)
    read_open = pending.list_open

    async def _typed_during_read(**kwargs):
        pending.list_open = read_open
        await session._handle_client_frame(protocol.TextFrame(type="text", text="What time is it?"))
        return await read_open(**kwargs)

    pending.list_open = _typed_during_read
    await session._handle_live_event(
        LiveEvent(kind="tool_call", function_calls=[{"id": "c2", "name": "ask", "args": ASK_2H}])
    )
    assert _responses(fake, "ask")[-1] == {
        "status": "superseded",
        "reason_code": "newer_question",
        "spoken_facts": [],
    }
    assert [(row.id, row.status) for row in pending.rows.values()] == [(card, "pending")]
    assert len(transport.frames("pending_action")) == 1
    assert transport.frames("pending_action.resolved") == []


async def test_output_transcript_after_its_final_is_counted_at_turn_end(caplog):
    """The output transcript shape behind the UAT circle naming is unknown:
    count output chunks after a turn already forwarded an output final,
    including a finished line resent, which is counted but not shown again."""
    session, transport, _fake = await _relay_on_live()
    with caplog.at_level(logging.INFO, logger="hushh_mcp.one_voice.session"):
        await _say(session, "private question")
        # Negative control: partials then one final is the ordinary shape.
        for text, finished in (("Private ", False), ("answer one.", True)):
            await session._handle_live_event(
                LiveEvent(kind="output_transcript", text=text, finished=finished)
            )
        await session._handle_live_event(LiveEvent(kind="turn_complete"))
        assert "after_final=" not in caplog.text
        for text, finished in (
            ("Private reply.", True),
            ("Private reply.", True),
            (" More private words", False),
        ):
            await session._handle_live_event(
                LiveEvent(kind="output_transcript", text=text, finished=finished)
            )
        await session._handle_live_event(
            LiveEvent(kind="output_transcript", text="Last private words.", finished=True)
        )
        await session._handle_live_event(LiveEvent(kind="turn_complete"))
        # An interrupted turn ends without turn_complete; its shape still counts.
        for text in ("Private early final.", "Private late words."):
            await session._handle_live_event(
                LiveEvent(kind="output_transcript", text=text, finished=True)
            )
        await session._handle_live_event(LiveEvent(kind="interrupted"))
    # The resent "Private reply." is counted after the final but never sent.
    assert len(transport.frames("transcript.output")) == 7
    lines = [r.message for r in caplog.records if "after_final=" in r.message]
    assert len(lines) == 2 and "after_final=3" in lines[0] and "after_final=1" in lines[1]
    assert "private" not in caplog.text.lower()


async def test_provider_audio_and_transcripts_reach_the_client():
    transport = FakeTransport([AUTH])
    fake = FakeLive(
        [
            LiveEvent(kind="input_transcript", text="show my map", finished=True),
            LiveEvent(kind="audio", audio_b64="QUJD"),
            LiveEvent(kind="output_transcript", text="Opening it now.", finished=True),
            LiveEvent(kind="turn_complete"),
        ]
    )
    session = _session(transport, fake)
    task = asyncio.create_task(session.run())
    await asyncio.sleep(0.2)
    transport.push({"type": "end"})
    await asyncio.wait_for(task, 3)
    assert transport.frames("transcript.input")[0]["text"] == "show my map"
    audio = transport.frames("audio")[0]
    assert (
        audio["data"] == "QUJD"
        and audio["mime_type"] == "audio/pcm;rate=24000"
        and audio["turn_id"]
    )
    states = [f["state"] for f in transport.frames("state")]
    assert states[0] == "listening" and "understanding" in states and states[-1] == "listening"
    assert [f["state"] for f in transport.frames("turn")] == ["model_start", "model_end"]


def _segments(frames: list[dict]) -> list[tuple[str, int, str, str]]:
    return [(f["segment_id"], f["seq"], f["kind"], f["text"]) for f in frames]


async def test_transcript_segments_carry_identity_seq_and_full_text():
    """UAT 2026-10-06: the client guessed delta vs restatement from text shape
    and doubled lines. Live sends deltas (captured), so the relay owns the
    segment: a stable id, a rising seq, the whole text so far, final on finish."""
    session, transport, _fake = await _relay_on_live()
    await _say(session, "And what", " about this?")
    spoken = _segments(transport.frames("transcript.input"))
    segment = spoken[0][0]
    assert spoken == [
        (segment, 1, "cumulative", "And what"),
        (segment, 2, "final", "And what about this?"),
    ]
    assert transport.frames("transcript.input")[-1]["final"] is True
    for text, finished in (("Sure,", False), (" one", False), (" moment.", True)):
        await session._handle_live_event(
            LiveEvent(kind="output_transcript", text=text, finished=finished)
        )
    await session._handle_live_event(
        LiveEvent(kind="output_transcript", text=" Done.", finished=False)
    )
    await session._handle_live_event(LiveEvent(kind="turn_complete"))
    await session._handle_live_event(
        LiveEvent(kind="output_transcript", text="Next.", finished=False)
    )
    answer = _segments(transport.frames("transcript.output"))
    first, after_final, next_turn = answer[0][0], answer[3][0], answer[4][0]
    assert answer == [
        (first, 1, "cumulative", "Sure,"),
        (first, 2, "cumulative", "Sure, one"),
        (first, 3, "final", "Sure, one moment."),
        (after_final, 1, "cumulative", "Done."),
        (next_turn, 1, "cumulative", "Next."),
    ]
    assert len({segment, first, after_final, next_turn}) == 4


async def test_transcript_restated_final_is_not_appended_but_a_repeated_letter_is():
    session, transport, _fake = await _relay_on_live()
    await _say(session, "Hello", "Hello")
    assert [(f["kind"], f["text"]) for f in transport.frames("transcript.input")] == [
        ("cumulative", "Hello"),
        ("final", "Hello"),
    ]
    # Negative control: Live sends deltas, so a repeated letter is spelling.
    await _say(session, "S", "S", "H")
    assert [f["text"] for f in transport.frames("transcript.input")][2:] == ["S", "SS", "SSH"]


_IN, _OUT, _END = "input", "output", "end"


async def _feed(session, steps) -> None:
    for step in steps:
        if step == _END:
            await session._handle_live_event(LiveEvent(kind="turn_complete"))
            continue
        role, text, finished = step
        await session._handle_live_event(
            LiveEvent(kind=f"{role}_transcript", text=text, finished=finished)
        )


def _lines(transport) -> list[tuple[str, int, str, str]]:
    """Transcript frames as (role, nth segment, kind, text), in send order."""
    order: list[str] = []
    rows = []
    for frame in transport.sent:
        if frame.get("type") not in {"transcript.input", "transcript.output"}:
            continue
        if frame["segment_id"] not in order:
            order.append(frame["segment_id"])
        role = frame["type"].removeprefix("transcript.")
        rows.append((role, order.index(frame["segment_id"]), frame["kind"], frame["text"]))
    return rows


@pytest.mark.parametrize(
    ("steps", "expected"),
    [
        pytest.param(
            [(_IN, "Hello", False)] * 3,
            [
                (_IN, 0, "cumulative", "Hello"),
                (_IN, 0, "cumulative", "HelloHello"),
                (_IN, 0, "cumulative", "HelloHelloHello"),
            ],
            id="A-repeated-delta-appends",
        ),
        pytest.param(
            [(_IN, "Hello", False), (_IN, "Hello there", False), (_IN, "Hello there", True)],
            [
                (_IN, 0, "cumulative", "Hello"),
                (_IN, 0, "cumulative", "Hello there"),
                (_IN, 0, "final", "Hello there"),
            ],
            id="B-cumulative-hypotheses",
        ),
        pytest.param(
            [(_IN, "Hel", False), (_IN, "lo", False), (_IN, "lo", False)],
            [
                (_IN, 0, "cumulative", "Hel"),
                (_IN, 0, "cumulative", "Hello"),
                (_IN, 0, "cumulative", "Hellolo"),
            ],
            id="C-repeated-chunk-appends",
        ),
        pytest.param(
            [(_IN, " Hello", False), (_IN, " Hello", True)],
            [(_IN, 0, "cumulative", "Hello"), (_IN, 0, "final", "Hello")],
            id="D-final-resends-the-raw-line",
        ),
        pytest.param(
            [
                (_IN, "Hi there", True),
                (_OUT, "Sure,", False),
                (_OUT, " one", False),
                _END,
                (_OUT, "Sure,", False),
                (_IN, "Hi", False),
                (_IN, " there", True),
            ],
            [
                (_IN, 0, "final", "Hi there"),
                (_OUT, 1, "cumulative", "Sure,"),
                (_OUT, 1, "cumulative", "Sure, one"),
                (_OUT, 2, "cumulative", "Sure,"),
                (_IN, 3, "cumulative", "Hi"),
                (_IN, 3, "final", "Hi there"),
            ],
            id="E-no-dedupe-across-turns-or-lines",
        ),
        pytest.param(
            [
                (_IN, "Create it", True),
                (_OUT, "Shall I", False),
                (_OUT, " create it?", False),
                (_OUT, " Shall I create it?", True),
            ],
            [
                (_IN, 0, "final", "Create it"),
                (_OUT, 1, "cumulative", "Shall I"),
                (_OUT, 1, "cumulative", "Shall I create it?"),
                (_OUT, 1, "final", "Shall I create it?"),
            ],
            id="F-space-led-final-restates-the-line",
        ),
        pytest.param(
            [
                (_IN, "Create it", True),
                (_OUT, " Shall I", False),
                (_OUT, " create it?", False),
                (_OUT, "Shall I create it? ", True),
            ],
            [
                (_IN, 0, "final", "Create it"),
                (_OUT, 1, "cumulative", "Shall I"),
                (_OUT, 1, "cumulative", "Shall I create it?"),
                (_OUT, 1, "final", "Shall I create it?"),
            ],
            id="G-final-restates-with-other-whitespace",
        ),
        # The line Live just finished, sent again finished in the same turn, is
        # already shown final: nothing more is sent, as the old client merge
        # ignored a repeated final on a settled row.
        pytest.param(
            [
                (_IN, "Create it", True),
                (_OUT, "Shall I create it?", True),
                (_OUT, "Shall I create it?", True),
            ],
            [(_IN, 0, "final", "Create it"), (_OUT, 1, "final", "Shall I create it?")],
            id="H-finished-line-resent",
        ),
        pytest.param(
            [
                (_IN, "Create it", True),
                (_OUT, "Shall I", False),
                (_OUT, " create it?", False),
                (_OUT, " Shall I create it?", True),
                (_OUT, " Shall I create it? ", True),
            ],
            [
                (_IN, 0, "final", "Create it"),
                (_OUT, 1, "cumulative", "Shall I"),
                (_OUT, 1, "cumulative", "Shall I create it?"),
                (_OUT, 1, "final", "Shall I create it?"),
            ],
            id="F-then-the-final-resent",
        ),
        # Negative controls: only the line just finished, resent in its own
        # turn, is dropped. Words extending it are never lost, and the same
        # words after other words, or in the next turn, are said again.
        pytest.param(
            [
                (_IN, "Create it", True),
                (_OUT, "Shall I create it?", True),
                (_OUT, "Shall I create it? Say yes.", False),
            ],
            [
                (_IN, 0, "final", "Create it"),
                (_OUT, 1, "final", "Shall I create it?"),
                (_OUT, 2, "cumulative", "Shall I create it? Say yes."),
            ],
            id="extension-after-the-final-is-kept",
        ),
        pytest.param(
            [
                (_OUT, "Done.", True),
                (_OUT, "Anything else?", True),
                (_OUT, "Done.", True),
                _END,
                (_OUT, "Done.", True),
            ],
            [
                (_OUT, 0, "final", "Done."),
                (_OUT, 1, "final", "Anything else?"),
                (_OUT, 2, "final", "Done."),
                (_OUT, 3, "final", "Done."),
            ],
            id="said-again-later-or-in-the-next-turn",
        ),
        # A yes said over Live waits for Live's boundary; the person's next
        # words then join that same input. Saying it again is still shown.
        pytest.param(
            [
                (_IN, "Create it", True),
                (_OUT, "Sure", False),
                (_IN, "Yes.", True),
                _END,
                (_IN, "Yes.", True),
            ],
            [
                (_IN, 0, "final", "Create it"),
                (_OUT, 1, "cumulative", "Sure"),
                (_IN, 2, "final", "Yes."),
                (_IN, 3, "final", "Yes."),
            ],
            id="the-person-says-it-again-after-the-boundary",
        ),
        # Negative controls the old client merge protects: a space-led chunk
        # that only repeats the previous one, or grows a word already heard,
        # continues the line.
        pytest.param(
            [(_IN, "S", False), (_IN, " S", True)],
            [(_IN, 0, "cumulative", "S"), (_IN, 0, "final", "S S")],
            id="spelled-letter-repeated-with-a-space",
        ),
        pytest.param(
            [(_IN, "H", False), (_IN, " Hussh garage", True)],
            [(_IN, 0, "cumulative", "H"), (_IN, 0, "final", "H Hussh garage")],
            id="space-led-final-never-drops-what-was-heard",
        ),
    ],
)
async def test_transcript_provider_shapes_never_double_a_restated_line(steps, expected):
    """UAT 2026-10-06 showed "HelloHelloHello" and "Shall I create it? Shall I
    create it?". The relay merges like the old client merge did (a chunk
    extending the line replaces it) and lets a finished chunk restating the
    line replace it. A repeated delta cannot be told from re-sent speech by
    shape, so it still appends (A, C)."""
    session, transport, _fake = await _relay_on_live()
    await _feed(session, steps)
    assert _lines(transport) == expected


async def test_each_transcript_line_logs_its_chunk_shape_once_without_text(caplog):
    """The capture used synthetic audio, so a real microphone's shape is still
    unknown: every line logs its chunk counts once, when it ends, never words."""
    session, _transport, _fake = await _relay_on_live()
    with caplog.at_level(logging.INFO, logger="hushh_mcp.one_voice.session"):
        await _feed(
            session,
            [
                (_IN, "Private", False),
                (_IN, "Private words", False),
                (_IN, "Private words", True),
                (_OUT, "Private", False),
                (_OUT, " reply.", False),
                (_OUT, " Private reply.", True),
                _END,
                # Captured output shape: deltas, and the line ends with the turn.
                (_OUT, "More", False),
                (_OUT, " private words.", False),
                _END,
            ],
        )
    shapes = [
        dict(field.split("=", 1) for field in record.getMessage().split()[1:])
        for record in caplog.records
        if record.getMessage().startswith("one_voice.transcript_shape role=")
    ]
    counts = ("role", "partial", "final", "repeat", "extended", "restated")
    assert [tuple(shape[key] for key in counts) for shape in shapes] == [
        ("input", "2", "1", "1", "1", "1"),
        ("output", "2", "1", "0", "0", "1"),
        ("output", "2", "0", "0", "0", "0"),
    ]
    assert all(shape["session"] == "sess-1" and shape["turn"] for shape in shapes)
    assert "private" not in caplog.text.lower()


async def test_typed_echo_is_one_final_transcript_segment():
    session, transport, fake = await _relay_on_live()
    await session._handle_client_frame(
        protocol.TextFrame(type="text", text="What is my name?", request_id="typed-1")
    )
    [echo] = transport.frames("transcript.input")
    assert (echo["seq"], echo["kind"], echo["final"], echo["text"]) == (
        1,
        "final",
        True,
        "What is my name?",
    )
    assert echo["segment_id"] and echo["request_id"] == "typed-1"
    assert fake.texts == ["What is my name?"]


# --- tool dispatch ---------------------------------------------------------


def test_tool_call_sharing_a_provider_message_with_turn_complete_keeps_its_turn():
    message = SimpleNamespace(
        server_content=SimpleNamespace(model_turn=None, turn_complete=True),
        tool_call=SimpleNamespace(
            function_calls=[SimpleNamespace(id="call-a", name="echo", args={"text": "hi"})]
        ),
    )
    assert [event.kind for event in translate_message(message)] == ["tool_call"]


async def test_read_tool_result_goes_to_client_and_model():
    transport = FakeTransport([AUTH])
    fake = FakeLive(
        [
            LiveEvent(
                kind="tool_call",
                function_calls=[{"id": "c1", "name": "echo", "args": {"text": "hi"}}],
            ),
            None,
        ]
    )
    session = _session(transport, fake)
    task = asyncio.create_task(session.run())
    await asyncio.sleep(0.2)
    transport.push({"type": "end"})
    await asyncio.wait_for(task, 3)
    assert transport.frames("tool.started")[0]["tool"] == "echo"
    result = transport.frames("tool.result")[0]
    assert result["ok"] is True and result["result_public"]["echoed"] == "hi"
    assert fake.tool_responses[0]["response"]["status"] == "ok"
    assert fake.tool_responses[0]["id"] == "c1"


async def test_digest_narration_owns_its_turns_audio(monkeypatch):
    from hushh_mcp.one_voice import config
    from hushh_mcp.services import voice_narration

    monkeypatch.setattr(config, "voice_mail_narration_enabled", lambda: True)

    async def narrate(_digest, *, voice_name):
        yield voice_narration.Narration(
            audio=b"spoken",
            mime_type="audio/L16;codec=pcm;rate=24000",
            sample_rate=24000,
            characters=6,
        )

    monkeypatch.setattr(voice_narration, "narrate_digest_stream", narrate)

    class NarratedResult(EchoResult):
        def narratable_digest(self) -> str:
            return "A short digest."

    class NarratedExecutor:
        async def call(self, _ctx, _name, _args, *, origin_turn_id=None):
            return ToolCallOutcome(result=NarratedResult(status="ok", echoed="mail"))

    transport = FakeTransport()
    fake = FakeLive([])
    session = _session(transport, fake)
    await session._open_conversation(
        AuthResult(user_id=USER, vault_owner_token="HCT:token", firebase_id_token=None)  # noqa: S106 - synthetic test authority
    )
    session.live = fake
    session.executor = NarratedExecutor()
    await session._handle_client_frame(protocol.TextFrame(type="text", text="Find my mail"))
    await session._dispatch_tool_call({"id": "c1", "name": "echo", "args": {"text": "mail"}})
    narrated = transport.frames("audio")
    assert len(narrated) == 1 and narrated[0]["narration"] is True
    assert fake.tool_responses[0]["response"]["spoken_facts"] == []

    await session._handle_live_event(LiveEvent(kind="audio", audio_b64="QUJD"))
    await session._handle_live_event(
        LiveEvent(kind="output_transcript", text="A model duplicate.", finished=True)
    )
    assert transport.frames("audio") == narrated
    assert transport.frames("transcript.output") == []

    await session._handle_live_event(LiveEvent(kind="turn_complete"))
    await session._handle_live_event(LiveEvent(kind="audio", audio_b64="QUJD"))
    await session._handle_live_event(
        LiveEvent(kind="output_transcript", text="A late model duplicate.", finished=True)
    )
    assert transport.frames("audio") == narrated
    assert transport.frames("transcript.output") == []
    await session._handle_client_frame(protocol.TextFrame(type="text", text="Next question"))
    await session._handle_live_event(LiveEvent(kind="audio", audio_b64="QUJD"))
    assert len(transport.frames("audio")) == 2


async def test_stale_directive_and_client_step_acks_do_not_enter_new_question():
    transport = FakeTransport()
    fake = FakeLive([])
    session = _session(transport, fake)
    await session._open_conversation(
        AuthResult(user_id=USER, vault_owner_token="HCT:token", firebase_id_token=None)  # noqa: S106 - synthetic test authority
    )
    session.live = fake
    await session._handle_client_frame(protocol.TextFrame(type="text", text="First question"))
    old_turn = session.turn.turn_id
    await session._emit_side_effects(
        ToolCallOutcome(
            result=ToolResult(
                status="navigation_dispatched",
                gateway_action_id="route.one_location",
                client_step={"kind": "noop"},
            )
        ),
        origin_turn_id=old_turn,
    )
    directive_id = transport.frames("ui_directive")[-1]["directive_id"]
    step_id = transport.frames("client_step.request")[-1]["step_id"]
    await session._handle_client_frame(protocol.TextFrame(type="text", text="Second question"))
    await session._handle_client_frame(
        protocol.UiSettledFrame(type="ui.settled", directive_id=directive_id, status="ignored")
    )
    await session._handle_client_frame(
        protocol.ClientStepResultFrame(type="client_step.result", step_id=step_id, status="failed")
    )
    assert fake.events_sent == []

    await session._handle_live_event(LiveEvent(kind="turn_complete"))
    new_turn = session.turn.turn_id
    await session._emit_side_effects(
        ToolCallOutcome(
            result=ToolResult(
                status="navigation_dispatched",
                gateway_action_id="route.one_location",
                client_step={"kind": "noop"},
            )
        ),
        origin_turn_id=new_turn,
    )
    directive_id = transport.frames("ui_directive")[-1]["directive_id"]
    step_id = transport.frames("client_step.request")[-1]["step_id"]
    await session._handle_client_frame(
        protocol.UiSettledFrame(type="ui.settled", directive_id=directive_id, status="opened")
    )
    await session._handle_client_frame(
        protocol.ClientStepResultFrame(type="client_step.result", step_id=step_id, status="ok")
    )
    assert [
        json.loads(event.removeprefix("[ONE_EVENT] "))["kind"] for event in fake.events_sent
    ] == ["ui_settled", "client_step"]


async def test_ui_settled_tells_the_model_which_screen_it_was_about():
    """A failed open must reach the model as a failed open of that screen, so it
    cannot keep saying "I've opened your profile"."""
    transport = FakeTransport()
    fake = FakeLive([])
    session = _session(transport, fake)
    await session._open_conversation(
        AuthResult(user_id=USER, vault_owner_token="HCT:token", firebase_id_token=None)  # noqa: S106 - synthetic test authority
    )
    session.live = fake
    await session._handle_client_frame(protocol.TextFrame(type="text", text="Open my profile"))
    ref = "0f8fad5b-d9cb-469f-a165-70867728950e"
    await session._emit_side_effects(
        ToolCallOutcome(
            result=ToolResult(
                status="navigation_dispatched",
                gateway_action_id="route.person_profile",
                screen="person_profile",
                user_id="u-priya",
                public_person_ref=ref,
            )
        ),
        call_id="call-profile",
        origin_turn_id=session.turn.turn_id,
    )
    directive = transport.frames("ui_directive")[-1]
    assert directive["payload"]["public_person_ref"] == ref
    assert directive["payload"]["call_id"] == "call-profile"
    assert directive["payload"]["gateway_action_id"] == "route.person_profile"
    await session._handle_client_frame(
        protocol.UiSettledFrame(
            type="ui.settled", directive_id=directive["directive_id"], status="failed"
        )
    )
    event = json.loads(fake.events_sent[-1].removeprefix("[ONE_EVENT] "))
    assert event == {
        "kind": "ui_settled",
        "directive_id": directive["directive_id"],
        "status": "failed",
        "directive_kind": "navigate",
        "screen": "person_profile",
    }


async def test_a_draft_open_is_a_directive_that_names_a_row_not_a_draft():
    """ "Open the second draft" reaches the surface as which row, from which offer,
    in which conversation -- the surface fetches the draft itself -- and its
    settle reaches the model as an open_draft outcome."""
    from hushh_mcp.one_voice.tools.mail_drafts import DraftOpenDispatched

    transport = FakeTransport()
    fake = FakeLive([])
    session = _session(transport, fake)
    await session._open_conversation(
        AuthResult(user_id=USER, vault_owner_token="HCT:token", firebase_id_token=None)  # noqa: S106 - synthetic test authority
    )
    session.live = fake
    await session._handle_client_frame(protocol.TextFrame(type="text", text="Open the second"))
    await session._emit_side_effects(
        ToolCallOutcome(
            result=DraftOpenDispatched(
                ordinal=2, offer_revision=4, conversation_id=CONV, spoken_facts=["Opening it."]
            )
        ),
        origin_turn_id=session.turn.turn_id,
    )
    directive = transport.frames("ui_directive")[-1]
    assert directive["kind"] == "open_draft"
    assert directive["payload"] == {"ordinal": 2, "offer_revision": 4, "conversation_id": CONV}
    await session._handle_client_frame(
        protocol.UiSettledFrame(
            type="ui.settled", directive_id=directive["directive_id"], status="opened"
        )
    )
    event = json.loads(fake.events_sent[-1].removeprefix("[ONE_EVENT] "))
    assert (event["status"], event["directive_kind"]) == ("opened", "open_draft")


async def test_superseded_confirmation_is_cancelled_before_it_can_be_relisted():
    transport = FakeTransport()
    fake = FakeLive([])
    pending = MemoryPendingStore()
    session = _session(transport, fake, pending=pending)
    await session._open_conversation(
        AuthResult(user_id=USER, vault_owner_token="HCT:token", firebase_id_token=None)  # noqa: S106 - synthetic test authority
    )
    session.live = fake
    started = asyncio.Event()
    release = asyncio.Event()

    class DelayedConfirmation:
        async def call(self, _ctx, _name, _args, *, origin_turn_id=None):
            row, receipt = await pending.create(
                user_id=USER,
                conversation_id=CONV,
                tool_name="ask",
                gateway_action_id="location.send_request",
                tier="tap",
                args={},
                summary="Ask for location",
            )
            started.set()
            await release.wait()
            return ToolCallOutcome(
                result=ConfirmationRequired(
                    pending_action_id=row.id, tier="tap", summary="Ask for location"
                ),
                pending=row,
                receipt_token=receipt,
            )

    session.executor = DelayedConfirmation()
    await session._handle_client_frame(protocol.TextFrame(type="text", text="First question"))
    call = asyncio.create_task(session._dispatch_tool_call({"id": "c1", "name": "ask", "args": {}}))
    await asyncio.wait_for(started.wait(), 1)
    await session._handle_client_frame(protocol.TextFrame(type="text", text="Second question"))
    release.set()
    await asyncio.wait_for(call, 1)
    assert transport.frames("pending_action") == []
    assert fake.tool_responses[-1]["response"]["status"] == "superseded"
    assert await pending.list_open(user_id=USER, conversation_id=CONV) == []


async def test_provider_continuation_can_prepare_a_card_for_the_same_input():
    transport = FakeTransport()
    fake = FakeLive([])
    pending = MemoryPendingStore()
    session = _session(transport, fake, pending=pending)
    await session._open_conversation(
        AuthResult(user_id=USER, vault_owner_token="HCT:token", firebase_id_token=None)  # noqa: S106 - synthetic test authority
    )
    session.live = fake
    session.ctx.entities.remember_person(
        ConfirmedPerson(user_id="u-priya", display_name="Priya", confirmed_at=now_iso())
    )

    await session._handle_client_frame(
        protocol.TextFrame(type="text", text="Ask Priya for her location")
    )
    input_turn = session.turn.turn_id
    await session._dispatch_tool_call({"id": "c1", "name": "echo", "args": {"text": "Priya"}})
    await session._handle_live_event(LiveEvent(kind="turn_complete"))
    continuation_turn = session.turn.turn_id
    assert continuation_turn != input_turn

    await session._handle_live_event(
        LiveEvent(
            kind="tool_call",
            function_calls=[
                {"id": "c2", "name": "ask", "args": {"person": {"user_id": "u-priya"}}}
            ],
        )
    )
    cards = transport.frames("pending_action")
    assert len(cards) == 1
    assert cards[0]["turn_id"] == continuation_turn
    assert fake.tool_responses[-1]["response"]["status"] == "confirmation_required"
    assert len(await pending.list_open(user_id=USER, conversation_id=CONV)) == 1


async def test_new_spoken_input_does_not_reuse_a_model_continuation_turn():
    transport = FakeTransport()
    fake = FakeLive([])
    session = _session(transport, fake)
    await session._open_conversation(
        AuthResult(user_id=USER, vault_owner_token="HCT:token", firebase_id_token=None)  # noqa: S106 - synthetic test authority
    )
    session.live = fake

    await session._handle_live_event(
        LiveEvent(kind="input_transcript", text="First question", finished=True)
    )
    first_input = transport.frames("transcript.input")[-1]["turn_id"]
    await session._handle_live_event(LiveEvent(kind="turn_complete"))
    continuation_turn = session.turn.turn_id
    assert session._origin_is_stale(continuation_turn) is False

    await session._handle_live_event(
        LiveEvent(kind="output_transcript", text="One is still answering", finished=False)
    )
    await session._handle_live_event(
        LiveEvent(kind="input_transcript", text="Different question", finished=True)
    )
    next_input = transport.frames("transcript.input")[-1]["turn_id"]
    assert next_input not in {first_input, continuation_turn}
    assert session._origin_is_stale(continuation_turn) is True


async def _relay_on_live():
    transport = FakeTransport()
    fake = FakeLive([])
    session = _session(transport, fake)
    await session._open_conversation(
        AuthResult(user_id=USER, vault_owner_token="HCT:token", firebase_id_token=None)  # noqa: S106 - synthetic test authority
    )
    session.live = fake
    return session, transport, fake


async def _say(session, *pieces: str) -> None:
    """One spoken input as Live transcribes it: pieces, the last one final."""
    for index, piece in enumerate(pieces):
        await session._handle_live_event(
            LiveEvent(kind="input_transcript", text=piece, finished=index == len(pieces) - 1)
        )


async def _speak_and_end(session, *chunks: str) -> None:
    for chunk in chunks:
        await session._handle_live_event(LiveEvent(kind="audio", audio_b64=chunk))
    await session._handle_live_event(LiveEvent(kind="turn_complete"))


def _echo_call(call_id: str) -> LiveEvent:
    return LiveEvent(
        kind="tool_call",
        function_calls=[{"id": call_id, "name": "echo", "args": {"text": "hi"}}],
    )


async def test_every_question_in_a_spoken_conversation_is_answered():
    """UAT 2026-10-05 (session 8ad16cff): after One finished speaking an answer,
    the reply to the next spoken question was dropped, every other question.
    The question fenced the idle turn opened by turn_complete, Live's reply
    landed in that fenced turn, and model_end carried the idle turn's id, so
    the pill stayed on "Understanding" with nothing left to end it."""
    session, transport, _fake = await _relay_on_live()
    questions = []
    for chunk in ("QUFB", "QkJC", "Q0ND", "RERE"):
        await _say(session, "And what", " about this?")
        questions.append(transport.frames("transcript.input")[-1]["turn_id"])
        await _speak_and_end(session, chunk)

    assert len(set(questions)) == 4
    assert [frame["turn_id"] for frame in transport.frames("audio")] == questions
    ends = [frame["turn_id"] for frame in transport.frames("turn") if frame["state"] == "model_end"]
    assert ends == questions
    understood = [
        frame["turn_id"] for frame in transport.frames("state") if frame["state"] == "understanding"
    ]
    assert understood == questions


async def test_a_question_live_reports_after_its_interruption_is_answered():
    """Barge-in: Live can report `interrupted` before the new transcript."""
    session, transport, _fake = await _relay_on_live()
    await _say(session, "Tell me about the weekend")
    await session._handle_live_event(LiveEvent(kind="audio", audio_b64="QUFB"))
    await session._handle_live_event(LiveEvent(kind="interrupted"))
    await _say(session, "Actually, just Saturday")
    barge_in = transport.frames("transcript.input")[-1]["turn_id"]
    await _speak_and_end(session, "QkJC")

    assert transport.frames("audio")[-1]["turn_id"] == barge_in
    assert transport.frames("turn")[-1] == {
        "type": "turn",
        "state": "model_end",
        "turn_id": barge_in,
    }


async def test_a_question_waits_behind_the_reply_a_tool_result_still_owes():
    """Live may close a tool-call turn and speak about the result in a fresh
    one. A question asked before that reply starts must not take the turn the
    reply will use (ed068703f): the reply is fenced, then the question is
    answered under its own id."""
    session, transport, fake = await _relay_on_live()
    await _say(session, "Look something up")
    await session._handle_live_event(_echo_call("c1"))
    await session._handle_live_event(LiveEvent(kind="turn_complete"))
    await _say(session, "And one more thing")
    question = transport.frames("transcript.input")[-1]["turn_id"]
    await _speak_and_end(session, "QUFB")
    await _speak_and_end(session, "QkJC")

    assert fake.tool_responses[0]["response"].get("status") != "superseded"
    assert [frame["turn_id"] for frame in transport.frames("audio")] == [question]
    assert transport.frames("turn")[-1]["turn_id"] == question


async def test_an_answer_carried_with_its_transcript_is_heard_under_its_question():
    """Live can carry the end of the input transcript and the first answer
    chunk in one server message. The relay must see the person's words first,
    or that chunk is attributed to the turn before they spoke."""
    message = genai_types.LiveServerMessage(
        server_content=genai_types.LiveServerContent(
            input_transcription=genai_types.Transcription(text="Second question", finished=True),
            model_turn=genai_types.Content(
                parts=[
                    genai_types.Part(
                        inline_data=genai_types.Blob(data=b"BBB", mime_type="audio/pcm")
                    )
                ]
            ),
        )
    )
    events = translate_message(message)
    assert [event.kind for event in events] == ["input_transcript", "audio"]

    session, transport, _fake = await _relay_on_live()
    await _say(session, "First question")
    await _speak_and_end(session, "QUFB")
    for event in events:
        await session._handle_live_event(event)
    question = transport.frames("transcript.input")[-1]["turn_id"]
    await _speak_and_end(session, "Q0ND")

    assert [frame["turn_id"] for frame in transport.frames("audio")][1:] == [question, question]
    assert transport.frames("turn")[-1] == {
        "type": "turn",
        "state": "model_end",
        "turn_id": question,
    }


async def test_a_question_asked_after_an_answer_can_use_a_tool():
    """The muted turn also refused the next question's tool call as stale."""
    session, transport, fake = await _relay_on_live()
    await _say(session, "First question")
    await _speak_and_end(session, "QUFB")
    await _say(session, "Now look something up")
    question = transport.frames("transcript.input")[-1]["turn_id"]
    await session._handle_live_event(_echo_call("c2"))

    assert fake.tool_responses[-1]["response"].get("status") != "superseded"
    assert transport.frames("tool.result")[-1]["turn_id"] == question


async def test_a_reply_live_never_speaks_holds_back_one_question_at_most():
    """If Live answers the next question instead of speaking about a tool
    result, that one question is held and muted; the question after it must
    not be."""
    session, transport, _fake = await _relay_on_live()
    await _say(session, "Look something up")
    await session._handle_live_event(_echo_call("c1"))
    await session._handle_live_event(LiveEvent(kind="turn_complete"))
    await _say(session, "Second question")
    await _speak_and_end(session, "QUFB")
    await _say(session, "Third question")
    latest = transport.frames("transcript.input")[-1]["turn_id"]
    await _speak_and_end(session, "QkJC")

    assert transport.frames("audio")[-1]["turn_id"] == latest
    assert transport.frames("turn")[-1] == {"type": "turn", "state": "model_end", "turn_id": latest}


def _heard(transport) -> list[tuple[str, str]]:
    return [(frame["data"], frame["turn_id"]) for frame in transport.frames("audio")]


async def test_speaking_over_a_reply_keeps_the_rest_of_it_out_of_the_new_answer():
    """Barge-in while Live speaks about a tool result: the rest of that reply,
    and anything it proposes, must not be presented as the new question's
    answer (an abandoned request would come back as its card)."""
    session, transport, _fake = await _relay_on_live()
    await _say(session, "Look something up")
    await session._handle_live_event(_echo_call("c1"))
    await session._handle_live_event(LiveEvent(kind="turn_complete"))
    await session._handle_live_event(LiveEvent(kind="audio", audio_b64="QUFB"))
    await _say(session, "Wait, never mind")
    question = transport.frames("transcript.input")[-1]["turn_id"]
    await session._handle_live_event(LiveEvent(kind="audio", audio_b64="QkJC"))
    await session._handle_live_event(LiveEvent(kind="interrupted"))
    await _speak_and_end(session, "Q0ND")

    heard = _heard(transport)
    assert heard[0][0] == "QUFB" and heard[0][1] != question
    assert "QkJC" not in [data for data, _turn in heard]
    assert heard[-1] == ("Q0ND", question)


async def test_a_spoken_question_does_not_take_a_typed_question_s_answer():
    """A typed question that took the idle turn owns it: a spoken question
    right after it waits, and the typed question's answer is not its answer."""
    session, transport, _fake = await _relay_on_live()
    await _say(session, "First question")
    await _speak_and_end(session, "QUFB")
    await session._handle_client_frame(protocol.TextFrame(type="text", text="Ask for a location"))
    await _say(session, "What time is it")
    spoken = transport.frames("transcript.input")[-1]["turn_id"]
    await _speak_and_end(session, "QkJC")
    await _speak_and_end(session, "Q0ND")

    assert [data for data, _turn in _heard(transport)] == ["QUFB", "Q0ND"]
    assert _heard(transport)[-1] == ("Q0ND", spoken)


async def test_a_question_right_after_an_app_event_waits_for_its_reply():
    """An [ONE_EVENT] closes a turn of its own, so Live owes it a reply; a
    question asked before that reply must not receive it as its answer."""
    session, transport, fake = await _relay_on_live()
    await _say(session, "Open my settings")
    await _speak_and_end(session, "QUFB")
    await session._inject_event({"kind": "ui_settled", "status": "opened"})
    await _say(session, "And my profile?")
    question = transport.frames("transcript.input")[-1]["turn_id"]
    await _speak_and_end(session, "QkJC")
    await _speak_and_end(session, "Q0ND")

    assert fake.events_sent
    assert [data for data, _turn in _heard(transport)] == ["QUFB", "Q0ND"]
    assert _heard(transport)[-1] == ("Q0ND", question)


async def test_new_input_still_supersedes_a_delayed_continuation_card():
    transport = FakeTransport()
    fake = FakeLive([])
    pending = MemoryPendingStore()
    session = _session(transport, fake, pending=pending)
    await session._open_conversation(
        AuthResult(user_id=USER, vault_owner_token="HCT:token", firebase_id_token=None)  # noqa: S106 - synthetic test authority
    )
    session.live = fake
    started = asyncio.Event()
    release = asyncio.Event()

    class DelayedConfirmation:
        async def call(self, _ctx, _name, _args, *, origin_turn_id=None):
            row, receipt = await pending.create(
                user_id=USER,
                conversation_id=CONV,
                tool_name="ask",
                gateway_action_id="location.send_request",
                tier="voice",
                args={},
                summary="Ask for location",
            )
            started.set()
            await release.wait()
            return ToolCallOutcome(
                result=ConfirmationRequired(
                    pending_action_id=row.id, tier="voice", summary="Ask for location"
                ),
                pending=row,
                receipt_token=receipt,
            )

    session.executor = DelayedConfirmation()
    await session._handle_client_frame(protocol.TextFrame(type="text", text="First question"))
    await session._handle_live_event(LiveEvent(kind="turn_complete"))
    continuation_turn = session.turn.turn_id
    call = asyncio.create_task(
        session._handle_live_event(
            LiveEvent(kind="tool_call", function_calls=[{"id": "c1", "name": "ask", "args": {}}])
        )
    )
    await asyncio.wait_for(started.wait(), 1)
    await session._handle_client_frame(protocol.TextFrame(type="text", text="Second question"))
    release.set()
    await asyncio.wait_for(call, 1)

    assert transport.frames("tool.started")[-1]["turn_id"] == continuation_turn
    assert transport.frames("pending_action") == []
    assert fake.tool_responses[-1]["response"]["status"] == "superseded"
    assert await pending.list_open(user_id=USER, conversation_id=CONV) == []


@pytest.mark.parametrize("operation", ["get_pending_action", "confirm_pending_action"])
async def test_superseded_existing_card_keeps_its_true_status(operation):
    pending = MemoryPendingStore()
    row, _ = await pending.create(
        user_id=USER,
        conversation_id=CONV,
        tool_name="ask",
        gateway_action_id="location.send_request",
        tier="voice",
        args={"person": {"user_id": "u-priya"}, "hours": 1},
        summary="ask Priya for her location",
    )
    await pending.mark_shown(user_id=USER, pending_action_id=row.id)
    transport, fake = FakeTransport(), FakeLive([])
    session = _session(transport, fake, pending=pending)
    await session._open_conversation(
        AuthResult(user_id=USER, vault_owner_token="HCT:token", firebase_id_token=None)  # noqa: S106 - synthetic authority
    )
    session.live = fake
    session.ctx.entities.remember_person(
        ConfirmedPerson(user_id="u-priya", display_name="Priya", confirmed_at=now_iso())
    )
    real_executor = session.executor
    started, release = asyncio.Event(), asyncio.Event()

    class DelayedExistingCard:
        async def call(self, ctx, name, args, *, origin_turn_id=None):
            started.set()
            await release.wait()
            return await real_executor.call(ctx, name, args, origin_turn_id=origin_turn_id)

    session.executor = DelayedExistingCard()
    await session._handle_client_frame(protocol.TextFrame(type="text", text="First question"))
    call = asyncio.create_task(
        session._dispatch_tool_call(
            {"id": "old-call", "name": operation, "args": {"pending_action_id": row.id}}
        )
    )
    await asyncio.wait_for(started.wait(), 1)
    await session._handle_client_frame(protocol.TextFrame(type="text", text="New question"))
    release.set()
    await asyncio.wait_for(call, 1)

    expected = "pending" if operation == "get_pending_action" else "executed"
    assert pending.rows[row.id].status == expected
    resolved = transport.frames("pending_action.resolved")
    if operation == "get_pending_action":
        assert resolved == []
    else:
        assert resolved[-1]["pending_action_id"] == row.id
        assert resolved[-1]["status"] == "executed"
        assert resolved[-1]["result_public"]["status"] == "pending"
    assert transport.frames("tool.result") == []
    assert fake.tool_responses[-1]["response"]["status"] == "superseded"


async def test_confirmed_device_step_finishes_without_replacing_newer_answer():
    pending = MemoryPendingStore()
    row, receipt = await pending.create(
        user_id=USER,
        conversation_id=CONV,
        tool_name=RESUME,
        gateway_action_id="location.resume_updates",
        tier="tap",
        args={},
        summary="resume location updates",
    )
    confirmed = await pending.confirm(
        user_id=USER, pending_action_id=row.id, source="tap", receipt_token=receipt
    )
    resolved = await pending.resolve(
        user_id=USER,
        pending_action_id=row.id,
        status="executed",
        result={"status": protocol.LOCATION_UPDATES_PENDING},
    )
    assert confirmed is not None and resolved is not None
    transport, fake = FakeTransport(), FakeLive([])
    session = _session(transport, fake, pending=pending)
    await session._open_conversation(
        AuthResult(user_id=USER, vault_owner_token="HCT:token", firebase_id_token=None)  # noqa: S106 - synthetic authority
    )
    session.live = fake
    await session._handle_client_frame(protocol.TextFrame(type="text", text="First question"))
    origin = session.turn.turn_id
    await session._handle_client_frame(protocol.TextFrame(type="text", text="New question"))
    await session._after_execution(
        ToolCallOutcome(
            result=location_state.LocationUpdatesResult(
                status=protocol.LOCATION_UPDATES_PENDING,
                desired_state="on",
                gateway_action_id="location.resume_updates",
                needs="client_step",
                client_step={
                    "kind": "set_location_updates",
                    "desired_state": "on",
                    "gateway_action_id": "location.resume_updates",
                    "timeout_s": 45,
                },
            ),
            spec=DEVICE_TOOLS[0],
            pending=resolved,
        ),
        source="tap",
        origin_turn_id=origin,
    )
    step = transport.frames("client_step.request")[-1]
    assert step["turn_id"] == origin
    assert step["confirmed_pending_action_id"] == row.id
    assert transport.frames("pending_action.resolved")[-1]["pending_action_id"] == row.id
    assert transport.frames("tool.result") == []
    assert fake.events_sent == []

    await session._client_step_result(
        protocol.ClientStepResultFrame(
            type="client_step.result",
            step_id=step["step_id"],
            status="ok",
            payload={
                "gateway_action_id": "location.resume_updates",
                "desired_state": "on",
                "outcome": "on",
                "observed_state": "on",
                "navigated": True,
            },
        )
    )
    final = transport.frames("pending_action.resolved")[-1]
    assert final["pending_action_id"] == row.id
    assert final["result_public"]["status"] == "on"
    assert transport.frames("tool.result") == []
    assert fake.events_sent == []


async def test_stale_confirmed_share_sheet_does_not_open_over_new_question():
    pending = MemoryPendingStore()
    row, receipt = await pending.create(
        user_id=USER,
        conversation_id=CONV,
        tool_name="create_public_link",
        gateway_action_id="location.create_public_link",
        tier="tap",
        args={},
        summary="create a link",
    )
    await pending.confirm(
        user_id=USER, pending_action_id=row.id, source="tap", receipt_token=receipt
    )
    resolved = await pending.resolve(
        user_id=USER, pending_action_id=row.id, status="executed", result={"status": "created"}
    )
    assert resolved is not None
    transport, fake = FakeTransport(), FakeLive([])
    session = _session(transport, fake, pending=pending)
    await session._open_conversation(
        AuthResult(user_id=USER, vault_owner_token="HCT:token", firebase_id_token=None)  # noqa: S106 - synthetic authority
    )
    session.live = fake
    await session._handle_client_frame(protocol.TextFrame(type="text", text="Create a link"))
    origin = session.turn.turn_id
    await session._handle_client_frame(protocol.TextFrame(type="text", text="New question"))
    await session._after_execution(
        ToolCallOutcome(
            result=ToolResult(
                status="created",
                client_step={"kind": "open_share_sheet", "url": "https://example.test/link"},
            ),
            pending=resolved,
        ),
        source="tap",
        origin_turn_id=origin,
    )
    assert transport.frames("client_step.request") == []
    assert transport.frames("pending_action.resolved")[-1]["pending_action_id"] == row.id
    assert transport.frames("tool.result") == []
    assert fake.events_sent == []


@pytest.mark.parametrize("verification_status", ["published", "not_published"])
async def test_stale_confirmed_share_step_settles_exact_card(verification_status):
    pending = MemoryPendingStore()
    row, receipt = await pending.create(
        user_id=USER,
        conversation_id=CONV,
        tool_name="share_with",
        gateway_action_id="location.share_selected",
        tier="tap",
        args={},
        summary="share location",
    )
    await pending.confirm(
        user_id=USER, pending_action_id=row.id, source="tap", receipt_token=receipt
    )
    resolved = await pending.resolve(
        user_id=USER,
        pending_action_id=row.id,
        status="executed",
        result={"status": "grant_created", "spoken_facts": ["Sending now."]},
    )
    assert resolved is not None
    transport, fake = FakeTransport(), FakeLive([])
    session = _session(transport, fake, pending=pending)
    await session._open_conversation(
        AuthResult(user_id=USER, vault_owner_token="HCT:token", firebase_id_token=None)  # noqa: S106 - synthetic authority
    )
    session.live = fake

    async def verify(grant_ids):
        assert grant_ids == ["grant-1"]
        return {
            "status": verification_status,
            "published": ["grant-1"] if verification_status == "published" else [],
            "unpublished": [] if verification_status == "published" else ["grant-1"],
        }

    session._verify_grants_published = verify
    await session._handle_client_frame(protocol.TextFrame(type="text", text="Share with Priya"))
    origin = session.turn.turn_id
    await session._handle_client_frame(protocol.TextFrame(type="text", text="New question"))
    await session._after_execution(
        ToolCallOutcome(
            result=ToolResult(
                status="grant_created",
                needs="client_step",
                client_step={
                    "kind": "publish_location_envelopes",
                    "purpose": "share",
                    "grant_ids": ["grant-1"],
                },
            ),
            pending=resolved,
        ),
        source="tap",
        origin_turn_id=origin,
    )
    step = transport.frames("client_step.request")[-1]
    assert step["confirmed_pending_action_id"] == row.id
    await session._client_step_result(
        protocol.ClientStepResultFrame(
            type="client_step.result", step_id=step["step_id"], status="ok", payload={}
        )
    )
    final = transport.frames("pending_action.resolved")[-1]
    assert final["pending_action_id"] == row.id
    assert final["result_public"]["publish_verification"]["status"] == verification_status
    assert "client_step" not in final["result_public"]
    if verification_status == "not_published":
        assert "not published" in final["result_public"]["spoken_facts"][0]
    assert transport.frames("tool.result") == []
    assert fake.events_sent == []


async def test_delayed_model_confirmation_keeps_its_device_step_after_new_input():
    pending = MemoryPendingStore()
    row, _ = await pending.create(
        user_id=USER,
        conversation_id=CONV,
        tool_name=RESUME,
        gateway_action_id="location.resume_updates",
        tier="voice",
        args={},
        summary="resume location updates",
    )
    await pending.mark_shown(user_id=USER, pending_action_id=row.id)
    transport, fake = FakeTransport(), FakeLive([])
    session = _session(transport, fake, pending=pending)
    await session._open_conversation(
        AuthResult(user_id=USER, vault_owner_token="HCT:token", firebase_id_token=None)  # noqa: S106 - synthetic authority
    )
    session.live = fake
    started, release = asyncio.Event(), asyncio.Event()

    class DelayedConfirmedStep:
        async def call(self, _ctx, _name, _args, *, origin_turn_id=None):
            confirmed = await pending.confirm(
                user_id=USER, pending_action_id=row.id, source="voice"
            )
            assert confirmed is not None
            resolved = await pending.resolve(
                user_id=USER,
                pending_action_id=row.id,
                status="executed",
                result={"status": protocol.LOCATION_UPDATES_PENDING},
            )
            started.set()
            await release.wait()
            return ToolCallOutcome(
                result=location_state.LocationUpdatesResult(
                    status=protocol.LOCATION_UPDATES_PENDING,
                    desired_state="on",
                    gateway_action_id="location.resume_updates",
                    needs="client_step",
                    client_step={
                        "kind": "set_location_updates",
                        "desired_state": "on",
                        "gateway_action_id": "location.resume_updates",
                        "timeout_s": 45,
                    },
                ),
                spec=DEVICE_TOOLS[0],
                pending=resolved,
            )

    session.executor = DelayedConfirmedStep()
    await session._handle_client_frame(protocol.TextFrame(type="text", text="First question"))
    origin = session.turn.turn_id
    call = asyncio.create_task(
        session._dispatch_tool_call(
            {
                "id": "old-confirm",
                "name": "confirm_pending_action",
                "args": {"pending_action_id": row.id},
            }
        )
    )
    await asyncio.wait_for(started.wait(), 1)
    await session._handle_client_frame(protocol.TextFrame(type="text", text="New question"))
    release.set()
    await asyncio.wait_for(call, 1)

    step = transport.frames("client_step.request")[-1]
    assert step["turn_id"] == origin
    assert step["confirmed_pending_action_id"] == row.id
    assert pending.rows[row.id].status == "executed"
    assert transport.frames("pending_action.resolved")[-1]["pending_action_id"] == row.id
    assert transport.frames("tool.result") == []
    assert fake.tool_responses[-1]["response"]["status"] == "superseded"


async def test_new_typed_question_waits_for_old_tool_and_keeps_its_own_turn():
    transport = FakeTransport()
    fake = FakeLive([])
    session = _session(transport, fake)
    await session._open_conversation(
        AuthResult(user_id=USER, vault_owner_token="HCT:token", firebase_id_token=None)  # noqa: S106 - synthetic test authority
    )
    session.live = fake

    started = asyncio.Event()
    release = asyncio.Event()

    class BlockingExecutor:
        async def call(self, _ctx, _name, args, *, origin_turn_id=None):
            started.set()
            await release.wait()
            return ToolCallOutcome(result=EchoResult(status="ok", echoed=args["text"]))

    session.executor = BlockingExecutor()
    await session._handle_client_frame(
        protocol.TextFrame(type="text", text="Is Gmail connected?", request_id="request-a")
    )
    old_turn = session.turn.turn_id
    call = asyncio.create_task(
        session._dispatch_tool_call({"id": "call-a", "name": "echo", "args": {"text": "mail"}})
    )
    await asyncio.wait_for(started.wait(), 1)
    await session._handle_client_frame(
        protocol.TextFrame(type="text", text="What is my name?", request_id="request-b")
    )
    await session._handle_client_frame(
        protocol.TextFrame(type="text", text="What is my name?", request_id="request-c")
    )
    inputs = transport.frames("transcript.input")
    assert [row["request_id"] for row in inputs] == ["request-a", "request-b", "request-c"]
    assert len({row["turn_id"] for row in inputs}) == 3
    assert fake.texts == ["Is Gmail connected?"]
    await session._handle_live_event(LiveEvent(kind="audio", audio_b64="QUJD"))
    assert transport.frames("audio") == []

    release.set()
    await asyncio.wait_for(call, 1)
    assert transport.frames("tool.started")[0]["turn_id"] == old_turn
    assert transport.frames("tool.result") == []
    assert fake.tool_responses[0]["response"]["status"] == "superseded"
    await session._handle_live_event(LiveEvent(kind="turn_complete"))
    assert fake.texts == ["Is Gmail connected?", "What is my name?"]
    assert session.turn.turn_id == inputs[1]["turn_id"]
    await session._handle_live_event(LiveEvent(kind="turn_complete"))
    assert fake.texts == [
        "Is Gmail connected?",
        "What is my name?",
        "What is my name?",
    ]
    assert session.turn.turn_id == inputs[2]["turn_id"]


async def test_streamed_voice_turn_finishes_before_queued_typed_question():
    transport = FakeTransport()
    fake = FakeLive([])
    session = _session(transport, fake)
    await session._open_conversation(
        AuthResult(user_id=USER, vault_owner_token="HCT:token", firebase_id_token=None)  # noqa: S106 - synthetic test authority
    )
    session.live = fake

    await session._handle_live_event(
        LiveEvent(kind="input_transcript", text="voice first", finished=True)
    )
    first_voice_turn = session.turn.turn_id
    await session._handle_client_frame(protocol.TextFrame(type="text", text="typed next"))
    typed_turn = transport.frames("transcript.input")[-1]["turn_id"]
    await session._handle_live_event(
        LiveEvent(kind="input_transcript", text="voice already streamed", finished=True)
    )
    second_voice_turn = transport.frames("transcript.input")[-1]["turn_id"]
    assert len({first_voice_turn, typed_turn, second_voice_turn}) == 3

    await session._handle_live_event(LiveEvent(kind="turn_complete"))
    assert session.turn.turn_id == second_voice_turn
    assert fake.texts == []
    await session._handle_live_event(LiveEvent(kind="turn_complete"))
    assert session.turn.turn_id == typed_turn
    assert fake.texts == ["typed next"]


async def test_identical_questions_are_distinct_turns_and_execute_twice():
    transport = FakeTransport()
    fake = FakeLive([])
    session = _session(transport, fake)
    await session._open_conversation(
        AuthResult(user_id=USER, vault_owner_token="HCT:token", firebase_id_token=None)  # noqa: S106 - synthetic test authority
    )
    session.live = fake
    calls: list[tuple[str, str]] = []

    class CountingExecutor:
        async def call(self, _ctx, name, args, *, origin_turn_id=None):
            calls.append((name, args["text"]))
            return ToolCallOutcome(result=EchoResult(status="ok", echoed=args["text"]))

    session.executor = CountingExecutor()
    await session._handle_client_frame(
        protocol.TextFrame(type="text", text="What is my name?", request_id="first")
    )
    await session._dispatch_tool_call(
        {"id": "call-first", "name": "echo", "args": {"text": "What is my name?"}}
    )
    await session._handle_client_frame(
        protocol.TextFrame(type="text", text="What is my name?", request_id="second")
    )
    await session._handle_live_event(LiveEvent(kind="turn_complete"))
    await session._dispatch_tool_call(
        {"id": "call-second", "name": "echo", "args": {"text": "What is my name?"}}
    )

    assert calls == [("echo", "What is my name?"), ("echo", "What is my name?")]
    assert [row["request_id"] for row in transport.frames("transcript.input")] == [
        "first",
        "second",
    ]
    assert len({row["turn_id"] for row in transport.frames("transcript.input")}) == 2
    assert [row["turn_id"] for row in transport.frames("tool.result")] == [
        row["turn_id"] for row in transport.frames("transcript.input")
    ]


async def test_queued_typed_question_expires_when_provider_never_finishes():
    transport = FakeTransport()
    fake = FakeLive([])
    session = _session(transport, fake)
    await session._open_conversation(
        AuthResult(user_id=USER, vault_owner_token="HCT:token", firebase_id_token=None)  # noqa: S106 - synthetic test authority
    )
    session.live = fake
    now = {"value": 1_000.0}
    session.clock = lambda: now["value"]
    session.started_at = now["value"]
    session.last_activity = now["value"]
    await session._handle_live_event(
        LiveEvent(kind="input_transcript", text="voice first", finished=True)
    )
    await session._handle_client_frame(protocol.TextFrame(type="text", text="typed next"))
    now["value"] += 31

    with pytest.raises(SessionClosed):
        await asyncio.wait_for(session._watchdog(), timeout=2)
    assert transport.frames("error")[-1]["code"] == "turn_timeout"
    assert transport.closed[0] == protocol.CLOSE_PROVIDER_UNAVAILABLE


async def test_unknown_tool_is_rejected_and_counted():
    transport = FakeTransport([AUTH])
    fake = FakeLive(
        [
            LiveEvent(
                kind="tool_call",
                function_calls=[{"id": "c1", "name": "location.export_all", "args": {}}],
            ),
            None,
        ]
    )
    conversations = MemoryConversationStore()
    session = _session(transport, fake, conversations=conversations)
    task = asyncio.create_task(session.run())
    await asyncio.sleep(0.2)
    transport.push({"type": "end"})
    await asyncio.wait_for(task, 3)
    result = transport.frames("tool.result")[0]
    assert result["ok"] is False and result["result_public"]["reason_code"] == "unknown_tool"
    assert conversations.counters["unknown_tool_calls"] == 1


async def test_person_targeted_tool_requires_a_confirmed_person():
    transport = FakeTransport([AUTH])
    fake = FakeLive(
        [
            LiveEvent(
                kind="tool_call",
                function_calls=[
                    {"id": "c1", "name": "ask", "args": {"person": {"user_id": "u-priya"}}}
                ],
            ),
            None,
        ]
    )
    session = _session(transport, fake)
    task = asyncio.create_task(session.run())
    await asyncio.sleep(0.2)
    transport.push({"type": "end"})
    await asyncio.wait_for(task, 3)
    result = transport.frames("tool.result")[0]["result_public"]
    assert result["status"] == "rejected" and result["reason_code"] == "person_not_confirmed"
    assert transport.frames("pending_action") == []


async def test_voice_tier_confirmation_needs_card_shown_then_executes():
    transport = FakeTransport([AUTH])
    fake = FakeLive(
        [
            LiveEvent(
                kind="tool_call",
                function_calls=[
                    {"id": "c1", "name": "ask", "args": {"person": {"user_id": "u-priya"}}}
                ],
            ),
            None,
            # the model tries to confirm before the card was shown
            LiveEvent(
                kind="tool_call",
                function_calls=[
                    {
                        "id": "c2",
                        "name": "confirm_pending_action",
                        "args": {"pending_action_id": "__pending__"},
                    }
                ],
            ),
            None,
        ]
    )
    pending = MemoryPendingStore()
    conversations = MemoryConversationStore()
    # pre-seed the confirmed person in the conversation's entity context
    conversations.rows[CONV] = __import__(
        "hushh_mcp.one_voice.conversations", fromlist=["Conversation"]
    ).Conversation(
        id=CONV,
        user_id=USER,
        status="active",
        entity_context={
            "people": {
                "u-priya": ConfirmedPerson(
                    user_id="u-priya",
                    display_name="Priya Nair",
                    relationship="connected",
                    has_location_key=True,
                    confirmed_at=now_iso(),
                ).model_dump(mode="json")
            }
        },
        model_id="m",
        model_location="l",
        session_count=0,
    )

    # patch the fake script to use the real pending id once created
    original_events = fake.events

    async def _events():
        async for event in original_events():
            if (
                event.kind == "tool_call"
                and event.function_calls[0]["args"].get("pending_action_id") == "__pending__"
            ):
                event.function_calls[0]["args"]["pending_action_id"] = next(iter(pending.rows))
            yield event

    fake.events = _events
    session = _session(transport, fake, pending=pending, conversations=conversations)
    task = asyncio.create_task(session.run())
    await asyncio.sleep(0.3)
    card = transport.frames("pending_action")[0]
    assert card["tier"] == "voice" and card["requires_tap"] is False
    assert card["summary"] == "ask Priya Nair for their location"
    assert card["entities"][0]["display_name"] == "Priya Nair"
    assert "receipt_token" not in card
    # the premature confirm was refused
    refused = [r for r in fake.tool_responses if r["name"] == "confirm_pending_action"][0][
        "response"
    ]
    assert refused["status"] == "card_not_shown"
    assert pending.rows[card["pending_action_id"]].status == "pending"
    # now the client reports the card, and the model confirms again
    transport.push({"type": "pending_action.shown", "pending_action_id": card["pending_action_id"]})
    await asyncio.sleep(0.1)
    outcome = await session.executor.call(
        session.ctx, "confirm_pending_action", {"pending_action_id": card["pending_action_id"]}
    )
    assert outcome.result.status == "pending"
    assert outcome.result.spoken_facts == ["Asked Priya Nair. They need to approve."]
    assert pending.rows[card["pending_action_id"]].status == "executed"
    transport.push({"type": "end"})
    await asyncio.wait_for(task, 3)


async def _voice_card_session():
    transport = FakeTransport()
    fake = FakeLive([])
    pending = MemoryPendingStore()
    session = _session(transport, fake, pending=pending)
    await session._open_conversation(
        AuthResult(user_id=USER, vault_owner_token="HCT:token", firebase_id_token=None)  # noqa: S106 - synthetic test authority
    )
    session.live = fake
    session.ctx.entities.remember_person(
        ConfirmedPerson(
            user_id="u-priya",
            display_name="Priya Nair",
            relationship="connected",
            confirmed_at=now_iso(),
        )
    )
    await session._handle_client_frame(protocol.TextFrame(type="text", text="Ask Priya"))
    return session, transport, fake, pending


def _responses(fake: FakeLive, name: str) -> list[dict]:
    return [r["response"] for r in fake.tool_responses if r["name"] == name]


async def test_repeated_voice_proposal_reuses_the_open_card_on_the_current_turn():
    """After a yes, a model that proposes the same action again gets the open
    card's id back: no second row, no cancelled card, no new question."""
    session, transport, fake, pending = await _voice_card_session()
    ask = {"person": {"user_id": "u-priya"}}
    await _model_calls(session, "c1", "ask", ask)
    first = transport.frames("pending_action")[-1]
    card = first["pending_action_id"]

    await session._handle_live_event(LiveEvent(kind="turn_complete"))
    await session._handle_client_frame(protocol.TextFrame(type="text", text="Yes"))
    yes_turn = session.turn.turn_id
    assert yes_turn != first["turn_id"]
    await _model_calls(session, "c2", "ask", ask)
    # Not shown yet: the same card is sent again on the turn the client accepts.
    cards = transport.frames("pending_action")
    assert len(cards) == 2
    assert cards[-1]["pending_action_id"] == card and cards[-1]["turn_id"] == yes_turn
    assert "receipt_token" not in cards[-1]
    assert transport.frames("pending_action.resolved") == []
    waiting = _responses(fake, "ask")[-1]
    assert waiting["status"] == "confirmation_waiting"
    assert waiting["pending_action_id"] == card and waiting["card_shown"] is False
    assert transport.frames("tool.result")[-1]["ok"] is False
    assert [row.id for row in pending.rows.values() if row.status == "pending"] == [card]

    await session._handle_client_frame(
        protocol.PendingShownFrame(type="pending_action.shown", pending_action_id=card)
    )
    await _model_calls(session, "c3", "ask", ask)
    # Already on screen: no further card frame.
    assert len(transport.frames("pending_action")) == 2
    assert _responses(fake, "ask")[-1]["card_shown"] is True
    assert pending.rows[card].status == "pending"
    assert session._counters["user_input_turns"] == 2
    assert session._counters["provider_turns"] == 1
    assert session._counters["tool_calls"] == 3
    assert session._counters["pending_created"] == 1
    assert session._counters["pending_reused"] == 2
    assert session._counters.get("pending_cancelled", 0) == 0
    assert session._counters.get("confirmations_completed", 0) == 0


async def test_card_shown_after_a_refused_yes_tells_the_model_without_confirming():
    session, transport, fake, pending = await _voice_card_session()
    await _model_calls(session, "c1", "ask", {"person": {"user_id": "u-priya"}})
    card = transport.frames("pending_action")[-1]["pending_action_id"]
    await _model_calls(session, "c2", "confirm_pending_action", {"pending_action_id": card})
    refused = _responses(fake, "confirm_pending_action")[-1]
    assert refused["status"] == "card_not_shown" and refused["pending_action_id"] == card
    assert fake.events_sent == []

    await session._handle_client_frame(
        protocol.PendingShownFrame(type="pending_action.shown", pending_action_id=card)
    )
    assert [json.loads(e.removeprefix("[ONE_EVENT] ")) for e in fake.events_sent] == [
        {"kind": "pending_shown", "pending_action_id": card}
    ]
    # The host never confirms on the model's behalf.
    assert pending.rows[card].status == "pending"
    # A second shown report for the same card says nothing more.
    await session._handle_client_frame(
        protocol.PendingShownFrame(type="pending_action.shown", pending_action_id=card)
    )
    assert len(fake.events_sent) == 1


async def test_card_shown_without_a_refused_yes_tells_the_model_nothing():
    """Negative control: an ordinary card display is not an event."""
    session, transport, fake, pending = await _voice_card_session()
    await _model_calls(session, "c1", "ask", {"person": {"user_id": "u-priya"}})
    card = transport.frames("pending_action")[-1]["pending_action_id"]
    await session._handle_client_frame(
        protocol.PendingShownFrame(type="pending_action.shown", pending_action_id=card)
    )
    assert fake.events_sent == []
    assert pending.rows[card].shown_at is not None


async def test_card_shown_after_the_person_moved_on_does_not_revive_the_old_yes():
    """A refused yes answers its own turn only. Once the person has moved on,
    the card appearing later is not news to the model."""
    session, transport, fake, pending = await _voice_card_session()
    await _model_calls(session, "c1", "ask", {"person": {"user_id": "u-priya"}})
    card = transport.frames("pending_action")[-1]["pending_action_id"]
    await _model_calls(session, "c2", "confirm_pending_action", {"pending_action_id": card})
    await session._handle_live_event(LiveEvent(kind="turn_complete"))
    await session._handle_client_frame(protocol.TextFrame(type="text", text="What's the weather?"))

    await session._handle_client_frame(
        protocol.PendingShownFrame(type="pending_action.shown", pending_action_id=card)
    )
    assert fake.events_sent == []
    assert pending.rows[card].status == "pending"


async def _refused_confirmation_in_provider_continuation():
    session, transport, fake, pending = await _voice_card_session()
    await _model_calls(session, "c1", "ask", {"person": {"user_id": "u-priya"}})
    card = transport.frames("pending_action")[-1]["pending_action_id"]

    await session._handle_live_event(LiveEvent(kind="turn_complete"))
    await session._handle_client_frame(protocol.TextFrame(type="text", text="Yes"))
    yes_turn = session.turn.turn_id
    await session._handle_live_event(LiveEvent(kind="turn_complete"))
    continuation_turn = session.turn.turn_id
    assert continuation_turn != yes_turn

    await session._handle_live_event(
        LiveEvent(
            kind="tool_call",
            function_calls=[
                {
                    "id": "c2",
                    "name": "confirm_pending_action",
                    "args": {"pending_action_id": card},
                }
            ],
        )
    )
    assert _responses(fake, "confirm_pending_action")[-1]["status"] == "card_not_shown"
    await session._handle_live_event(LiveEvent(kind="turn_complete"))
    return session, fake, pending, card, yes_turn


@pytest.mark.parametrize("newer_input", [False, True])
async def test_late_card_shown_after_provider_continuation_respects_the_yes_input(newer_input):
    session, fake, pending, card, yes_turn = await _refused_confirmation_in_provider_continuation()
    if newer_input:
        await session._handle_client_frame(protocol.TextFrame(type="text", text="Actually, no"))
        assert session._latest_input_turn_id != yes_turn

    await session._handle_client_frame(
        protocol.PendingShownFrame(type="pending_action.shown", pending_action_id=card)
    )
    events = [json.loads(event.removeprefix("[ONE_EVENT] ")) for event in fake.events_sent]
    assert events == ([] if newer_input else [{"kind": "pending_shown", "pending_action_id": card}])
    assert pending.rows[card].status == "pending"


async def test_late_card_shown_keeps_its_provider_turn_alias_while_the_card_is_open():
    session, fake, pending, card, yes_turn = await _refused_confirmation_in_provider_continuation()
    # A long session may rotate its bounded turn map before the card appears.
    # The refused confirmation still belongs to the same yes input.
    for index in range(520):
        session._bind_turn_to_input(f"later-provider-{index}", yes_turn)

    await session._handle_client_frame(
        protocol.PendingShownFrame(type="pending_action.shown", pending_action_id=card)
    )
    assert [json.loads(event.removeprefix("[ONE_EVENT] ")) for event in fake.events_sent] == [
        {"kind": "pending_shown", "pending_action_id": card}
    ]
    assert pending.rows[card].status == "pending"


async def test_tap_on_a_reused_card_reports_to_the_turn_it_was_reshown_on():
    """The card a repeated proposal re-showed answers the newer turn: a tap on
    it must reach the model and the screen, not be fenced as the old turn's."""
    session, transport, fake, pending = await _voice_card_session()
    ask = {"person": {"user_id": "u-priya"}}
    await _model_calls(session, "c1", "ask", ask)
    card = transport.frames("pending_action")[-1]["pending_action_id"]
    await session._handle_live_event(LiveEvent(kind="turn_complete"))
    await session._handle_client_frame(protocol.TextFrame(type="text", text="Yes"))
    yes_turn = session.turn.turn_id
    await _model_calls(session, "c2", "ask", ask)
    assert _responses(fake, "ask")[-1]["status"] == "confirmation_waiting"

    await session._confirm_by_tap(
        protocol.ConfirmActionFrame(type="confirm_action", pending_action_id=card)
    )
    assert pending.rows[card].status == "executed"
    result = transport.frames("tool.result")[-1]
    assert result["pending_action_id"] == card and result["turn_id"] == yes_turn
    event = json.loads(fake.events_sent[-1].removeprefix("[ONE_EVENT] "))
    assert event["kind"] == "tool_result"


async def test_tap_tier_requires_receipt_and_rejects_spoken_yes():
    transport = FakeTransport([AUTH])
    fake = FakeLive(
        [
            LiveEvent(
                kind="tool_call",
                function_calls=[{"id": "c1", "name": "delete_thing", "args": {"thing_id": "t1"}}],
            ),
            None,
        ]
    )
    pending = MemoryPendingStore()
    session = _session(transport, fake, pending=pending)
    task = asyncio.create_task(session.run())
    await asyncio.sleep(0.3)
    card = transport.frames("pending_action")[0]
    assert card["tier"] == "tap" and card["requires_tap"] is True and card["receipt_token"]
    # spoken yes is refused
    outcome = await session.executor.call(
        session.ctx, "confirm_pending_action", {"pending_action_id": card["pending_action_id"]}
    )
    assert outcome.result.status == "tap_required"
    # wrong receipt is refused
    transport.push(
        {
            "type": "confirm_action",
            "pending_action_id": card["pending_action_id"],
            "receipt_token": "nope",
        }
    )
    await asyncio.sleep(0.1)
    resolved = transport.frames("pending_action.resolved")
    assert (
        resolved[-1]["status"] == "not_pending"
        and resolved[-1]["result_public"]["reason_code"] == "receipt_invalid"
    )
    assert pending.rows[card["pending_action_id"]].status == "pending"
    # the real receipt executes and the model receives an [ONE_EVENT]
    transport.push(
        {
            "type": "confirm_action",
            "pending_action_id": card["pending_action_id"],
            "receipt_token": card["receipt_token"],
        }
    )
    await asyncio.sleep(0.1)
    assert transport.frames("pending_action.resolved")[-1]["status"] == "executed"
    assert pending.rows[card["pending_action_id"]].status == "executed"
    result = transport.frames("tool.result")[-1]
    assert result["pending_action_id"] == card["pending_action_id"]
    assert result["turn_id"] == transport.frames("tool.started")[0]["turn_id"]
    event = json.loads(fake.events_sent[-1].removeprefix("[ONE_EVENT] "))
    assert (
        event["kind"] == "tool_result"
        and event["result"]["status"] == "deleted"
        and event["confirmation_source"] == "tap"
    )
    transport.push({"type": "end"})
    await asyncio.wait_for(task, 3)


async def test_pending_turn_owner_survives_reconnect_and_fences_later_answer():
    pending = MemoryPendingStore()
    conversations = MemoryConversationStore()
    auth = AuthResult(user_id=USER, vault_owner_token="HCT:token", firebase_id_token=None)  # noqa: S106 - synthetic authority
    first_transport, first_live = FakeTransport(), FakeLive([])
    first = _session(first_transport, first_live, pending=pending, conversations=conversations)
    await first._open_conversation(auth)
    first.live = first_live
    await first._handle_client_frame(protocol.TextFrame(type="text", text="First question"))
    first_turn = first.turn.turn_id
    await first._dispatch_tool_call(
        {"id": "call-a", "name": "delete_thing", "args": {"thing_id": "t1"}}
    )
    card = first_transport.frames("pending_action")[0]
    row = pending.rows[card["pending_action_id"]]
    assert row.origin_turn_id == first_turn
    assert "_one_voice_origin_turn_id" not in card["args"]

    second_transport, second_live = FakeTransport(), FakeLive([])
    second = _session(second_transport, second_live, pending=pending, conversations=conversations)
    await second._open_conversation(auth)
    second.live = second_live
    await second._handle_client_frame(protocol.TextFrame(type="text", text="Second question"))
    second_turn = second.turn.turn_id
    await second._dispatch_tool_call({"id": "call-b", "name": "echo", "args": {"text": "second"}})
    await second._confirm_by_tap(
        protocol.ConfirmActionFrame(
            type="confirm_action",
            pending_action_id=row.id,
            receipt_token=card["receipt_token"],
        )
    )
    assert second_transport.frames("pending_action.resolved")[-1]["status"] == "executed"
    results = second_transport.frames("tool.result")
    assert [(item["tool"], item["turn_id"]) for item in results] == [
        ("echo", second_turn),
    ]
    assert second_live.events_sent == []
    assert second_transport.frames("ui_directive") == []
    assert second_transport.frames("client_step.request") == []


async def test_model_confirmed_voice_action_retires_its_card_without_relisting():
    transport, live = FakeTransport(), FakeLive([])
    pending = MemoryPendingStore()
    session = _session(transport, live, pending=pending)
    await session._open_conversation(
        AuthResult(user_id=USER, vault_owner_token="HCT:token", firebase_id_token=None)  # noqa: S106 - synthetic authority
    )
    session.live = live
    session.ctx.entities.remember_person(
        ConfirmedPerson(user_id="u-priya", display_name="Priya", confirmed_at=now_iso())
    )
    await session._handle_client_frame(protocol.TextFrame(type="text", text="Ask Priya"))
    await session._dispatch_tool_call(
        {"id": "ask-call", "name": "ask", "args": {"person": {"user_id": "u-priya"}}}
    )
    card = transport.frames("pending_action")[0]
    await pending.mark_shown(user_id=USER, pending_action_id=card["pending_action_id"])
    await session._dispatch_tool_call(
        {
            "id": "confirm-call",
            "name": "confirm_pending_action",
            "args": {"pending_action_id": card["pending_action_id"]},
        }
    )
    assert len(transport.frames("pending_action")) == 1
    assert transport.frames("pending_action.resolved")[-1]["status"] == "executed"
    assert transport.frames("tool.result")[-1]["result_public"]["status"] == "pending"
    assert pending.rows[card["pending_action_id"]].status == "executed"
    assert session._counters["confirmations_completed"] == 1


async def test_legacy_pending_without_turn_owner_only_settles_exact_card():
    pending = MemoryPendingStore()
    row, receipt = await pending.create(
        user_id=USER,
        conversation_id=CONV,
        tool_name="delete_thing",
        gateway_action_id="location.delete_circle",
        tier="tap",
        args={"thing_id": "legacy"},
        summary="delete the thing",
    )
    transport, live = FakeTransport(), FakeLive([])
    session = _session(transport, live, pending=pending)
    await session._open_conversation(
        AuthResult(user_id=USER, vault_owner_token="HCT:token", firebase_id_token=None)  # noqa: S106 - synthetic authority
    )
    session.live = live
    await session._handle_client_frame(protocol.TextFrame(type="text", text="New question"))
    await session._confirm_by_tap(
        protocol.ConfirmActionFrame(
            type="confirm_action", pending_action_id=row.id, receipt_token=receipt
        )
    )
    assert transport.frames("pending_action.resolved")[-1]["status"] == "executed"
    assert transport.frames("tool.result") == []
    assert transport.frames("ui_directive") == []
    assert transport.frames("voice.state") == []
    assert live.events_sent == []


async def test_cancel_frame_cancels_pending_and_tells_the_model():
    transport = FakeTransport([AUTH])
    fake = FakeLive(
        [
            LiveEvent(
                kind="tool_call",
                function_calls=[{"id": "c1", "name": "delete_thing", "args": {"thing_id": "t1"}}],
            ),
            None,
        ]
    )
    pending = MemoryPendingStore()
    session = _session(transport, fake, pending=pending)
    task = asyncio.create_task(session.run())
    await asyncio.sleep(0.3)
    card = transport.frames("pending_action")[0]
    transport.push({"type": "cancel_action"})
    await asyncio.sleep(0.1)
    assert pending.rows[card["pending_action_id"]].status == "cancelled"
    assert transport.frames("pending_action.resolved")[-1]["status"] == "cancelled"
    assert json.loads(fake.events_sent[-1].removeprefix("[ONE_EVENT] "))["kind"] == "cancelled"
    transport.push({"type": "cancel_action", "scope": "session"})
    await asyncio.wait_for(task, 3)
    assert transport.closed == (protocol.CLOSE_ENDED, "ended")


async def test_client_step_result_is_verified_server_side_before_the_model_hears_it(monkeypatch):
    transport = FakeTransport([AUTH])
    fake = FakeLive(
        [
            LiveEvent(
                kind="tool_call",
                function_calls=[
                    {"id": "c1", "name": "share", "args": {"person": {"user_id": "u-priya"}}}
                ],
            ),
            None,
        ]
    )
    pending = MemoryPendingStore()
    conversations = MemoryConversationStore()
    from hushh_mcp.one_voice.conversations import Conversation

    conversations.rows[CONV] = Conversation(
        id=CONV,
        user_id=USER,
        status="active",
        entity_context={
            "people": {
                "u-priya": ConfirmedPerson(
                    user_id="u-priya",
                    display_name="Priya Nair",
                    relationship="connected",
                    has_location_key=True,
                    confirmed_at=now_iso(),
                ).model_dump(mode="json")
            }
        },
        model_id="m",
        model_location="l",
        session_count=0,
    )
    session = _session(transport, fake, pending=pending, conversations=conversations)

    class _LocationDouble:
        def list_state(self, user_id):
            return {"ownerGrants": [{"id": "g-1", "latestEnvelopeId": "env-1"}]}

    task = asyncio.create_task(session.run())
    await asyncio.sleep(0.3)
    session.ctx.services["location"] = _LocationDouble()
    card = transport.frames("pending_action")[0]
    transport.push({"type": "pending_action.shown", "pending_action_id": card["pending_action_id"]})
    await asyncio.sleep(0.05)
    await session.executor.call(
        session.ctx, "confirm_pending_action", {"pending_action_id": card["pending_action_id"]}
    )
    await session._emit_side_effects(
        __import__(
            "hushh_mcp.one_voice.tools.executor", fromlist=["ToolCallOutcome"]
        ).ToolCallOutcome(
            result=ShareResult(
                status="grant_created",
                client_step={
                    "kind": "publish_location_envelopes",
                    "purpose": "share",
                    "grant_ids": ["g-1"],
                },
            ),
            spec=TEST_TOOLS[3],
        )
    )
    step = transport.frames("client_step.request")[-1]
    assert step["kind"] == "publish_location_envelopes" and step["payload"]["grant_ids"] == ["g-1"]
    transport.push(
        {
            "type": "client_step.result",
            "step_id": step["step_id"],
            "status": "ok",
            "payload": {"published": ["g-1"]},
        }
    )
    await asyncio.sleep(0.1)
    event = json.loads(fake.events_sent[-1].removeprefix("[ONE_EVENT] "))
    assert event["kind"] == "client_step" and event["verification"] == {
        "status": "published",
        "published": ["g-1"],
        "unpublished": [],
    }
    transport.push({"type": "end"})
    await asyncio.wait_for(task, 3)


async def test_go_away_asks_the_client_to_reconnect_and_saves_the_handle():
    conversations = MemoryConversationStore()
    transport = FakeTransport([AUTH])
    fake = FakeLive(
        [
            LiveEvent(kind="resumption", resumption_handle="h-1", resumable=True),
            LiveEvent(kind="go_away", go_away_seconds=10),
        ]
    )
    await _run(_session(transport, fake, conversations=conversations))
    assert conversations.handles == ["h-1"]
    assert transport.frames("session.reconnect_required")[0]["reason"] == "go_away"
    assert transport.closed[0] == protocol.CLOSE_ENDED


async def test_provider_outage_closes_with_voice_unavailable_and_no_provider_text():
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def _boom(model, live_config):
        raise RuntimeError("1008 None. Lightning dunning decision is deny for project: projects/x")
        yield  # pragma: no cover

    transport = FakeTransport([AUTH])
    pending = MemoryPendingStore()
    session = VoiceSession(
        transport=transport,
        config=CONFIG,
        claims=CLAIMS,
        verify_auth=_ok_auth,
        live_factory=_boom,
        executor=ToolExecutor(pending_store=pending),
        conversations=MemoryConversationStore(),
        pending=pending,
    )
    await _run(session)
    assert transport.closed[0] == protocol.CLOSE_PROVIDER_UNAVAILABLE
    assert transport.frames("error")[-1] == {
        "type": "error",
        "code": "voice_unavailable",
        "message": "Voice is unavailable right now.",
    }
    assert "dunning" not in json.dumps(transport.sent)


async def test_idle_watchdog_closes_the_session():
    clock = {"t": 0.0}
    transport = FakeTransport([AUTH])
    fake = FakeLive([])
    pending = MemoryPendingStore()
    session = VoiceSession(
        transport=transport,
        config=CONFIG,
        claims=CLAIMS,
        verify_auth=_ok_auth,
        live_factory=live_factory_for(fake),
        executor=ToolExecutor(pending_store=pending),
        conversations=MemoryConversationStore(),
        pending=pending,
        clock=lambda: clock["t"],
    )
    task = asyncio.create_task(session.run())
    await asyncio.sleep(0.2)
    clock["t"] = 100.0
    await asyncio.wait_for(task, 4)
    assert transport.closed == (protocol.CLOSE_IDLE, "idle")


async def test_narration_guard_counts_a_turn_that_only_had_rejected_tool_calls():
    conversations = MemoryConversationStore()
    transport = FakeTransport([AUTH])
    fake = FakeLive(
        [
            LiveEvent(
                kind="tool_call",
                function_calls=[
                    {"id": "c1", "name": "ask", "args": {"person": {"user_id": "u-nobody"}}}
                ],
            ),
            None,
            LiveEvent(
                kind="output_transcript", text="I've sent the request to Priya.", finished=True
            ),
            LiveEvent(kind="turn_complete"),
        ]
    )
    session = _session(transport, fake, conversations=conversations)
    task = asyncio.create_task(session.run())
    await asyncio.sleep(0.3)
    transport.push({"type": "end"})
    await asyncio.wait_for(task, 3)
    assert conversations.counters["narration_without_receipt"] == 1
    # the UI never got a success: the only tool.result is a rejection
    assert all(f["ok"] is False for f in transport.frames("tool.result"))


# --- device Location updates steps -----------------------------------------


COORDINATE_WORDS = ("latitude", "longitude", '"lat"', '"lng"', "coordinates", "12.97", "77.59")


class ForbiddenService:
    """A service the device-switch path must never reach: any use is a defect."""

    def __init__(self, name: str, calls: list[tuple[str, str]]) -> None:
        self.name = name
        self.calls = calls

    def __getattr__(self, attr: str):
        self.calls.append((self.name, attr))
        raise AssertionError(f"{self.name}.{attr} must not be called by the device switch path")


def _device_session(transport, fake_live, *, conversations=None, clock=None):
    """A session whose location services raise if touched. The services are
    injected the moment the provider opens, before any scripted tool call."""
    calls: list[tuple[str, str]] = []
    inner = live_factory_for(fake_live)

    @asynccontextmanager
    async def _factory(model, live_config):
        session.ctx.services["location_settings"] = ForbiddenService("location_settings", calls)
        session.ctx.services["location"] = ForbiddenService("location", calls)
        async with inner(model, live_config) as live:
            yield live

    pending = MemoryPendingStore()
    kwargs = {"clock": clock} if clock is not None else {}
    session = VoiceSession(
        transport=transport,
        config=CONFIG,
        claims=CLAIMS,
        verify_auth=_ok_auth,
        live_factory=_factory,
        executor=ToolExecutor(pending_store=pending),
        conversations=conversations or MemoryConversationStore(),
        pending=pending,
        **kwargs,
    )
    return session, calls


def _device_call(call_id: str, name: str) -> LiveEvent:
    return LiveEvent(kind="tool_call", function_calls=[{"id": call_id, "name": name, "args": {}}])


def _report(step: dict, outcome: str, observed: str, **extra) -> dict:
    payload = {
        "gateway_action_id": step["payload"]["gateway_action_id"],
        "desired_state": step["payload"]["desired_state"],
        "outcome": outcome,
        "observed_state": observed,
        "navigated": True,
    }
    payload.update(extra)
    return payload


def _step_result(step_id: str, status: str, payload: dict) -> dict:
    return {"type": "client_step.result", "step_id": step_id, "status": status, "payload": payload}


def _last_event(fake: FakeLive) -> dict:
    return json.loads(fake.events_sent[-1].removeprefix("[ONE_EVENT] "))


async def _start_device_session(script, *, conversations=None, clock=None):
    transport = FakeTransport([AUTH])
    fake = FakeLive(script)
    session, calls = _device_session(transport, fake, conversations=conversations, clock=clock)
    task = asyncio.create_task(session.run())
    await asyncio.sleep(0.3)
    return transport, fake, session, calls, task


async def _finish(transport, task):
    transport.push({"type": "end"})
    await asyncio.wait_for(task, 3)


async def test_device_tool_pending_is_not_ok_and_requests_the_client_step_first():
    conversations = MemoryConversationStore()
    transport, fake, session, calls, task = await _start_device_session(
        [_device_call("c1", RESUME), None], conversations=conversations
    )

    assert transport.frames("tool.started")[0]["tool"] == RESUME
    step = transport.frames("client_step.request")[0]
    assert step["kind"] == "set_location_updates"
    assert step["timeout_s"] == 45
    assert step["payload"] == {
        "desired_state": "on",
        "gateway_action_id": "location.resume_updates",
        "timeout_s": 45,
    }
    result = transport.frames("tool.result")[0]
    assert result["call_id"] == "c1" and result["tool"] == RESUME
    assert result["ok"] is False
    assert result["status"] == "location_updates_pending"
    assert result["result_public"]["needs"] == "client_step"
    # The device is asked before the model or the UI hears "pending".
    assert transport.sent.index(step) < transport.sent.index(result)
    assert "complete" not in [f["state"] for f in transport.frames("state")]
    assert session.turn.ok_results == 0 and session.turn.not_ok_results == 1
    assert session._counters.get("tool_results_ok", 0) == 0
    assert session._counters.get("tool_results_rejected", 0) == 0
    assert fake.tool_responses[0]["id"] == "c1"
    assert fake.tool_responses[0]["response"]["status"] == "location_updates_pending"
    record = session.client_steps[step["step_id"]]
    assert record["tool"] == RESUME and record["call_id"] == "c1"
    assert record["spec"] is DEVICE_TOOLS[0]
    assert record["expires_at"] == pytest.approx(record["requested_at"] + 45 + 5)
    assert calls == []

    await _finish(transport, task)
    assert conversations.counters.get("tool_results_ok", 0) == 0
    assert conversations.counters.get("tool_results_rejected", 0) == 0
    assert conversations.counters["tool_calls"] == 1


async def test_device_step_settles_on_as_the_originating_call_and_narrates_only_the_fact():
    conversations = MemoryConversationStore()
    transport, fake, session, calls, task = await _start_device_session(
        [_device_call("c1", RESUME), None], conversations=conversations
    )
    step = transport.frames("client_step.request")[0]
    events_before = len(fake.events_sent)

    transport.push(_step_result(step["step_id"], "ok", _report(step, "on", "on")))
    await asyncio.sleep(0.1)

    results = transport.frames("tool.result")
    assert [r["status"] for r in results] == ["location_updates_pending", "on"]
    settled = results[-1]
    assert settled["call_id"] == "c1" and settled["tool"] == RESUME
    assert settled["ok"] is True
    assert settled["result_public"]["spoken_facts"] == ["Location is on."]
    assert settled["result_public"]["observed_state"] == "on"
    assert settled["result_public"]["changed"] is True
    assert len(fake.events_sent) == events_before + 1
    event = _last_event(fake)
    assert event["kind"] == "tool_result" and event["tool"] == RESUME
    assert event["confirmation_source"] == "device"
    assert event["result"]["status"] == "on"
    assert "payload" not in event and "verification" not in event
    wire = json.dumps(fake.events_sent) + json.dumps(transport.sent)
    assert not any(word in wire for word in COORDINATE_WORDS)
    assert [f["state"] for f in transport.frames("state")][-1] == "complete"
    assert session._counters["tool_results_ok"] == 1
    assert session._counters.get("tool_results_rejected", 0) == 0
    assert session.turn.ok_results == 1
    assert session.client_steps == {}
    assert transport.frames("error") == []
    assert calls == []

    await _finish(transport, task)
    assert conversations.counters["tool_results_ok"] == 1
    assert conversations.counters.get("tool_results_rejected", 0) == 0


@pytest.mark.parametrize(
    ("label", "status", "build", "reason_code"),
    [
        (
            "tampered_gateway_id",
            "ok",
            lambda s: _report(s, "on", "on", gateway_action_id="location.set_sharing_enabled"),
            "inconsistent_step_payload",
        ),
        ("failed_plus_on", "failed", lambda s: _report(s, "on", "on"), "inconsistent_step_payload"),
        (
            "observed_differs_from_desired",
            "ok",
            lambda s: _report(s, "on", "off"),
            "inconsistent_step_payload",
        ),
        (
            "coordinates_in_payload",
            "ok",
            lambda s: _report(s, "on", "on", latitude=12.97, longitude=77.59),
            "invalid_step_payload",
        ),
        (
            "provider_no_handler",
            "failed",
            lambda s: {"reason": "no_handler"},
            "handler_unavailable",
        ),
        ("provider_timed_out", "failed", lambda s: {"reason": "timed_out"}, "timed_out"),
    ],
)
async def test_device_step_rejections_settle_not_ok_and_return_to_listening(
    label, status, build, reason_code
):
    conversations = MemoryConversationStore()
    transport, fake, session, calls, task = await _start_device_session(
        [_device_call("c1", RESUME), None], conversations=conversations
    )
    step = transport.frames("client_step.request")[0]

    transport.push(_step_result(step["step_id"], status, build(step)))
    await asyncio.sleep(0.1)

    settled = transport.frames("tool.result")[-1]
    assert settled["call_id"] == "c1" and settled["tool"] == RESUME
    assert settled["ok"] is False
    assert settled["status"] == "rejected"
    assert settled["result_public"]["reason_code"] == reason_code
    assert settled["result_public"]["spoken_facts"] != ["Location is on."]
    assert [f["state"] for f in transport.frames("state")][-1] == "listening"
    event = _last_event(fake)
    assert event["kind"] == "tool_result" and event["result"]["reason_code"] == reason_code
    wire = json.dumps(fake.events_sent) + json.dumps(transport.sent)
    assert not any(word in wire for word in COORDINATE_WORDS)
    assert session._counters.get("tool_results_ok", 0) == 0
    assert session._counters["tool_results_rejected"] == 1
    assert session.turn.ok_results == 0
    assert session.client_steps == {}
    assert calls == []

    await _finish(transport, task)
    assert conversations.counters.get("tool_results_ok", 0) == 0
    assert conversations.counters["tool_results_rejected"] == 1


async def test_device_step_report_after_the_deadline_is_step_expired():
    clock = {"t": 1_000.0}
    transport, fake, session, calls, task = await _start_device_session(
        [_device_call("c1", PAUSE), None], clock=lambda: clock["t"]
    )
    step = transport.frames("client_step.request")[0]
    record = session.client_steps[step["step_id"]]
    assert record["expires_at"] == 1_000.0 + 45 + 5

    clock["t"] = record["expires_at"] + 0.5
    transport.push(_step_result(step["step_id"], "ok", _report(step, "off", "off")))
    await asyncio.sleep(0.1)

    settled = transport.frames("tool.result")[-1]
    assert settled["call_id"] == "c1" and settled["ok"] is False
    assert settled["status"] == "rejected"
    assert settled["result_public"]["reason_code"] == "step_expired"
    assert settled["result_public"]["spoken_facts"] != ["Location is off."]
    assert [f["state"] for f in transport.frames("state")][-1] == "listening"
    assert session.client_steps == {}
    assert calls == []
    await _finish(transport, task)


async def test_duplicate_device_step_report_settles_once_then_is_unknown():
    transport, fake, session, calls, task = await _start_device_session(
        [_device_call("c1", RESUME), None]
    )
    step = transport.frames("client_step.request")[0]
    report = _step_result(step["step_id"], "ok", _report(step, "on", "on"))

    transport.push(report)
    await asyncio.sleep(0.05)
    transport.push(report)
    await asyncio.sleep(0.1)

    settled = [
        r for r in transport.frames("tool.result") if r["status"] != "location_updates_pending"
    ]
    assert len(settled) == 1 and settled[0]["status"] == "on" and settled[0]["call_id"] == "c1"
    assert settled[0]["turn_id"] == transport.frames("tool.started")[0]["turn_id"]
    errors = transport.frames("error")
    assert len(errors) == 1 and errors[0]["message"] == "unknown_client_step"
    assert session._counters["tool_results_ok"] == 1
    assert sum('"kind":"tool_result"' in e for e in fake.events_sent) == 1
    assert calls == []
    await _finish(transport, task)


async def test_device_step_from_another_session_is_unknown_here():
    transport_a, fake_a, session_a, calls_a, task_a = await _start_device_session(
        [_device_call("c1", RESUME), None]
    )
    transport_b, fake_b, session_b, calls_b, task_b = await _start_device_session(
        [_device_call("c9", RESUME), None]
    )
    foreign = transport_b.frames("client_step.request")[0]
    own = transport_a.frames("client_step.request")[0]
    assert foreign["step_id"] != own["step_id"]

    transport_a.push(_step_result(foreign["step_id"], "ok", _report(foreign, "on", "on")))
    await asyncio.sleep(0.1)

    assert [f["message"] for f in transport_a.frames("error")] == ["unknown_client_step"]
    assert [r["status"] for r in transport_a.frames("tool.result")] == ["location_updates_pending"]
    assert set(session_a.client_steps) == {own["step_id"]}
    # The other session's step is untouched and still settles for its own call.
    assert set(session_b.client_steps) == {foreign["step_id"]}
    assert transport_b.frames("error") == []
    transport_b.push(_step_result(foreign["step_id"], "ok", _report(foreign, "on", "on")))
    await asyncio.sleep(0.1)
    assert transport_b.frames("tool.result")[-1]["call_id"] == "c9"
    assert transport_b.frames("tool.result")[-1]["status"] == "on"
    assert session_a._counters.get("tool_results_ok", 0) == 0
    assert calls_a == [] and calls_b == []
    await _finish(transport_a, task_a)
    await _finish(transport_b, task_b)


async def test_two_device_steps_settle_independently_on_their_own_call_ids():
    transport, fake, session, calls, task = await _start_device_session(
        [_device_call("c1", RESUME), None, _device_call("c2", PAUSE), None]
    )
    steps = transport.frames("client_step.request")
    assert [s["payload"]["desired_state"] for s in steps] == ["on", "off"]
    on_step, off_step = steps
    assert set(session.client_steps) == {on_step["step_id"], off_step["step_id"]}
    assert [r["call_id"] for r in transport.frames("tool.result")] == ["c1", "c2"]

    # Reports arrive in the opposite order to the requests: each settles its own call.
    transport.push(_step_result(off_step["step_id"], "ok", _report(off_step, "off", "off")))
    await asyncio.sleep(0.05)
    transport.push(_step_result(on_step["step_id"], "ok", _report(on_step, "on", "on")))
    await asyncio.sleep(0.1)

    settled = [
        r for r in transport.frames("tool.result") if r["status"] != "location_updates_pending"
    ]
    assert [(r["call_id"], r["tool"], r["status"], r["ok"]) for r in settled] == [
        ("c2", PAUSE, "off", True),
        ("c1", RESUME, "on", True),
    ]
    assert [r["result_public"]["spoken_facts"] for r in settled] == [
        ["Location is off."],
        ["Location is on."],
    ]
    events = [json.loads(e.removeprefix("[ONE_EVENT] ")) for e in fake.events_sent]
    assert [(e["tool"], e["result"]["status"]) for e in events if e["kind"] == "tool_result"] == [
        (PAUSE, "off"),
        (RESUME, "on"),
    ]
    assert session.client_steps == {}
    assert session._counters["tool_results_ok"] == 2
    assert session._counters.get("tool_results_rejected", 0) == 0
    assert transport.frames("error") == []
    assert calls == []
    await _finish(transport, task)


async def test_device_tools_are_declared_to_the_provider_from_one_home():
    from hushh_mcp.one_voice.conversations import Conversation

    conversations = MemoryConversationStore()
    conversations.rows[CONV] = Conversation(
        id=CONV,
        user_id=USER,
        status="active",
        screen_context={"screen_id": "one_home", "route": "/one"},
        model_id="m",
        model_location="l",
        session_count=0,
    )
    transport = FakeTransport([AUTH, {"type": "end"}])
    fake = FakeLive([LiveEvent(kind="setup_complete")])
    session = _session(transport, fake, conversations=conversations)
    await _run(session)

    assert session.ctx.screen.screen_id == "one_home"
    declared = {item["name"]: item for item in fake.live_config["tool_declarations"]}
    for spec in DEVICE_TOOLS:
        assert declared[spec.name] == spec.declaration()
    assert "one_home" in fake.live_config["system_instruction"]
    assert RESUME in fake.live_config["system_instruction"]


# --- app_context: the circle on screen is a typed hint, never prompt text ------


FAMILY_ID = "11111111-1111-4111-8111-111111111111"


async def test_app_context_carries_the_active_circle_id_as_a_typed_field():
    conversations = MemoryConversationStore()
    transport = FakeTransport([AUTH])
    fake = FakeLive([LiveEvent(kind="setup_complete")])
    session = _session(transport, fake, conversations=conversations)
    task = asyncio.create_task(session.run())
    await asyncio.sleep(0.2)
    transport.push(
        {
            "type": "app_context",
            "screen_id": "one_location_circle",
            "route": "/one/location",
            "screen_state": {"member_count": 4},
            "active_circle_id": FAMILY_ID,
        }
    )
    await asyncio.sleep(0.2)
    assert session.ctx.screen.active_circle_id == FAMILY_ID
    assert session.ctx.screen.screen_id == "one_location_circle"
    # Persisted with the screen context so a resumed conversation keeps it.
    assert conversations.rows[CONV].screen_context["active_circle_id"] == FAMILY_ID
    # Not smuggled into screen_state, which is rendered into the prompt.
    assert "active_circle_id" not in session.ctx.screen.screen_state
    # A screen without a circle clears the hint rather than keeping a stale one.
    transport.push({"type": "app_context", "screen_id": "one_home", "route": "/one"})
    await asyncio.sleep(0.2)
    assert session.ctx.screen.active_circle_id is None
    await _finish(transport, task)


async def test_app_context_rejects_a_malformed_active_circle_id():
    transport = FakeTransport([AUTH])
    fake = FakeLive([LiveEvent(kind="setup_complete")])
    session = _session(transport, fake)
    task = asyncio.create_task(session.run())
    await asyncio.sleep(0.2)
    transport.push(
        {"type": "app_context", "screen_id": "one_location_circle", "active_circle_id": "family"}
    )
    await asyncio.sleep(0.2)
    assert session.ctx.screen.active_circle_id is None
    assert transport.frames("error"), "a malformed frame is refused, not silently accepted"
    await _finish(transport, task)


# --- tap confirmation proves the actor before the row is confirmed -------------


async def test_tap_on_a_firebase_plane_card_verifies_the_proof_before_confirming():
    from hushh_mcp.one_voice.tools.base import PersonRef as _PersonRef

    class InviteInput(ToolInput):
        person: _PersonRef

    class InviteResult(ToolResult):
        status: Literal["sent"]

    async def invite(ctx, args):
        return InviteResult(status="sent", spoken_facts=["sent"])

    spec = ToolSpec(
        name="invite_thing",
        gateway_action_id="people.profile.connect",
        policy=ToolPolicy.confirm_voice,
        input_model=InviteInput,
        output_model=InviteResult,
        description="Invite.",
        handler=invite,
        person_args=("person",),
        firebase_plane=True,
        summarize=lambda ctx, a: "send a connection request",
    )
    by_name = {t.name: t for t in (*TEST_TOOLS, spec)}
    import pytest as _pytest

    mp = _pytest.MonkeyPatch()
    mp.setattr(registry, "get_tool", lambda name: by_name.get(str(name or "")))
    proofs: list[tuple[str | None, str]] = []

    async def prove(token, expected_user_id):
        proofs.append((token, expected_user_id))
        return {"fresh": "ok", "stale": "invalid", "other": "mismatch"}.get(
            str(token or ""), "missing"
        )

    try:
        pending = MemoryPendingStore()
        transport = FakeTransport([AUTH])
        fake = FakeLive([LiveEvent(kind="setup_complete")])
        session = VoiceSession(
            transport=transport,
            config=CONFIG,
            claims=CLAIMS,
            verify_auth=_ok_auth,
            live_factory=live_factory_for(fake),
            executor=ToolExecutor(pending_store=pending, actor_proof=prove),
            conversations=MemoryConversationStore(),
            pending=pending,
        )
        task = asyncio.create_task(session.run())
        await asyncio.sleep(0.2)
        session.ctx.entities.remember_person(
            ConfirmedPerson(user_id="u-priya", display_name="Priya", confirmed_at=now_iso())
        )
        outcome = await session.executor.call(
            session.ctx,
            "invite_thing",
            {"person": {"user_id": "u-priya"}},
            origin_turn_id=session.turn.turn_id,
        )
        row_id = outcome.pending.id

        for token, code in (
            (None, "firebase_proof_required"),
            ("stale", "firebase_proof_invalid"),
            ("other", "firebase_proof_invalid"),
        ):
            transport.push(
                {"type": "confirm_action", "pending_action_id": row_id, "firebase_id_token": token}
            )
            await asyncio.sleep(0.15)
            errors = transport.frames("error")
            assert errors and errors[-1]["code"] == code, (token, errors)
            assert (await pending.get(user_id=USER, pending_action_id=row_id)).status == "pending"
        assert [p[1] for p in proofs] == [USER, USER, USER]

        transport.push(
            {"type": "confirm_action", "pending_action_id": row_id, "firebase_id_token": "fresh"}
        )
        await asyncio.sleep(0.2)
        assert (await pending.get(user_id=USER, pending_action_id=row_id)).status == "executed"
        resolved = [
            f for f in transport.frames("pending_action.resolved") if f["status"] == "executed"
        ]
        assert resolved and resolved[-1]["pending_action_id"] == row_id
        assert session.ctx.firebase_id_token == "fresh"  # noqa: S105
        await _finish(transport, task)
    finally:
        mp.undo()


# --- a scope-bearing accept: the review screen opens; the re-read decides ------


async def _review_session(connections, proof_token="fresh"):  # noqa: S107 - test double, not a credential
    """A session whose people plane is the given double and whose accept tool
    is the real one, with a proof that always verifies."""
    from hushh_mcp.one_voice.tools import people
    from tests.one_voice.test_tools_people import LocationDouble

    by_name = {t.name: t for t in (*TEST_TOOLS, *people.TOOLS)}
    import pytest as _pytest

    mp = _pytest.MonkeyPatch()
    mp.setattr(registry, "get_tool", lambda name: by_name.get(str(name or "")))

    async def prove(token, expected_user_id):
        return "ok"

    pending = MemoryPendingStore()
    transport = FakeTransport([AUTH])
    fake = FakeLive([LiveEvent(kind="setup_complete")])
    session = VoiceSession(
        transport=transport,
        config=CONFIG,
        claims=CLAIMS,
        verify_auth=_ok_auth,
        live_factory=live_factory_for(fake),
        executor=ToolExecutor(pending_store=pending, actor_proof=prove),
        conversations=MemoryConversationStore(),
        pending=pending,
    )
    task = asyncio.create_task(session.run())
    await asyncio.sleep(0.2)
    session.ctx.services["connections"] = connections
    session.ctx.services["location"] = LocationDouble()
    session.ctx.firebase_id_token = proof_token
    return session, transport, fake, pending, task, mp


async def test_scope_review_opens_the_screen_and_settles_from_a_re_read():
    from hushh_mcp.services.connections_service import ConnectionsError
    from tests.one_voice.test_tools_people import RAHUL, REQ_IN, ConnectionsDouble

    connections = ConnectionsDouble()
    connections.accept_error = ConnectionsError(
        "CONNECTION_SCOPE_SELECTION_REQUIRED", "Review the scopes first.", status_code=409
    )
    session, transport, fake, pending, task, mp = await _review_session(connections)
    try:
        # Confirm the accept by tap (the proof verifies) -> the tool returns the review step.
        await session.executor.call(session.ctx, "list_people", {})
        outcome = await session.executor.call(
            session.ctx,
            "accept_connection_request",
            {"request_id": REQ_IN},
            origin_turn_id=session.turn.turn_id,
        )
        transport.push(
            {
                "type": "confirm_action",
                "pending_action_id": outcome.pending.id,
                "firebase_id_token": "fresh",
            }
        )
        await asyncio.sleep(0.3)
        results = transport.frames("tool.result")
        interim = results[-1]
        assert interim["status"] == "scope_review_required" and interim["ok"] is False
        resolved = transport.frames("pending_action.resolved")[-1]
        # The confirmed action ran (the card settles) but nothing was accepted.
        assert resolved["status"] == "executed"
        assert resolved["result_public"]["status"] == "scope_review_required"
        steps = transport.frames("client_step.request")
        assert steps and steps[-1]["kind"] == "open_request_review"
        assert steps[-1]["payload"]["request_id"] == REQ_IN
        assert steps[-1]["payload"]["user_id"] == RAHUL
        assert "accept_request" in [
            c[0] for c in connections.calls
        ]  # the refusal came from the service
        assert session._counters.get("tool_results_ok", 0) == 0
        assert session._counters.get("tool_results_rejected", 0) == 0

        # The person accepted on the screen: the graph now has the connection.
        connections.incoming = [dict(connections.incoming[0], status="accepted")]
        connections.connections.append(
            {
                "connectionId": "conn-rahul",
                "userId": RAHUL,
                "publicPersonRef": "ppr-rahul",
                "displayName": "Rahul Verma",
                "photoUrl": None,
                "email": None,
                "createdAt": "2026-01-06T00:00:00+00:00",
                "isRia": False,
                "connectedFromContacts": False,
            }
        )
        transport.push(
            {
                "type": "client_step.result",
                "step_id": steps[-1]["step_id"],
                "status": "ok",
                "payload": {"outcome": "handled"},
            }
        )
        await asyncio.sleep(0.3)
        settled = transport.frames("tool.result")[-1]
        assert settled["tool"] == "accept_connection_request"
        assert settled["status"] == "accepted" and settled["ok"] is True
        assert settled["result_public"]["spoken_facts"] == [
            "You're now connected with Rahul Verma."
        ]
        assert settled["result_public"]["review_reported"] == "ok"
        assert "connections" in settled["result_public"]["ui_refresh"]
        assert session.ctx.entities.person(RAHUL).relationship == "connected"
        events = [json.loads(e.removeprefix("[ONE_EVENT] ")) for e in fake.events_sent]
        assert any(
            e.get("kind") == "tool_result" and e.get("result", {}).get("status") == "accepted"
            for e in events
        )
        assert session._counters.get("tool_results_ok", 0) == 1
        await _finish(transport, task)
    finally:
        mp.undo()


async def test_scope_review_closed_without_a_decision_stays_pending():
    from hushh_mcp.services.connections_service import ConnectionsError
    from tests.one_voice.test_tools_people import REQ_IN, ConnectionsDouble

    connections = ConnectionsDouble()
    connections.accept_error = ConnectionsError(
        "CONNECTION_SCOPE_SELECTION_REQUIRED", "Review the scopes first.", status_code=409
    )
    session, transport, fake, pending, task, mp = await _review_session(connections)
    try:
        await session.executor.call(session.ctx, "list_people", {})
        outcome = await session.executor.call(
            session.ctx,
            "accept_connection_request",
            {"request_id": REQ_IN},
            origin_turn_id=session.turn.turn_id,
        )
        transport.push(
            {
                "type": "confirm_action",
                "pending_action_id": outcome.pending.id,
                "firebase_id_token": "fresh",
            }
        )
        await asyncio.sleep(0.3)
        step = transport.frames("client_step.request")[-1]
        # The client says the screen was left (or the step timed out): the
        # claim does not decide; the re-read finds the request still pending.
        transport.push(
            {
                "type": "client_step.result",
                "step_id": step["step_id"],
                "status": "failed",
                "payload": {"reason": "no_handler"},
            }
        )
        await asyncio.sleep(0.3)
        settled = transport.frames("tool.result")[-1]
        assert settled["status"] == "still_pending" and settled["ok"] is False
        assert settled["result_public"]["spoken_facts"] == [
            "Rahul Verma's request is still waiting for you."
        ]
        assert session._counters.get("tool_results_ok", 0) == 0
        await _finish(transport, task)
    finally:
        mp.undo()


async def _model_calls(session, call_id: str, name: str, args: dict) -> None:
    """The model asked for a tool: run it through the session's own dispatch."""
    await session._dispatch_tool_call({"id": call_id, "name": name, "args": args})


@pytest.mark.parametrize(
    ("row_status", "expected_status", "fact"),
    [
        ("rejected", "declined", "You declined Rahul Verma's request."),
        ("cancelled", "withdrawn", "Rahul Verma's request is no longer open; it was cancelled."),
        ("expired", "withdrawn", "Rahul Verma's request is no longer open; it was expired."),
    ],
)
async def test_scope_review_settles_a_no_decision_as_a_real_outcome(
    row_status, expected_status, fact
):
    from hushh_mcp.services.connections_service import ConnectionsError
    from tests.one_voice.test_tools_people import RAHUL, REQ_IN, ConnectionsDouble

    connections = ConnectionsDouble()
    connections.accept_error = ConnectionsError(
        "CONNECTION_SCOPE_SELECTION_REQUIRED", "Review the scopes first.", status_code=409
    )
    session, transport, fake, pending, task, mp = await _review_session(connections)
    try:
        await session.executor.call(session.ctx, "list_people", {})
        outcome = await session.executor.call(
            session.ctx,
            "accept_connection_request",
            {"request_id": REQ_IN},
            origin_turn_id=session.turn.turn_id,
        )
        transport.push(
            {
                "type": "confirm_action",
                "pending_action_id": outcome.pending.id,
                "firebase_id_token": "fresh",
            }
        )
        await asyncio.sleep(0.3)
        step = transport.frames("client_step.request")[-1]
        # Already connected with Rahul (a scoped re-request): the row still decides.
        connections.connections.append(
            {
                "connectionId": "conn-rahul",
                "userId": RAHUL,
                "publicPersonRef": "ppr-rahul",
                "displayName": "Rahul Verma",
                "photoUrl": None,
                "email": None,
                "createdAt": "2026-01-06T00:00:00+00:00",
                "isRia": False,
                "connectedFromContacts": False,
            }
        )
        connections.incoming = [dict(connections.incoming[0], status=row_status)]
        transport.push(_step_result(step["step_id"], "ok", {"outcome": "handled"}))
        await asyncio.sleep(0.3)
        settled = transport.frames("tool.result")[-1]
        assert settled["status"] == expected_status and settled["ok"] is True
        assert settled["result_public"]["spoken_facts"] == [fact]
        assert settled["result_public"]["connection"] is True
        assert session._counters.get("tool_results_ok", 0) == 1
        await _finish(transport, task)
    finally:
        mp.undo()


async def test_scope_review_with_the_request_gone_and_nobody_connected_is_unverified():
    from hushh_mcp.services.connections_service import ConnectionsError
    from tests.one_voice.test_tools_people import REQ_IN, ConnectionsDouble

    connections = ConnectionsDouble()
    connections.accept_error = ConnectionsError(
        "CONNECTION_SCOPE_SELECTION_REQUIRED", "Review the scopes first.", status_code=409
    )
    session, transport, fake, pending, task, mp = await _review_session(connections)
    try:
        await session.executor.call(session.ctx, "list_people", {})
        outcome = await session.executor.call(
            session.ctx,
            "accept_connection_request",
            {"request_id": REQ_IN},
            origin_turn_id=session.turn.turn_id,
        )
        transport.push(
            {
                "type": "confirm_action",
                "pending_action_id": outcome.pending.id,
                "firebase_id_token": "fresh",
            }
        )
        await asyncio.sleep(0.3)
        step = transport.frames("client_step.request")[-1]
        connections.incoming = []
        transport.push(_step_result(step["step_id"], "ok", {"outcome": "handled"}))
        await asyncio.sleep(0.3)
        settled = transport.frames("tool.result")[-1]
        assert settled["status"] == "review_unverified" and settled["ok"] is False
        assert (
            "couldn't find Rahul Verma's request anymore"
            in settled["result_public"]["spoken_facts"][0]
        )
        await _finish(transport, task)
    finally:
        mp.undo()


# --- a new lookup supersedes every open card, and says so --------------------


async def test_a_new_lookup_cancels_the_open_card_and_tells_the_client():
    from tests.one_voice.test_tools_people import REQ_IN, ConnectionsDouble

    connections = ConnectionsDouble()
    session, transport, fake, pending, task, mp = await _review_session(connections)
    try:
        await session.executor.call(session.ctx, "list_people", {})
        # An accept card (no typed person argument) is open and shown...
        outcome = await session.executor.call(
            session.ctx,
            "accept_connection_request",
            {"request_id": REQ_IN},
            origin_turn_id=session.turn.turn_id,
        )
        card = outcome.pending.id
        await pending.mark_shown(user_id=USER, pending_action_id=card)
        # ...and the person corrects course: the model looks somebody else up.
        await _model_calls(
            session, "c9", "resolve_person", {"spoken_name": "Preeti", "pool": "directory"}
        )
        cancelled = [
            f for f in transport.frames("pending_action.resolved") if f["status"] == "cancelled"
        ]
        assert cancelled and cancelled[-1]["pending_action_id"] == card
        assert (await pending.get(user_id=USER, pending_action_id=card)).status == "cancelled"
        result = [f for f in transport.frames("tool.result") if f["tool"] == "resolve_person"][-1]
        assert result["result_public"]["superseded_pending_action_ids"] == [card]
        # A spoken yes for the old card no longer does anything.
        gone = await session.executor.call(
            session.ctx, "confirm_pending_action", {"pending_action_id": card}
        )
        assert gone.result.status == "not_pending"
        assert not [c for c in connections.calls if c[0] == "accept_request"]
        await _finish(transport, task)
    finally:
        mp.undo()


async def test_spoken_yes_on_a_tap_tier_card_keeps_the_card_and_its_receipt():
    from tests.one_voice.test_tools_people import AYESHA, ConnectionsDouble

    connections = ConnectionsDouble()
    session, transport, fake, pending, task, mp = await _review_session(
        connections, proof_token=None
    )
    try:
        session.ctx.entities.remember_person(
            ConfirmedPerson(
                user_id=AYESHA,
                display_name="Ayesha Sharma",
                relationship="connected",
                confirmed_at=now_iso(),
            )
        )
        await _model_calls(session, "c1", "remove_connection", {"person": {"user_id": AYESHA}})
        cards = transport.frames("pending_action")
        assert len(cards) == 1 and cards[0]["receipt_token"]
        card = cards[0]["pending_action_id"]
        await pending.mark_shown(user_id=USER, pending_action_id=card)
        # The person says yes instead of tapping, and the session holds no proof.
        await _model_calls(session, "c2", "confirm_pending_action", {"pending_action_id": card})
        result = [
            f for f in transport.frames("tool.result") if f["tool"] == "confirm_pending_action"
        ][-1]
        # tap_required, and no second card frame that would drop the receipt.
        assert result["status"] == "tap_required"
        assert len(transport.frames("pending_action")) == 1
        assert (await pending.get(user_id=USER, pending_action_id=card)).status == "pending"
        # The tap with the receipt and a fresh proof completes it.
        transport.push(
            {
                "type": "confirm_action",
                "pending_action_id": card,
                "receipt_token": cards[0]["receipt_token"],
                "firebase_id_token": "fresh",
            }
        )
        await asyncio.sleep(0.5)
        assert (await pending.get(user_id=USER, pending_action_id=card)).status == "executed"
        await _finish(transport, task)
    finally:
        mp.undo()


def test_a_stored_context_written_by_a_newer_server_keeps_what_it_can():
    """A rollback must not cost the person their confirmed people.

    Both context models forbid unknown keys, which is the right contract for the
    model and the wrong behaviour for a stored row: an older server reading a
    field a newer one wrote would fail validation for the whole row, and the
    fallback is an empty context. Every confirmed person and circle in every live
    conversation would disappear, silently, because of one unrecognised key.
    """
    person = ConfirmedPerson(
        user_id="u-priya",
        display_name="Priya Nair",
        relationship="connected",
        confirmed_at=now_iso(),
    ).model_dump(mode="json")

    restored = restore_context(
        EntityContext,
        {"people": {"u-priya": person}, "a_field_from_a_later_version": {"x": 1}},
    )

    assert "u-priya" in restored.people
    assert restored.people["u-priya"].display_name == "Priya Nair"
    assert not hasattr(restored, "a_field_from_a_later_version")


def test_spelled_name_words_survive_a_reconnect_and_an_older_row_still_restores():
    """A spelled word must outlive the session it was said in (a cancel, a
    reconnect), and the key must never cost an older or damaged row its people."""
    entities = EntityContext()
    now = entities._now().timestamp()
    entities.remember_spelled_words(["HUSSH", "hussh", "V04"], now)
    stored = entities.model_dump(mode="json")

    restored = restore_context(EntityContext, stored)
    assert restored.retained_spelled_words(now) == ["HUSSH", "V04"]

    person = ConfirmedPerson(
        user_id="u-priya", display_name="Priya Nair", confirmed_at=now_iso()
    ).model_dump(mode="json")
    older = restore_context(EntityContext, {"people": {"u-priya": person}})
    assert "u-priya" in older.people and older.spelled_name_words == []

    damaged = restore_context(
        EntityContext,
        {
            "people": {"u-priya": person},
            "spelled_name_words": [
                {"word": "HUSSH", "at": now},
                {"word": "h u s s h", "at": now},
                {"word": "V04"},
                "HUSSH",
            ],
        },
    )
    assert "u-priya" in damaged.people
    assert damaged.retained_spelled_words(now) == ["HUSSH"]


def test_a_genuinely_corrupt_stored_context_is_dropped_and_never_trusted():
    """Tolerating unknown keys must not become tolerating bad values."""
    assert restore_context(EntityContext, {"people": "not-a-mapping"}).people == {}
    assert restore_context(EntityContext, "not-a-dict-at-all").people == {}
    assert restore_context(EntityContext, None).people == {}


# --- a storage outage never ends a healthy session ----------------------------
#
# Each test below ends the session with the client's own `end` frame and asserts
# it closed (1000, "ended"). Before the storage guards, every one of these
# failures escaped the pump TaskGroup and closed the socket with 4013.


class FailingPendingStore(MemoryPendingStore):
    """The memory store, with the named methods unreachable."""

    def __init__(self, *failing: str) -> None:
        super().__init__()
        self.failing = set(failing)

    def _check(self, name: str) -> None:
        if name in self.failing:
            raise PendingActionStorageError(f"{name} unavailable")

    async def mark_shown(self, **kwargs):
        self._check("mark_shown")
        return await super().mark_shown(**kwargs)

    async def confirm(self, **kwargs):
        self._check("confirm")
        return await super().confirm(**kwargs)

    async def cancel(self, **kwargs):
        self._check("cancel")
        return await super().cancel(**kwargs)


class FailingConversationStore(MemoryConversationStore):
    def __init__(self, *failing: str) -> None:
        super().__init__()
        self.failing = set(failing)

    def _check(self, name: str) -> None:
        if name in self.failing:
            raise ConversationStorageError(f"{name} unavailable")

    async def save_resumption_handle(self, **kwargs):
        self._check("save_resumption_handle")
        return await super().save_resumption_handle(**kwargs)

    async def save_entity_context(self, **kwargs):
        self._check("save_entity_context")
        return await super().save_entity_context(**kwargs)


class QueuedLive(FakeLive):
    """A provider the test feeds one event at a time, after client frames."""

    def __init__(self) -> None:
        super().__init__([])
        self.queue: asyncio.Queue[LiveEvent] = asyncio.Queue()

    def emit(self, event: LiveEvent) -> None:
        self.queue.put_nowait(event)

    async def events(self):
        while True:
            yield await self.queue.get()


async def _until(condition, timeout: float = 2.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not condition():
        if asyncio.get_running_loop().time() > deadline:
            pytest.fail("condition not reached")
        await asyncio.sleep(0.01)


async def _start_live(*, pending=None, conversations=None):
    transport = FakeTransport([AUTH])
    live = QueuedLive()
    session = _session(transport, live, pending=pending, conversations=conversations)
    task = asyncio.create_task(session.run())
    await _until(lambda: transport.frames("state"))
    return session, transport, live, task


async def _end_cleanly(session, transport, task) -> None:
    # Still open after the failure, and the next client frame is still served.
    assert transport.closed is None
    transport.push({"type": "ping"})
    await _until(lambda: transport.frames("pong"))
    transport.push({"type": "end"})
    await asyncio.wait_for(task, 3)
    assert transport.closed == (protocol.CLOSE_ENDED, "ended")
    assert session._counters.get("storage_failures", 0) >= 1


async def _voice_row(pending: MemoryPendingStore, *, tool="ask", tier="voice"):
    gateway = {"ask": "location.send_request", "delete_thing": "location.delete_circle"}[tool]
    args = {"person": {"user_id": "u-priya"}} if tool == "ask" else {"thing_id": "t1"}
    row, receipt = await pending.create(
        user_id=USER,
        conversation_id=CONV,
        tool_name=tool,
        gateway_action_id=gateway,
        tier=tier,
        args=args,
        summary="the open card",
    )
    return row, receipt


async def test_unrecordable_card_shown_keeps_the_session_and_the_card_unshown():
    pending = FailingPendingStore("mark_shown")
    row, _ = await _voice_row(pending)
    session, transport, live, task = await _start_live(pending=pending)

    transport.push({"type": "pending_action.shown", "pending_action_id": row.id})
    await _until(lambda: session._counters.get("storage_failures"))
    # The provider is still heard, and a spoken yes is still fenced: the card
    # was never recorded as shown, so voice cannot confirm it.
    live.emit(
        LiveEvent(
            kind="tool_call",
            function_calls=[
                {
                    "id": "c1",
                    "name": "confirm_pending_action",
                    "args": {"pending_action_id": row.id},
                }
            ],
        )
    )
    await _until(lambda: live.tool_responses)
    assert live.tool_responses[0]["response"]["status"] == "card_not_shown"
    assert pending.rows[row.id].shown_at is None
    assert pending.rows[row.id].status == "pending"
    await _end_cleanly(session, transport, task)


async def test_unsaved_resumption_handle_keeps_the_session_listening():
    conversations = FailingConversationStore("save_resumption_handle")
    session, transport, live, task = await _start_live(conversations=conversations)

    live.emit(LiveEvent(kind="resumption", resumption_handle="h-1", resumable=True))
    live.emit(
        LiveEvent(
            kind="tool_call", function_calls=[{"id": "c1", "name": "echo", "args": {"text": "hi"}}]
        )
    )
    await _until(lambda: live.tool_responses)
    assert live.tool_responses[0]["response"]["status"] == "ok"
    assert conversations.handles == []
    await _end_cleanly(session, transport, task)


async def test_unsaved_entity_context_still_answers_the_model_and_the_client():
    conversations = FailingConversationStore("save_entity_context")
    session, transport, live, task = await _start_live(conversations=conversations)

    live.emit(
        LiveEvent(
            kind="tool_call", function_calls=[{"id": "c1", "name": "echo", "args": {"text": "hi"}}]
        )
    )
    await _until(lambda: live.tool_responses)
    assert live.tool_responses[0]["id"] == "c1"
    assert live.tool_responses[0]["response"]["status"] == "ok"
    result = transport.frames("tool.result")[-1]
    assert result["ok"] is True and result["result_public"]["echoed"] == "hi"
    assert conversations.entity_saves == []
    await _end_cleanly(session, transport, task)


@pytest.mark.parametrize("operation", ["confirm", "cancel"])
async def test_unreachable_store_on_a_tap_answers_storage_unavailable_and_keeps_the_card(
    operation,
):
    pending = FailingPendingStore(operation)
    row, receipt = await _voice_row(pending, tool="delete_thing", tier="tap")
    session, transport, live, task = await _start_live(pending=pending)

    if operation == "confirm":
        transport.push(
            {"type": "confirm_action", "pending_action_id": row.id, "receipt_token": receipt}
        )
    else:
        transport.push({"type": "cancel_action", "pending_action_id": row.id})
    await _until(lambda: transport.frames("error"))
    assert transport.frames("error")[-1]["code"] == "storage_unavailable"
    # Nothing happened to the card, and nothing claims it did.
    assert pending.rows[row.id].status == "pending"
    assert transport.frames("pending_action.resolved") == []
    assert live.events_sent == []
    await _end_cleanly(session, transport, task)


async def test_a_different_proposal_rebinds_the_open_card_to_the_current_turn():
    """The model proposes something else while a card is open: it gets that
    card back, no new card reaches the client, and a tap on the open card now
    answers the turn the model is about to ask in."""
    session, transport, fake, pending = await _voice_card_session()
    await _model_calls(session, "c1", "ask", {"person": {"user_id": "u-priya"}})
    first = transport.frames("pending_action")[-1]
    card = first["pending_action_id"]
    # Only a card the person has actually seen holds back a different action.
    await session._handle_client_frame(
        protocol.PendingShownFrame(type="pending_action.shown", pending_action_id=card)
    )

    await session._handle_live_event(LiveEvent(kind="turn_complete"))
    await session._handle_client_frame(protocol.TextFrame(type="text", text="Delete the thing"))
    later_turn = session.turn.turn_id
    assert later_turn != first["turn_id"]
    await _model_calls(session, "c2", "delete_thing", {"thing_id": "t1"})

    blocked = _responses(fake, "delete_thing")[-1]
    assert blocked["status"] == "pending_action_exists"
    assert blocked["pending_action_id"] == card
    assert len(transport.frames("pending_action")) == 1
    assert transport.frames("pending_action.resolved") == []
    assert [r.id for r in pending.rows.values()] == [card]
    assert pending.rows[card].status == "pending"
    assert session._pending_turn_ids[card] == later_turn

    await session._confirm_by_tap(
        protocol.ConfirmActionFrame(type="confirm_action", pending_action_id=card)
    )
    assert pending.rows[card].status == "executed"
    result = transport.frames("tool.result")[-1]
    assert result["pending_action_id"] == card and result["turn_id"] == later_turn
