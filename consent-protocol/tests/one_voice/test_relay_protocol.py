"""Relay protocol: auth handshake, tool dispatch, confirmations, client steps."""

from __future__ import annotations

import asyncio
import json
from typing import Literal

import pytest

from hushh_mcp.one_voice import protocol
from hushh_mcp.one_voice.config import OneVoiceLiveConfig
from hushh_mcp.one_voice.live_client import LiveEvent
from hushh_mcp.one_voice.session import AuthResult, VoiceSession
from hushh_mcp.one_voice.tickets import TicketClaims
from hushh_mcp.one_voice.tools import registry
from hushh_mcp.one_voice.tools.base import (
    ConfirmedPerson,
    PersonRef,
    ToolInput,
    ToolPolicy,
    ToolResult,
    ToolSpec,
    now_iso,
)
from hushh_mcp.one_voice.tools.executor import ToolExecutor
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


async def test_ready_then_end_records_close():
    conversations = MemoryConversationStore()
    transport = FakeTransport([AUTH, {"type": "end"}])
    fake = FakeLive([LiveEvent(kind="setup_complete")])
    await _run(_session(transport, fake, conversations=conversations))
    ready = transport.frames("session.ready")[0]
    assert ready["conversation_id"] == CONV and ready["resumed"] is False
    assert ready["output_mime_type"] == "audio/pcm;rate=24000"
    assert transport.closed == (protocol.CLOSE_ENDED, "ended")
    assert conversations.closes == [(1000, "ended", True)]
    assert (
        "system_instruction" in fake.live_config
        and "resolve_person" in fake.live_config["system_instruction"]
    )


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


# --- tool dispatch ---------------------------------------------------------


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
    event = json.loads(fake.events_sent[-1].removeprefix("[ONE_EVENT] "))
    assert (
        event["kind"] == "tool_result"
        and event["result"]["status"] == "deleted"
        and event["confirmation_source"] == "tap"
    )
    transport.push({"type": "end"})
    await asyncio.wait_for(task, 3)


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
