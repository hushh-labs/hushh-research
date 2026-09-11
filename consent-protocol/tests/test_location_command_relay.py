"""Focused protocol tests for the standalone Location command relay."""

from __future__ import annotations

import asyncio
import json
from base64 import b64encode
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Mapping

import pytest

from api.routes.one import location_command_relay as relay


class _BootstrapSocket:
    def __init__(self, frame: Mapping[str, Any]) -> None:
        self.frame = dict(frame)

    async def receive_text(self) -> str:
        return json.dumps(self.frame)


class _Socket:
    def __init__(self, frames: list[Mapping[str, Any]]) -> None:
        self._frames = [json.dumps(frame) for frame in frames]
        self.sent: list[dict[str, Any]] = []

    async def receive_text(self) -> str:
        if self._frames:
            return self._frames.pop(0)
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    async def send_text(self, value: str) -> None:
        self.sent.append(json.loads(value))


class _Turn:
    def __init__(self, turn_id: str) -> None:
        self.turn_id = turn_id
        self.last_sequence = 0
        self.expected_sequence = 1
        self.speech_ended = False
        self.provider_turn_complete = False
        self.transcript = ""
        self.resolution_taken = False
        self.execution_committed = False
        self.result_settled = False
        self.cancelled = False


class _Gate:
    """Small deterministic stand-in for the separately-owned runtime gate."""

    def __init__(self) -> None:
        self.turn: _Turn | None = None

    def begin(self, payload: Mapping[str, Any], *, provider_ready: bool, context_ready: bool):
        if not provider_ready or not context_ready:
            return None, "not_ready"
        if payload.get("protocolVersion") != relay.LOCATION_COMMAND_PROTOCOL_VERSION:
            return None, "protocol_mismatch"
        turn_id = str(payload.get("turnId") or "")
        if not turn_id or payload.get("startSequence") != 1:
            return None, "invalid_begin"
        self.turn = _Turn(turn_id)
        return self.turn, None

    def accept_audio(self, metadata: Mapping[str, Any] | None) -> str | None:
        if self.turn is None:
            return "turn_not_started"
        if self.turn.speech_ended:
            return "post_endpoint_ignored"
        if not isinstance(metadata, Mapping) or metadata.get("turnId") != self.turn.turn_id:
            return "turn_mismatch"
        if metadata.get("sequence") != self.turn.expected_sequence:
            return "sequence_gap"
        self.turn.last_sequence += 1
        self.turn.expected_sequence += 1
        return None

    def receive_final_transcript(self, text: str) -> str | None:
        if self.turn is None or self.turn.last_sequence < 1:
            return "final_transcript_before_audio"
        self.turn.transcript = text
        return None

    def mark_provider_turn_complete(self) -> bool:
        if self.turn is None or self.turn.last_sequence < 1:
            return False
        self.turn.speech_ended = True
        self.turn.provider_turn_complete = True
        return True

    def take_resolution(self) -> tuple[str, str] | None:
        if (
            self.turn is None
            or self.turn.resolution_taken
            or not self.turn.speech_ended
            or not self.turn.provider_turn_complete
            or not self.turn.transcript
        ):
            return None
        self.turn.resolution_taken = True
        return self.turn.turn_id, self.turn.transcript

    def may_emit_resolution_result(self, *, turn_id: str) -> bool:
        return bool(
            self.turn
            and self.turn.turn_id == turn_id
            and self.turn.resolution_taken
            and not self.turn.cancelled
            and not self.turn.result_settled
        )

    def claim_durable_advance(self, *, turn_id: str) -> bool:
        if not self.may_emit_resolution_result(turn_id=turn_id):
            return False
        assert self.turn is not None
        self.turn.execution_committed = True
        return True

    def mark_result_settled(self, *, turn_id: str) -> None:
        if self.turn and self.turn.turn_id == turn_id:
            self.turn.result_settled = True

    def fail(self) -> str | None:
        if self.turn is None or self.turn.result_settled or self.turn.execution_committed:
            return None
        self.turn.cancelled = True
        return self.turn.turn_id

    def missing_final_transcript_after_completion(self, *, turn_id: str) -> str | None:
        if (
            self.turn
            and self.turn.turn_id == turn_id
            and self.turn.provider_turn_complete
            and not self.turn.transcript
            and not self.turn.resolution_taken
        ):
            self.turn.resolution_taken = True
            return turn_id
        return None

    def end(self, payload: Mapping[str, Any]):
        if self.turn is None or payload.get("turnId") != self.turn.turn_id:
            return None, "turn_mismatch"
        if payload.get("cancelled") is not True:
            return None, "client_end_not_supported"
        self.turn.cancelled = True
        return self.turn, None


class _Plan:
    def __init__(self, turn_id: str, *, durable: bool = False) -> None:
        self.turn_id = turn_id
        self.requires_durable_advance = durable


class _Result:
    def __init__(self, turn_id: str) -> None:
        self.turn_id = turn_id

    def wire_payload(self) -> dict[str, Any]:
        return {
            "protocolVersion": relay.LOCATION_COMMAND_PROTOCOL_VERSION,
            "turnId": self.turn_id,
            "outcome": "interaction_required",
            "actionId": "workflow.setup.location",
        }


class _Runtime:
    def __init__(self, session: "_Session") -> None:
        self.session = session
        self.plan_calls: list[dict[str, Any]] = []
        self.advance_calls: list[dict[str, Any]] = []

    async def plan(self, **kwargs: Any) -> _Plan:
        # The route must not invoke semantic grounding after only a partial
        # transcript.  The fake session sets this immediately before it emits
        # the provider's authoritative turn completion.
        assert self.session.turn_complete_emitted is True
        self.plan_calls.append(kwargs)
        return _Plan(str(kwargs["turn_id"]))

    async def advance(self, plan: _Plan, **kwargs: Any) -> _Result:
        self.advance_calls.append(kwargs)
        return _Result(plan.turn_id)


class _Session:
    setup_complete = object()

    def __init__(self, *, final_before_turn_complete: bool) -> None:
        self.final_before_turn_complete = final_before_turn_complete
        self.audio_received = asyncio.Event()
        self.turn_complete_emitted = False
        self.sent_audio: list[dict[str, Any]] = []

    async def send_realtime_input(self, **kwargs: Any) -> None:
        self.sent_audio.append(kwargs)
        self.audio_received.set()

    async def receive(self):
        await self.audio_received.wait()
        final = SimpleNamespace(
            server_content=SimpleNamespace(
                input_transcription=SimpleNamespace(text="set up my location"),
                interrupted=False,
                turn_complete=False,
            )
        )
        complete = SimpleNamespace(
            server_content=SimpleNamespace(
                input_transcription=None,
                interrupted=False,
                turn_complete=True,
            )
        )
        if self.final_before_turn_complete:
            yield final
            self.turn_complete_emitted = True
            yield complete
        else:
            self.turn_complete_emitted = True
            yield complete
            yield final
        await asyncio.Event().wait()


class _Live:
    def __init__(self, session: _Session) -> None:
        self.session = session

    @asynccontextmanager
    async def connect(self, **_kwargs: Any):
        yield self.session


def _dependencies(runtime: _Runtime) -> relay._CommandRuntimeDependencies:
    return relay._CommandRuntimeDependencies(
        runtime_factory=lambda: runtime,
        turn_gate_factory=_Gate,
        runtime_enabled=lambda: True,
        transcribe_model=lambda: relay.LOCATION_COMMAND_TRANSCRIBE_MODEL,
        protocol_version=relay.LOCATION_COMMAND_PROTOCOL_VERSION,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("final_before_turn_complete", (True, False))
async def test_relay_waits_for_final_transcript_and_provider_turn_complete(
    final_before_turn_complete: bool,
) -> None:
    pcm = b64encode(b"\x00\x01\x02\x03").decode("ascii")
    socket = _Socket(
        [
            {"type": "app_context", "appContext": {"context_revision": "ctx_1"}},
            {
                "type": "location_command_begin",
                "protocolVersion": relay.LOCATION_COMMAND_PROTOCOL_VERSION,
                "turnId": "turn_1",
                "startSequence": 1,
            },
            {
                "realtimeInput": {
                    "audio": {"mimeType": "audio/pcm;rate=16000", "data": pcm},
                    "locationCommand": {"turnId": "turn_1", "sequence": 1},
                }
            },
        ]
    )
    session = _Session(final_before_turn_complete=final_before_turn_complete)
    runtime = _Runtime(session)
    client = SimpleNamespace(aio=SimpleNamespace(live=_Live(session)))

    await relay._run_location_command_relay(
        socket,  # type: ignore[arg-type]
        uid="owner_1",
        client=client,
        model=relay.LOCATION_COMMAND_TRANSCRIBE_MODEL,
        dependencies=_dependencies(runtime),
    )

    assert len(session.sent_audio) == 1
    assert runtime.plan_calls == [
        {"turn_id": "turn_1", "transcript": "set up my location", "user_id": "owner_1"}
    ]
    assert runtime.advance_calls == [
        {"user_id": "owner_1", "consent_token": "", "context_revision": "ctx_1"}
    ]
    frames = socket.sent
    assert {"relayAccepted": {"protocolVersion": relay.LOCATION_COMMAND_PROTOCOL_VERSION}} in frames
    assert {"providerReady": {}} in frames
    assert {
        "locationCommandReady": {
            "protocolVersion": relay.LOCATION_COMMAND_PROTOCOL_VERSION,
            "relayAccepted": True,
            "providerReady": True,
            "contextAccepted": True,
        }
    } in frames
    completion_index = frames.index({"serverContent": {"turnComplete": True}})
    result_index = next(
        index for index, frame in enumerate(frames) if "locationCommandResult" in frame
    )
    assert completion_index < result_index
    assert all("set up my location" not in json.dumps(frame) for frame in frames)


@pytest.mark.asyncio
async def test_bootstrap_accepts_only_managed_v2_without_client_credentials() -> None:
    accepted = _BootstrapSocket(
        {
            "type": "runtime_bootstrap",
            "location_command_protocol": relay.LOCATION_COMMAND_PROTOCOL_VERSION,
            "runtime_credential_mode": "hushh_managed_vertex",
            # Existing generic client field; the command relay ignores it and
            # still selects Vertex ADC itself.
            "runtime_credential_transport": "developer_api",
        }
    )
    await relay._receive_bootstrap(accepted)  # type: ignore[arg-type]

    rejected = _BootstrapSocket(
        {
            "type": "runtime_bootstrap",
            "location_command_protocol": relay.LOCATION_COMMAND_PROTOCOL_VERSION,
            "runtime_credential_mode": "byok",
            "runtime_credential": "not-accepted",
        }
    )
    with pytest.raises(ValueError, match="managed_runtime_required"):
        await relay._receive_bootstrap(rejected)  # type: ignore[arg-type]


def test_command_rollout_is_uat_only_and_requires_the_runtime_gate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dependencies = relay._CommandRuntimeDependencies(
        runtime_factory=lambda: object(),
        turn_gate_factory=lambda: object(),
        runtime_enabled=lambda: True,
        transcribe_model=lambda: relay.LOCATION_COMMAND_TRANSCRIBE_MODEL,
        protocol_version=relay.LOCATION_COMMAND_PROTOCOL_VERSION,
    )
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv(relay.LOCATION_COMMAND_RUNTIME_ENABLED_ENV, "true")
    assert relay._command_rollout_enabled(dependencies) is True

    monkeypatch.setenv("ENVIRONMENT", "production")
    assert relay._command_rollout_enabled(dependencies) is False


def test_standalone_command_relay_does_not_import_or_modify_the_chat_relay() -> None:
    source = Path(relay.__file__).read_text(encoding="utf-8")
    assert "adk_live" not in source
    assert 'prefix="/api/one/adk/location-command"' in source
    assert (
        "automatic_activity_detection=genai_types.AutomaticActivityDetection(disabled=False)"
        in source
    )
    assert "location_command_end" in source
    assert "client_end_not_supported" in source
