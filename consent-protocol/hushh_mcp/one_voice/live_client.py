"""Port over the Gemini Live session so the relay is testable without a provider.

``LiveSessionPort`` is the narrow surface the session orchestrator uses.
``GeminiLiveSession`` adapts ``google.genai`` ``AsyncSession``; tests inject a
scripted fake. The client itself comes from ``factory.build_managed_live_client``
(ADC, one pinned region) -- nothing here constructs one.
"""

from __future__ import annotations

import base64
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, Protocol

from google.genai import types as genai_types

from hushh_mcp.one_voice.config import OneVoiceLiveConfig
from hushh_mcp.runtime_providers.factory import build_managed_live_client


@dataclass
class LiveEvent:
    """Provider-agnostic view of one server message."""

    kind: str  # setup_complete | activity_start | activity_end | audio | input_transcript | output_transcript | interrupted | turn_complete | tool_call | tool_cancel | resumption | go_away | other
    audio_b64: str | None = None
    text: str | None = None
    finished: bool | None = None
    function_calls: list[dict[str, Any]] = field(default_factory=list)
    cancelled_ids: list[str] = field(default_factory=list)
    resumption_handle: str | None = None
    resumable: bool | None = None
    go_away_seconds: int | None = None
    activity_source: str | None = None  # voice_activity | vad_signal
    same_message_input_transcript: bool = False


class LiveSessionPort(Protocol):
    async def send_audio(self, pcm16_b64: str) -> None: ...

    async def send_text(self, text: str) -> None: ...

    async def send_event(self, text: str) -> None: ...

    async def send_tool_response(
        self, *, call_id: str | None, name: str, response: dict[str, Any]
    ) -> None: ...

    async def send_audio_stream_end(self) -> None: ...

    def events(self) -> AsyncIterator[LiveEvent]: ...


def build_live_config(
    *,
    system_instruction: str,
    tool_declarations: list[dict[str, Any]],
    voice_name: str,
    resumption_handle: str | None,
) -> genai_types.LiveConnectConfig:
    declarations = [
        genai_types.FunctionDeclaration(
            name=item["name"],
            description=item.get("description"),
            parameters_json_schema=item.get("parameters_json_schema"),
        )
        for item in tool_declarations
    ]
    return genai_types.LiveConnectConfig(
        response_modalities=[genai_types.Modality.AUDIO],
        speech_config=genai_types.SpeechConfig(
            voice_config=genai_types.VoiceConfig(
                prebuilt_voice_config=genai_types.PrebuiltVoiceConfig(voice_name=voice_name)
            )
        ),
        system_instruction=genai_types.Content(
            role="user", parts=[genai_types.Part(text=system_instruction)]
        ),
        tools=[genai_types.Tool(function_declarations=declarations)],
        input_audio_transcription=genai_types.AudioTranscriptionConfig(),
        output_audio_transcription=genai_types.AudioTranscriptionConfig(),
        context_window_compression=genai_types.ContextWindowCompressionConfig(
            sliding_window=genai_types.SlidingWindow()
        ),
        session_resumption=genai_types.SessionResumptionConfig(handle=resumption_handle),
        realtime_input_config=genai_types.RealtimeInputConfig(
            automatic_activity_detection=genai_types.AutomaticActivityDetection()
        ),
    )


class GeminiLiveSession:
    """Adapter over ``google.genai.live.AsyncSession``."""

    def __init__(self, session: Any) -> None:
        self._session = session

    async def send_audio(self, pcm16_b64: str) -> None:
        raw = base64.b64decode(pcm16_b64)
        await self._session.send_realtime_input(
            audio=genai_types.Blob(data=raw, mime_type="audio/pcm;rate=16000")
        )

    async def send_text(self, text: str) -> None:
        await self._session.send_client_content(
            turns=genai_types.Content(role="user", parts=[genai_types.Part(text=text)]),
            turn_complete=True,
        )

    async def send_event(self, text: str) -> None:
        # Asynchronous authoritative results ([ONE_EVENT] ...) enter the context
        # as a user turn the model narrates; Vertex has no streaming tool
        # responses (will_continue) to attach them to.
        await self.send_text(text)

    async def send_tool_response(
        self, *, call_id: str | None, name: str, response: dict[str, Any]
    ) -> None:
        await self._session.send_tool_response(
            function_responses=[
                genai_types.FunctionResponse(id=call_id, name=name, response=response)
            ]
        )

    async def send_audio_stream_end(self) -> None:
        await self._session.send_realtime_input(audio_stream_end=True)

    async def events(self) -> AsyncIterator[LiveEvent]:
        """Yield events for the whole session.

        ``AsyncSession.receive()`` represents ONE model turn: it stops after
        ``turn_complete``. The session stays open, so keep receiving turns
        until the connection really closes (an empty pass or a closed-socket
        error).
        """
        while True:
            yielded = False
            try:
                async for message in self._session.receive():
                    yielded = True
                    for event in translate_message(message):
                        yield event
            except Exception as exc:  # noqa: BLE001 - closed socket ends the stream
                if _is_connection_closed(exc):
                    return
                raise
            if not yielded:
                return


def _is_connection_closed(exc: BaseException) -> bool:
    name = type(exc).__name__
    return name.startswith("ConnectionClosed") or isinstance(exc, ConnectionError)


def translate_message(message: Any) -> list[LiveEvent]:
    events: list[LiveEvent] = []
    # A provider message can close its function-call turn and carry the call
    # together. The tool still belongs to the turn that requested it; the
    # following model turn closes only after its tool response is supplied.
    has_tool_call = bool(getattr(getattr(message, "tool_call", None), "function_calls", None))
    if getattr(message, "setup_complete", None) is not None:
        events.append(LiveEvent(kind="setup_complete"))
    content = getattr(message, "server_content", None)
    input_transcription = getattr(content, "input_transcription", None)
    same_message_input = bool(getattr(input_transcription, "text", None))
    # These are fields on the pinned google-genai LiveServerMessage. Either
    # explicit end signal may be absent from a real stream; client-side
    # endpointing telemetry remains the fallback in that case.
    activity = getattr(message, "voice_activity", None)
    activity_type = getattr(activity, "voice_activity_type", None)
    signal = getattr(message, "voice_activity_detection_signal", None)
    signal_type = getattr(signal, "vad_signal_type", None)
    if activity_type == genai_types.VoiceActivityType.ACTIVITY_START:
        events.append(LiveEvent(kind="activity_start", activity_source="voice_activity"))
    if activity_type == genai_types.VoiceActivityType.ACTIVITY_END:
        events.append(
            LiveEvent(
                kind="activity_end",
                activity_source="voice_activity",
                same_message_input_transcript=same_message_input,
            )
        )
    elif signal_type == genai_types.VadSignalType.VAD_SIGNAL_TYPE_EOS:
        events.append(
            LiveEvent(
                kind="activity_end",
                activity_source="vad_signal",
                same_message_input_transcript=same_message_input,
            )
        )
    if content is not None:
        # The person's words come before Live's reply to them. Within one message
        # the relay must see the input first, or the reply's opening audio is
        # attributed to whatever turn was current before the person spoke.
        transcription = getattr(content, "input_transcription", None)
        if transcription is not None and getattr(transcription, "text", None):
            events.append(
                LiveEvent(
                    kind="input_transcript",
                    text=transcription.text,
                    finished=bool(getattr(transcription, "finished", False)),
                )
            )
        turn = getattr(content, "model_turn", None)
        for part in getattr(turn, "parts", None) or []:
            inline = getattr(part, "inline_data", None)
            data = getattr(inline, "data", None) if inline is not None else None
            if data:
                events.append(
                    LiveEvent(kind="audio", audio_b64=base64.b64encode(data).decode("ascii"))
                )
        transcription = getattr(content, "output_transcription", None)
        if transcription is not None and getattr(transcription, "text", None):
            events.append(
                LiveEvent(
                    kind="output_transcript",
                    text=transcription.text,
                    finished=bool(getattr(transcription, "finished", False)),
                )
            )
        if getattr(content, "interrupted", None):
            events.append(LiveEvent(kind="interrupted"))
        if getattr(content, "turn_complete", None) and not has_tool_call:
            events.append(LiveEvent(kind="turn_complete"))
    tool_call = getattr(message, "tool_call", None)
    if tool_call is not None:
        calls = []
        for call in getattr(tool_call, "function_calls", None) or []:
            calls.append(
                {
                    "id": getattr(call, "id", None),
                    "name": str(getattr(call, "name", "") or ""),
                    "args": dict(getattr(call, "args", None) or {}),
                }
            )
        events.append(LiveEvent(kind="tool_call", function_calls=calls))
    cancellation = getattr(message, "tool_call_cancellation", None)
    if cancellation is not None:
        events.append(
            LiveEvent(
                kind="tool_cancel",
                cancelled_ids=[str(i) for i in (getattr(cancellation, "ids", None) or [])],
            )
        )
    resumption = getattr(message, "session_resumption_update", None)
    if resumption is not None:
        events.append(
            LiveEvent(
                kind="resumption",
                resumption_handle=getattr(resumption, "new_handle", None),
                resumable=getattr(resumption, "resumable", None),
            )
        )
    go_away = getattr(message, "go_away", None)
    if go_away is not None:
        time_left = getattr(go_away, "time_left", None)
        seconds = None
        if time_left is not None:
            seconds = (
                int(getattr(time_left, "total_seconds", lambda: 0)())
                if hasattr(time_left, "total_seconds")
                else None
            )
        events.append(LiveEvent(kind="go_away", go_away_seconds=seconds))
    if not events:
        events.append(LiveEvent(kind="other"))
    return events


@asynccontextmanager
async def connect_live(config: OneVoiceLiveConfig, live_config: genai_types.LiveConnectConfig):
    """Open one Gemini Live session on the pinned model/region (ADC only)."""
    client = build_managed_live_client(model=config.model_id, location=config.location)
    async with client.aio.live.connect(model=config.model_id, config=live_config) as session:
        yield GeminiLiveSession(session)
