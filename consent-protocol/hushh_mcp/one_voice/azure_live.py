"""Azure Realtime adapter for the existing, authority-owning VoiceSession relay.

No transcript/tool replay or provider resumption is attempted. Input responses
are explicitly scheduled after their correlated transcription, so asynchronous
transcription arrival cannot approve a tool on a different person's turn.
"""

from __future__ import annotations

import asyncio
import base64
import json
import struct
from collections import OrderedDict, deque
from contextlib import asynccontextmanager
from typing import Any, cast

from google.genai import types
from jsonschema import Draft202012Validator

from hushh_mcp.one_voice.live_client import LiveEvent
from hushh_mcp.one_voice.protocol import MAX_AUDIO_FRAME_BYTES
from hushh_mcp.runtime_providers.azure_adk import _identifier, _instruction, _schema
from hushh_mcp.runtime_providers.managed_azure import ManagedAzureBinding

MAX_PCM_FRAME_BYTES = 32_000
MAX_PENDING_INPUTS = 8
MAX_TOOL_ARGUMENT_BYTES = 256 * 1024
MAX_TOOL_CALLS = 32


class Pcm16Resampler:
    """Stateful 16→24 kHz linear interpolation, independent of frame boundaries."""

    def __init__(self):
        self.samples: list[int] = []
        self.phase = 0

    def push(self, pcm: bytes) -> bytes:
        if len(pcm) % 2 or len(pcm) > MAX_PCM_FRAME_BYTES:
            raise ValueError("Invalid Live PCM16 input frame")
        self.samples.extend(sample[0] for sample in struct.iter_unpack("<h", pcm))
        output: list[int] = []
        while self.phase // 3 + 1 < len(self.samples):
            index, fraction = divmod(self.phase, 3)
            value = (self.samples[index] * (3 - fraction) + self.samples[index + 1] * fraction) / 3
            output.append(round(value))
            self.phase += 2
        consumed = self.phase // 3
        self.samples = self.samples[consumed:]
        self.phase -= consumed * 3
        return struct.pack(f"<{len(output)}h", *output)


def azure_session_config(binding: ManagedAzureBinding, config: types.LiveConnectConfig) -> dict:
    functions = []
    for tool in config.tools or []:
        if not isinstance(tool, types.Tool) or set(tool.model_dump(exclude_none=True)) != {
            "function_declarations"
        }:
            raise ValueError("Unsupported Azure Live tool contract")
        for function in tool.function_declarations or []:
            functions.append(
                {
                    "type": "function",
                    "name": function.name,
                    "description": function.description or "",
                    "parameters": _schema(
                        function.parameters_json_schema
                        or function.parameters
                        or {"type": "object", "properties": {}},
                        strict=False,
                    ),
                }
            )
    if len({item["name"] for item in functions}) != len(functions):
        raise ValueError("Duplicate Azure Live tool name")
    return {
        "type": "realtime",
        "instructions": _instruction(config.system_instruction),
        "output_modalities": ["audio"],
        "tools": functions,
        "tool_choice": "auto",
        "audio": {
            "input": {
                "format": {"type": "audio/pcm", "rate": 24000},
                "transcription": {"model": binding.deployment("transcription")},
                "turn_detection": {
                    "type": "server_vad",
                    "create_response": False,
                    "interrupt_response": False,
                },
            },
            "output": {
                "voice": binding.capabilities["voice"],
                "format": {"type": "audio/pcm", "rate": 24000},
            },
        },
    }


class AzureLiveSession:
    def __init__(
        self,
        connection: Any,
        binding: ManagedAzureBinding,
        config: dict,
        *,
        playback_acknowledgements: bool = False,
    ):
        self.connection, self.binding = connection, binding
        self.playback_acknowledgements = playback_acknowledgements
        self.resampler = Pcm16Resampler()
        self.tools = {item["name"]: item for item in config["tools"]}
        self.inputs: OrderedDict[str, dict] = OrderedDict()
        self.completed_inputs: deque[str] = deque(maxlen=256)
        self.response_id: str | None = None
        self.pending_calls: OrderedDict[str, dict] = OrderedDict()
        self.cancelled_calls: deque[str] = deque(maxlen=256)
        self.response_complete = False
        self.continuation_sent = False
        self.audio_items: OrderedDict[str, dict] = OrderedDict()
        self.audio_item: str | None = None
        self.output_text: dict[str, str] = {}
        self._send_lock = asyncio.Lock()
        self._awaiting_transcript_at: float | None = None
        self._latest_input: str | None = None
        self._cancelled_responses: deque[str] = deque(maxlen=256)
        self._response_requested = False
        self._queued_response = False
        self._cancel_requested_response = False
        self._cancelling_response: str | None = None
        self._interruption_generation = 0

    async def _request_response(self):
        self.binding.require_current()
        if (
            self.response_id
            or self._response_requested
            or self._cancelling_response
            or any(not c.get("settled") for c in self.pending_calls.values())
        ):
            self._queued_response = True
            return
        self._response_requested = True
        self._queued_response = False
        await self.connection.response.create()

    async def send_audio(self, pcm16_b64: str) -> None:
        self.binding.require_current()
        pcm = base64.b64decode(pcm16_b64, validate=True)
        if len(pcm) % 2 or len(pcm) > MAX_AUDIO_FRAME_BYTES:
            raise ValueError("Invalid Live PCM16 input frame")
        # Preserve the public frame bound for buffered/older clients while
        # keeping each resampling and provider append operation bounded.
        for offset in range(0, len(pcm), MAX_PCM_FRAME_BYTES):
            self.binding.require_current()
            converted = self.resampler.push(pcm[offset : offset + MAX_PCM_FRAME_BYTES])
            if converted:
                await self.connection.input_audio_buffer.append(
                    audio=base64.b64encode(converted).decode("ascii")
                )

    async def send_audio_stream_end(self) -> None:
        # Server VAD owns commits. An explicit commit after every client endpoint
        # would create duplicate/empty input items and break transcript correlation.
        self.binding.require_current()

    async def send_text(self, text: str) -> None:
        self._latest_input = None
        await self._send_text(text)

    async def _send_text(self, text: str) -> None:
        self.binding.require_current()
        async with self._send_lock:
            self.binding.require_current()
            generation = self._interruption_generation
            await self.connection.conversation.item.create(
                item={
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": text}],
                }
            )
            if generation == self._interruption_generation:
                await self._request_response()

    async def send_event(self, text: str) -> None:
        await self._send_text(text)

    async def send_tool_response(self, *, call_id: str | None, name: str, response: dict) -> None:
        self.binding.require_current()
        if call_id in self.cancelled_calls:
            return  # An explicit cancellation cannot restart a superseded turn.
        call = self.pending_calls.get(call_id or "")
        if call is None or call["name"] != name or call.get("settled"):
            raise ValueError("Unmatched Azure Live function result")
        encoded = json.dumps(response, ensure_ascii=False, allow_nan=False)
        if len(encoded.encode()) > MAX_TOOL_ARGUMENT_BYTES:
            raise ValueError("Azure Live function result exceeds bounds")
        async with self._send_lock:
            self.binding.require_current()
            if call_id in self.cancelled_calls:
                return
            if self.pending_calls.get(call_id or "") is not call or call.get("settled"):
                raise ValueError("Azure Live function authority changed")
            await self.connection.conversation.item.create(
                item={"type": "function_call_output", "call_id": call_id, "output": encoded}
            )
            call["settled"] = True
            if (
                self.response_complete
                and all(item.get("settled") for item in self.pending_calls.values())
                and not self.continuation_sent
            ):
                self.continuation_sent = True
                await self._request_response()

    async def acknowledge_playback(self, item_id: str, played_ms: int) -> None:
        self.binding.require_current()
        item = self.audio_items.get(item_id)
        if item is None or played_ms < item["played_ms"] or played_ms * 48 > item["bytes"]:
            raise ValueError("Unmatched Azure Live playback position")
        item["played_ms"] = played_ms
        item["playback_acknowledged"] = True

    async def interrupt(self) -> None:
        self.binding.require_current()
        self._latest_input = None
        await self._cancel_fenced(self._fence_interruption())

    def _fence_interruption(self):
        """Capture only the superseded generation before yielding to the relay."""
        self._interruption_generation += 1
        response_id = self.response_id
        if response_id is not None:
            self._cancelled_responses.append(response_id)
            self._cancelling_response = response_id
            self.response_id = None
        elif self._response_requested:
            self._cancel_requested_response = True
        audio_item = self.audio_item
        self.audio_item = None
        self.cancelled_calls.extend(self.pending_calls)
        self.pending_calls.clear()
        self.response_complete = False
        self.continuation_sent = False
        self._queued_response = False
        return response_id, audio_item

    async def _cancel_fenced(self, captured):
        response_id, audio_item = captured
        async with self._send_lock:
            self.binding.require_current()
            if response_id is not None:
                await self.connection.response.cancel(response_id=response_id)
            # Truncate using the last actual player-clock acknowledgement, never
            # sent bytes. A missing acknowledgement conservatively means zero.
            if audio_item is not None:
                item = self.audio_items[audio_item]
                # A later utterance still fences tools and in-flight output,
                # but must not erase the transcript of a completed, heard item.
                # PCM16 at 24 kHz is 48 bytes/ms; acknowledgements cannot express
                # the fractional millisecond at the end of an audio item.
                if (
                    item.get("completed")
                    and item.get("playback_acknowledged")
                    and item["played_ms"] >= item["bytes"] // 48
                ):
                    return
                await self.connection.conversation.item.truncate(
                    item_id=audio_item,
                    content_index=item["content_index"],
                    audio_end_ms=item["played_ms"],
                )

    def _input(self, item_id: str) -> dict:
        if not item_id or len(item_id) > 128:
            raise ValueError("Invalid Azure Live input identity")
        if item_id not in self.inputs:
            if len(self.inputs) >= MAX_PENDING_INPUTS:
                raise ValueError("Azure Live input backlog exceeded")
            self.inputs[item_id] = {"stopped": False, "stopped_at": None, "text": None}
        return self.inputs[item_id]

    async def events(self):
        iterator = self.connection.__aiter__()
        try:
            while True:
                # Missing transcription is a failed provider turn, never an
                # invitation to execute tools using an older transcript.
                if self._awaiting_transcript_at is None:
                    event = await anext(iterator)
                else:
                    remaining = 15 - (
                        asyncio.get_running_loop().time() - self._awaiting_transcript_at
                    )
                    if remaining <= 0:
                        raise TimeoutError("Azure Live transcription deadline exceeded")
                    async with asyncio.timeout(remaining):
                        event = await anext(iterator)
                self.binding.require_current()
                kind = event.type
                event_response = getattr(event, "response_id", None) or getattr(
                    getattr(event, "response", None), "id", None
                )
                if event_response in self._cancelled_responses:
                    if kind == "response.done" and event_response == self._cancelling_response:
                        self._cancelling_response = None
                        if self._queued_response:
                            await self._request_response()
                    continue
                if (
                    kind
                    in {
                        "input_audio_buffer.speech_started",
                        "input_audio_buffer.speech_stopped",
                        "conversation.item.input_audio_transcription.completed",
                    }
                    and event.item_id in self.completed_inputs
                ):
                    continue
                if kind == "session.updated":
                    yield LiveEvent(kind="setup_complete")
                elif kind == "input_audio_buffer.speech_started":
                    self._input(event.item_id)
                    self._latest_input = event.item_id
                    cancelled = list(self.pending_calls)
                    captured = self._fence_interruption()
                    # Fence relay input authority before network cancellation
                    # can wait behind a tool-result send or provider I/O.
                    yield LiveEvent(kind="interrupted")
                    if cancelled:
                        yield LiveEvent(kind="tool_cancel", cancelled_ids=cancelled)
                    yield LiveEvent(
                        kind="activity_start",
                        activity_source="voice_activity",
                        input_item_id=event.item_id,
                    )
                    await self._cancel_fenced(captured)
                elif kind == "input_audio_buffer.speech_stopped":
                    self._input(event.item_id)["stopped"] = True
                    self.inputs[event.item_id]["stopped_at"] = (
                        self.inputs[event.item_id]["stopped_at"]
                        or asyncio.get_running_loop().time()
                    )
                    self._awaiting_transcript_at = (
                        self._awaiting_transcript_at or asyncio.get_running_loop().time()
                    )
                    yield LiveEvent(
                        kind="activity_end",
                        activity_source="voice_activity",
                        input_item_id=event.item_id,
                    )
                elif kind == "conversation.item.input_audio_transcription.completed":
                    if not isinstance(event.transcript, str) or len(event.transcript) > 4096:
                        raise ValueError("Invalid Azure Live transcript")
                    self._input(event.item_id)["text"] = event.transcript
                elif kind == "conversation.item.input_audio_transcription.failed":
                    raise RuntimeError("Azure Live transcription failed")
                elif kind == "response.created":
                    self._response_requested = False
                    if self._cancel_requested_response:
                        self._cancel_requested_response = False
                        self._cancelled_responses.append(event.response.id)
                        self._cancelling_response = event.response.id
                        await self.connection.response.cancel(response_id=event.response.id)
                        continue
                    self.response_id = event.response.id
                    self.response_complete = False
                    self.continuation_sent = False
                    if any(not call.get("settled") for call in self.pending_calls.values()):
                        raise ValueError("Azure Live response preceded tool settlement")
                    self.pending_calls.clear()
                elif kind == "response.output_audio.delta":
                    raw = base64.b64decode(event.delta, validate=True)
                    if not raw or len(raw) % 2 or len(raw) > 1024 * 1024:
                        raise ValueError("Invalid Azure Live output audio")
                    item = self.audio_items.setdefault(
                        event.item_id,
                        {
                            "response_id": event_response,
                            "content_index": event.content_index,
                            "bytes": 0,
                            "played_ms": 0,
                            "playback_acknowledged": False,
                            "completed": False,
                        },
                    )
                    if (
                        item["content_index"] != event.content_index
                        or item["response_id"] != event_response
                        or item["completed"]
                    ):
                        raise ValueError("Azure Live audio item changed output identity")
                    item["bytes"] += len(raw)
                    if item["bytes"] > 24_000 * 2 * 120:
                        raise ValueError("Azure Live response audio exceeds bounds")
                    self.audio_item = event.item_id
                    while len(self.audio_items) > 128:
                        self.audio_items.popitem(last=False)
                    yield LiveEvent(
                        kind="audio", audio_b64=event.delta, audio_item_id=event.item_id
                    )
                elif kind == "response.output_audio_transcript.delta":
                    self.output_text[event.item_id] = (
                        self.output_text.get(event.item_id, "") + event.delta
                    )
                    if (
                        len(self.output_text[event.item_id]) > 100_000
                        or len(self.output_text) > 128
                    ):
                        raise ValueError("Azure Live output transcript exceeds bounds")
                    yield LiveEvent(kind="output_transcript", text=event.delta, finished=False)
                elif kind == "response.output_audio_transcript.done":
                    if self.output_text.pop(event.item_id, "") != event.transcript:
                        raise ValueError("Azure Live output transcript changed")
                    yield LiveEvent(kind="output_transcript", text=event.transcript, finished=True)
                elif kind == "response.output_item.done" and event.item.type == "function_call":
                    item = event.item
                    if (
                        item.call_id in self.pending_calls
                        or item.name not in self.tools
                        or len(self.pending_calls) >= MAX_TOOL_CALLS
                        or len(item.arguments.encode()) > MAX_TOOL_ARGUMENT_BYTES
                        or len(item.arguments.encode())
                        + sum(call["argument_bytes"] for call in self.pending_calls.values())
                        > MAX_TOOL_ARGUMENT_BYTES
                    ):
                        raise ValueError("Invalid Azure Live function call")
                    _identifier(item.call_id)
                    args = json.loads(item.arguments)
                    if not isinstance(args, dict):
                        raise ValueError("Azure Live function arguments require an object")
                    json.dumps(args, allow_nan=False)
                    Draft202012Validator(self.tools[item.name]["parameters"]).validate(args)
                    self.pending_calls[item.call_id] = {
                        "id": item.call_id,
                        "name": item.name,
                        "args": args,
                        "argument_bytes": len(item.arguments.encode()),
                    }
                elif kind == "response.done":
                    self.response_id = None
                    if event.response.status == "completed":
                        for item in self.audio_items.values():
                            if item["response_id"] == event.response.id:
                                item["completed"] = True
                    if event.response.status == "completed" and not self.playback_acknowledgements:
                        # Legacy clients cannot report playback. Retain completed
                        # generated turns for ordinary follow-ups, without claiming
                        # they were heard. Only in-flight interruption uses zero.
                        self.audio_item = None
                    if event.response.status == "cancelled":
                        yield LiveEvent(kind="interrupted")
                    elif event.response.status != "completed":
                        raise RuntimeError("Azure Live response did not complete")
                    elif self.pending_calls:
                        self.response_complete = True
                        yield LiveEvent(
                            kind="tool_call",
                            function_calls=[
                                {key: call[key] for key in ("id", "name", "args")}
                                for call in self.pending_calls.values()
                            ],
                        )
                    else:
                        yield LiveEvent(kind="turn_complete")
                        if self._queued_response:
                            self._queued_response = False
                            await self._request_response()
                elif kind == "error":
                    raise RuntimeError("Azure Live provider rejected the operation")
                # Process captures in their provider item order, independent of
                # asynchronous transcription arrival order. No auto response can
                # race ahead of these observed final input events.
                ready = [
                    (item_id, item["text"])
                    for item_id, item in self.inputs.items()
                    if item["stopped"] and item["text"] is not None
                ]
                for item_id, text in ready:
                    self.inputs.pop(item_id)
                    self.completed_inputs.append(item_id)
                    if text.strip():
                        yield LiveEvent(
                            kind="input_transcript", text=text, finished=True, input_item_id=item_id
                        )
                        if item_id == self._latest_input:
                            await self._request_response()
                deadlines = [
                    item["stopped_at"]
                    for item in self.inputs.values()
                    if item["stopped_at"] is not None
                ]
                self._awaiting_transcript_at = min(deadlines) if deadlines else None
        except StopAsyncIteration:
            return


@asynccontextmanager
async def connect_azure_live(
    config: types.LiveConnectConfig,
    *,
    binding=None,
    client_factory=None,
    playback_acknowledgements: bool = False,
):
    binding = binding or ManagedAzureBinding.from_environment()
    if binding is None:
        raise RuntimeError("Azure Live is not the selected managed processor")
    session = azure_session_config(binding, config)
    binding.require_current()
    async with asyncio.timeout(5):
        token = await asyncio.to_thread(binding.token_supplier)
    binding.require_current()
    from openai import AsyncOpenAI
    from openai.types.realtime.realtime_session_create_request_param import (
        RealtimeSessionCreateRequestParam,
    )

    async with (client_factory or AsyncOpenAI)(
        base_url=binding.endpoint,
        websocket_base_url=binding.endpoint.replace("https://", "wss://", 1),
        api_key=token,
        max_retries=0,
        timeout=30,
    ) as client:
        async with client.realtime.connect(model=binding.deployment("realtime")) as connection:
            await connection.session.update(
                session=cast(RealtimeSessionCreateRequestParam, session)
            )
            yield AzureLiveSession(
                connection, binding, session, playback_acknowledgements=playback_acknowledgements
            )
