"""Relay protocol: auth handshake, tool dispatch, confirmations, client steps."""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from typing import Literal

import pytest

from hushh_mcp.one_voice import protocol
from hushh_mcp.one_voice.config import OneVoiceLiveConfig
from hushh_mcp.one_voice.live_client import LiveEvent
from hushh_mcp.one_voice.session import AuthResult, VoiceSession
from hushh_mcp.one_voice.tickets import TicketClaims
from hushh_mcp.one_voice.tools import location_state, registry
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
            session.ctx, "invite_thing", {"person": {"user_id": "u-priya"}}
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

    accept = next(t for t in people.TOOLS if t.name == "accept_connection_request")
    by_name = {t.name: t for t in (*TEST_TOOLS, accept)}
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
        outcome = await session.executor.call(
            session.ctx, "accept_connection_request", {"request_id": REQ_IN}
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
        outcome = await session.executor.call(
            session.ctx, "accept_connection_request", {"request_id": REQ_IN}
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
