"""build_live_client: Vertex ADC only, one pinned region, fail-closed model pin."""

from __future__ import annotations

import pytest

from hushh_mcp.runtime_providers import factory
from hushh_mcp.runtime_providers.registry import (
    LiveModelNotRegisteredError,
    resolve_live_model_entry,
    resolve_model_entry,
)

LIVE_MODEL = "gemini-live-2.5-flash-native-audio"


class _FakeClient:
    def __init__(self, **kwargs):
        self.kwargs = kwargs


@pytest.fixture
def fake_genai_client(monkeypatch):
    calls: list[dict] = []

    def _factory(**kwargs):
        calls.append(kwargs)
        return _FakeClient(**kwargs)

    import google.genai as genai

    monkeypatch.setattr(genai, "Client", _factory)
    return calls


def _binding() -> factory.ManagedGeminiRuntimeBinding:
    return factory.ManagedGeminiRuntimeBinding(
        project="hushh-vertex-test",
        locations=("global", "us"),
        auth_mode=factory.VERTEX_ADC_AUTH_MODE,
    )


def test_live_entry_is_realtime_regional_and_alias_free():
    entry = resolve_live_model_entry(LIVE_MODEL)
    assert entry.supports_native_realtime is True
    assert entry.supported_vertex_locations == ("us-central1",)
    assert entry.aliases == ()
    # The ordinary resolver sees the same entry; nothing else advertises realtime.
    assert resolve_model_entry("gemini", LIVE_MODEL).supports_native_realtime is True
    assert resolve_model_entry("gemini", "gemini-3.5-flash").supports_native_realtime is False


@pytest.mark.parametrize(
    "model_id",
    ["", "gemini-3.1-flash-live-preview", "gemini-3.8-flash", "gemini-default", "default"],
)
def test_live_resolver_fails_closed_on_pass_through_aliases_and_text_models(model_id):
    with pytest.raises(LiveModelNotRegisteredError):
        resolve_live_model_entry(model_id)


def test_build_live_client_pins_one_regional_vertex_client(fake_genai_client):
    client = _binding().build_live_client(model=LIVE_MODEL, location="us-central1")
    assert isinstance(client, _FakeClient)
    assert fake_genai_client == [
        {"vertexai": True, "project": "hushh-vertex-test", "location": "us-central1"}
    ]


def test_voice_project_override_does_not_change_ambient_client(fake_genai_client, monkeypatch):
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "local")
    monkeypatch.setenv("HUSHH_GENAI_AUTH_MODE", "vertex_adc")
    monkeypatch.setenv("GENAI_GOOGLE_CLOUD_PROJECT", "hushh-vertex-personal54")
    factory.build_managed_live_client(
        model=LIVE_MODEL, location="us-central1", vertex_project="hussh-511311"
    )
    factory.build_managed_live_client(model=LIVE_MODEL, location="us-central1")
    assert [call["project"] for call in fake_genai_client] == [
        "hussh-511311",
        "hushh-vertex-personal54",
    ]


@pytest.mark.parametrize("location", ["global", "us", "eu", ""])
def test_build_live_client_rejects_multi_region_aliases(fake_genai_client, location):
    with pytest.raises(RuntimeError, match="regional"):
        _binding().build_live_client(model=LIVE_MODEL, location=location)
    assert fake_genai_client == []


def test_build_live_client_rejects_unsupported_region_for_model(fake_genai_client):
    with pytest.raises(RuntimeError, match="not supported"):
        _binding().build_live_client(model=LIVE_MODEL, location="europe-west4")
    assert fake_genai_client == []


def test_build_live_client_rejects_unregistered_model(fake_genai_client):
    with pytest.raises(LiveModelNotRegisteredError):
        _binding().build_live_client(model="gemini-3.1-flash-live-preview", location="us-central1")
    assert fake_genai_client == []


def test_build_live_client_refuses_developer_api_key_mode(fake_genai_client, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "developer-key")
    binding = factory.ManagedGeminiRuntimeBinding(
        project="", locations=(), auth_mode=factory.DEVELOPER_API_KEY_AUTH_MODE
    )
    with pytest.raises(RuntimeError, match="Vertex ADC"):
        binding.build_live_client(model=LIVE_MODEL, location="us-central1")
    assert fake_genai_client == []


def test_hosted_environment_cannot_select_developer_key_for_live(monkeypatch, fake_genai_client):
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")
    monkeypatch.setenv("HUSHH_GENAI_AUTH_MODE", "developer_api_key")
    factory.build_managed_live_client(model=LIVE_MODEL, location="us-central1")
    assert fake_genai_client[0]["vertexai"] is True
    assert fake_genai_client[0]["project"] == "hushh-gemini-bridge"
    assert "api_key" not in fake_genai_client[0]


# --- the declarations really reach the Live model ---------------------------


def test_build_live_config_declares_the_device_tools_verbatim_from_one_home():
    from hushh_mcp.one_voice.instruction import build_instruction
    from hushh_mcp.one_voice.live_client import build_live_config
    from hushh_mcp.one_voice.tools import location_state, registry
    from hushh_mcp.one_voice.tools.base import ScreenContext
    from hushh_mcp.one_voice.tools.session import OPENABLE_SCREENS

    # A session opened from /one: no Location page mounted, nothing said yet.
    screen = ScreenContext(screen_id="one_home", route="/one")
    declarations = registry.declarations()
    config = build_live_config(
        system_instruction=build_instruction(
            tool_declarations=declarations,
            screen_ids=list(OPENABLE_SCREENS),
            screen_id=screen.screen_id,
            display_name="Ayesha",
        ),
        tool_declarations=declarations,
        voice_name="Leda",
        resumption_handle=None,
    )

    assert len(config.tools) == 1
    declared = {item.name: item for item in config.tools[0].function_declarations}
    for name in ("resume_device_location_updates", "pause_device_location_updates"):
        spec = next(tool for tool in location_state.TOOLS if tool.name == name)
        assert name in declared, name
        assert declared[name].description == spec.description
        assert declared[name].parameters_json_schema == {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        }
    assert "resume_device_location_updates" in config.system_instruction.parts[0].text
    assert "one_home" in config.system_instruction.parts[0].text


class _AzureConnection:
    def __init__(self, events=()):
        from types import SimpleNamespace
        from unittest.mock import AsyncMock

        self.script = events
        self.response = SimpleNamespace(create=AsyncMock(), cancel=AsyncMock())
        self.conversation = SimpleNamespace(
            item=SimpleNamespace(create=AsyncMock(), truncate=AsyncMock())
        )
        self.input_audio_buffer = SimpleNamespace(append=AsyncMock())

    def __aiter__(self):
        async def iterate():
            for event in self.script:
                yield event

        return iterate()


def _azure_event(kind, **values):
    from types import SimpleNamespace

    return SimpleNamespace(type=kind, **values)


def _azure_session(events=(), *, playback_acknowledgements=False):
    from types import SimpleNamespace

    from hushh_mcp.one_voice.azure_live import AzureLiveSession

    binding = SimpleNamespace(require_current=lambda: None)
    connection = _AzureConnection(events)
    return AzureLiveSession(
        connection,
        binding,
        {
            "tools": [
                {
                    "name": "synthetic",
                    "parameters": {"type": "object", "additionalProperties": False},
                }
            ]
        },
        playback_acknowledgements=playback_acknowledgements,
    ), connection


def test_azure_resampling_preserves_the_client_rate_and_frame_continuity():
    import struct

    from hushh_mcp.one_voice.azure_live import Pcm16Resampler

    raw = struct.pack("<160h", *range(160))
    whole = Pcm16Resampler().push(raw)
    chunked = Pcm16Resampler()
    assert b"".join(chunked.push(raw[i : i + 14]) for i in range(0, len(raw), 14)) == whole
    assert 237 <= len(whole) // 2 <= 240
    with pytest.raises(ValueError):
        chunked.push(b"odd")


async def test_azure_accepts_buffered_audio_up_to_the_public_protocol_bound():
    import base64

    from hushh_mcp.one_voice.azure_live import MAX_PCM_FRAME_BYTES, Pcm16Resampler
    from hushh_mcp.one_voice.protocol import MAX_AUDIO_FRAME_BYTES

    raw = b"\x01\x00" * (MAX_AUDIO_FRAME_BYTES // 2)
    session, connection = _azure_session()
    await session.send_audio(base64.b64encode(raw).decode("ascii"))
    sent = b"".join(
        base64.b64decode(call.kwargs["audio"])
        for call in connection.input_audio_buffer.append.await_args_list
    )
    resampler = Pcm16Resampler()
    expected = b"".join(resampler.push(raw[i : i + 8000]) for i in range(0, len(raw), 8000))
    assert sent == expected
    assert all(
        len(base64.b64decode(call.kwargs["audio"])) <= MAX_PCM_FRAME_BYTES * 3 // 2 + 2
        for call in connection.input_audio_buffer.append.await_args_list
    )
    prior = connection.input_audio_buffer.append.await_count
    with pytest.raises(ValueError):
        await session.send_audio(base64.b64encode(raw + b"\x00\x00").decode("ascii"))
    assert connection.input_audio_buffer.append.await_count == prior


async def test_azure_tool_batch_settles_exact_call_ids_before_one_continuation():
    from types import SimpleNamespace as NS

    events = [
        _azure_event("response.created", response=NS(id="r1")),
        *[
            _azure_event(
                "response.output_item.done",
                response_id="r1",
                item=NS(type="function_call", call_id=identity, name="synthetic", arguments="{}"),
            )
            for identity in ("call1", "call2")
        ],
        _azure_event("response.done", response=NS(id="r1", status="completed")),
        _azure_event("response.created", response=NS(id="r2")),
        _azure_event("response.done", response=NS(id="r2", status="completed")),
    ]
    session, connection = _azure_session(events)
    observed = []
    async for event in session.events():
        observed.append(event.kind)
        if event.kind == "tool_call":
            assert [call["id"] for call in event.function_calls] == ["call1", "call2"]
            for call in event.function_calls:
                await session.send_tool_response(
                    call_id=call["id"], name=call["name"], response={"ok": True}
                )
    assert observed == ["tool_call", "turn_complete"]
    assert connection.response.create.await_count == 1
    assert [
        call.kwargs["item"]["call_id"]
        for call in connection.conversation.item.create.await_args_list
    ] == ["call1", "call2"]


async def test_azure_late_input_transcripts_keep_identity_and_only_latest_capture_requests_response():
    from types import SimpleNamespace as NS

    events = [
        _azure_event("input_audio_buffer.speech_started", item_id="input_a"),
        _azure_event("input_audio_buffer.speech_stopped", item_id="input_a"),
        _azure_event("input_audio_buffer.speech_started", item_id="input_b"),
        _azure_event("input_audio_buffer.speech_stopped", item_id="input_b"),
        _azure_event(
            "conversation.item.input_audio_transcription.completed",
            item_id="input_b",
            transcript="Latest synthetic request",
        ),
        _azure_event(
            "conversation.item.input_audio_transcription.completed",
            item_id="input_a",
            transcript="Earlier synthetic request",
        ),
        _azure_event("response.created", response=NS(id="r1")),
        _azure_event("response.done", response=NS(id="r1", status="completed")),
    ]
    session, connection = _azure_session(events)
    observed = [event async for event in session.events()]
    assert [(e.input_item_id, e.text) for e in observed if e.kind == "input_transcript"] == [
        ("input_b", "Latest synthetic request"),
        ("input_a", "Earlier synthetic request"),
    ]
    assert connection.response.create.await_count == 1


async def test_azure_requested_then_cancelled_response_cannot_publish_late_audio_or_tools():
    from types import SimpleNamespace as NS

    events = [
        _azure_event("input_audio_buffer.speech_started", item_id="new_input"),
        _azure_event("input_audio_buffer.speech_stopped", item_id="new_input"),
        _azure_event(
            "conversation.item.input_audio_transcription.completed",
            item_id="new_input",
            transcript="New request",
        ),
        _azure_event("response.created", response=NS(id="old_response")),
        _azure_event(
            "response.output_audio.delta",
            response_id="old_response",
            delta="invalid",
            item_id="old_item",
        ),
        _azure_event(
            "response.output_item.done",
            response_id="old_response",
            item=NS(type="function_call", name="unknown"),
        ),
        _azure_event("response.done", response=NS(id="old_response", status="cancelled")),
        _azure_event("response.created", response=NS(id="new_response")),
        _azure_event("response.done", response=NS(id="new_response", status="completed")),
    ]
    session, connection = _azure_session(events)
    await session.send_text("Old request")
    observed = [e async for e in session.events()]
    assert [e.kind for e in observed].count("interrupted") == 1
    assert not any(e.kind in {"audio", "tool_call"} for e in observed)
    assert connection.response.cancel.await_args.kwargs == {"response_id": "old_response"}
    assert connection.response.create.await_count == 2


async def test_azure_interrupt_rechecks_function_authority_after_lock_wait():
    import asyncio

    session, connection = _azure_session()
    session.pending_calls["call1"] = {"id": "call1", "name": "synthetic", "args": {}}
    session.response_complete = True
    await session._send_lock.acquire()
    interrupt = asyncio.create_task(session.interrupt())
    await asyncio.sleep(0)
    result = asyncio.create_task(
        session.send_tool_response(call_id="call1", name="synthetic", response={"ok": True})
    )
    await asyncio.sleep(0)
    session._send_lock.release()
    await asyncio.gather(interrupt, result)
    assert connection.conversation.item.create.await_count == 0
    assert connection.response.create.await_count == 0


@pytest.mark.parametrize("played_ms", [None, 125])
async def test_azure_barge_in_uses_acknowledged_playback_not_sent_duration(played_ms):
    session, connection = _azure_session()
    session.audio_items["item1"] = {"bytes": 48000, "played_ms": 0, "content_index": 0}
    session.audio_item = "item1"
    session.response_id = "old_response"
    if played_ms is not None:
        await session.acknowledge_playback("item1", played_ms)
    with pytest.raises(ValueError):
        await session.acknowledge_playback("item1", 1100)
    await session.interrupt()
    assert connection.conversation.item.truncate.await_args.kwargs == {
        "item_id": "item1",
        "content_index": 0,
        "audio_end_ms": played_ms or 0,
    }
    assert connection.response.cancel.await_args.kwargs == {"response_id": "old_response"}
    await session.send_text("New synthetic request after interruption")
    assert connection.conversation.item.create.await_count == 1


@pytest.mark.parametrize("playback_acknowledgements", [False, True])
@pytest.mark.parametrize("with_tool", [False, True])
async def test_azure_completed_answer_survives_an_ordinary_legacy_follow_up(
    playback_acknowledgements,
    with_tool,
):
    import base64
    from types import SimpleNamespace as NS

    events = [
        _azure_event("response.created", response=NS(id="completed_response")),
        _azure_event(
            "response.output_audio.delta",
            response_id="completed_response",
            delta=base64.b64encode(b"\x00\x00" * 2400).decode("ascii"),
            item_id="completed_item",
            content_index=0,
        ),
        *(
            [
                _azure_event(
                    "response.output_item.done",
                    response_id="completed_response",
                    item=NS(
                        type="function_call", call_id="tool1", name="synthetic", arguments="{}"
                    ),
                )
            ]
            if with_tool
            else []
        ),
        _azure_event("response.done", response=NS(id="completed_response", status="completed")),
        _azure_event("input_audio_buffer.speech_started", item_id="follow_up"),
        _azure_event("input_audio_buffer.speech_stopped", item_id="follow_up"),
        _azure_event(
            "conversation.item.input_audio_transcription.completed",
            item_id="follow_up",
            transcript="Please explain the completed answer",
        ),
    ]
    session, connection = _azure_session(
        events, playback_acknowledgements=playback_acknowledgements
    )
    observed = []
    async for event in session.events():
        observed.append(event)
        if event.kind in {"turn_complete", "tool_call"} and playback_acknowledgements:
            await session.acknowledge_playback("completed_item", 75)
    assert any(event.kind == ("tool_call" if with_tool else "turn_complete") for event in observed)
    assert any(event.kind == "tool_cancel" for event in observed) is with_tool
    assert any(
        event.kind == "input_transcript" and event.input_item_id == "follow_up"
        for event in observed
    )
    assert connection.response.cancel.await_count == 0
    assert connection.response.create.await_count == 1
    if playback_acknowledgements:
        assert connection.conversation.item.truncate.await_args.kwargs == {
            "item_id": "completed_item",
            "content_index": 0,
            "audio_end_ms": 75,
        }
    else:
        assert connection.conversation.item.truncate.await_count == 0
    # A new capture still advances interruption/tool authority for both clients.
    assert session._interruption_generation == 1


async def test_azure_transcript_timeout_cannot_be_extended_by_other_buffered_events():
    import asyncio

    session, _ = _azure_session([_azure_event("other") for _ in range(100)])
    session._awaiting_transcript_at = asyncio.get_running_loop().time() - 16
    with pytest.raises(TimeoutError):
        _ = [event async for event in session.events()]


@pytest.mark.parametrize("change_during_publish", [False, True])
async def test_azure_text_rechecks_processor_after_lock_and_before_response(change_during_publish):
    import asyncio

    session, connection = _azure_session()
    current = True

    def require_current():
        if not current:
            raise PermissionError("Synthetic processor changed")

    session.binding.require_current = require_current
    if change_during_publish:

        async def publish(**kwargs):
            nonlocal current
            current = False

        connection.conversation.item.create.side_effect = publish
        with pytest.raises(PermissionError):
            await session.send_text("Synthetic input")
        assert connection.conversation.item.create.await_count == 1
    else:
        await session._send_lock.acquire()
        task = asyncio.create_task(session.send_text("Synthetic input"))
        await asyncio.sleep(0)
        current = False
        session._send_lock.release()
        with pytest.raises(PermissionError):
            await task
        assert connection.conversation.item.create.await_count == 0
    assert connection.response.create.await_count == 0


async def test_azure_capture_fences_input_before_waiting_for_provider_cancellation():
    import asyncio

    session, connection = _azure_session(
        [
            _azure_event("input_audio_buffer.speech_started", item_id="input_new"),
        ]
    )
    session.response_id = "old_response"
    await session._send_lock.acquire()
    events = session.events()
    assert (await anext(events)).kind == "interrupted"
    started = await anext(events)
    assert (started.kind, started.input_item_id) == ("activity_start", "input_new")
    waiting = asyncio.create_task(anext(events))
    await asyncio.sleep(0)
    assert not waiting.done()
    session._send_lock.release()
    with pytest.raises(StopAsyncIteration):
        await waiting
    assert connection.response.cancel.await_count == 1


async def test_azure_vad_fence_preserves_a_newer_request_queued_during_cancellation():
    from types import SimpleNamespace as NS

    session, connection = _azure_session(
        [
            _azure_event("input_audio_buffer.speech_started", item_id="older_capture"),
            _azure_event("response.done", response=NS(id="old_response", status="cancelled")),
            _azure_event(
                "conversation.item.input_audio_transcription.completed",
                item_id="older_capture",
                transcript="Old yes",
            ),
            _azure_event("input_audio_buffer.speech_stopped", item_id="older_capture"),
        ]
    )
    session.response_id = "old_response"
    events = session.events()
    assert (await anext(events)).kind == "interrupted"
    await session.send_text("Newer correction")
    remaining = [event async for event in events]
    assert connection.response.cancel.await_args.kwargs == {"response_id": "old_response"}
    assert connection.response.create.await_count == 1
    assert len([e for e in remaining if e.kind == "input_transcript"]) == 1
