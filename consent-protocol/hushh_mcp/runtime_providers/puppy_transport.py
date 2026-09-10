"""Authenticated outbound transport to an owner-linked Puppy One model.

The pod remains the agent runtime. Puppy is a bounded inference endpoint: it
receives a neutral request, emits deltas or one result, and cannot invoke tools
or access the pod filesystem. Every request uses a fresh id and accepts frames
for that id only; an interrupted request is failed rather than replayed.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from typing import Any, AsyncIterator

from .base import ProviderTransport
from .normalized import NormalizedChunk, NormalizedFunctionCall, NormalizedResponse
from .translate import NeutralRequest

DEFAULT_TIMEOUT_SECONDS = 120.0
MAX_FRAME_BYTES = 1_048_576

#: Handed to the websockets client so its frame-level DEBUG output (which would
#: carry prompts and tool results) is never emitted, whatever the root level is.
_WIRE_LOGGER = logging.getLogger("hussh.puppy.wire")
_WIRE_LOGGER.disabled = True
_WIRE_LOGGER.propagate = False


class PuppyRelayUnavailable(RuntimeError):
    """The linked Puppy connection is unavailable or was interrupted."""


class PuppyRelayProtocolError(RuntimeError):
    """Puppy returned a malformed, mismatched, or explicitly failed frame."""


class PuppyCapabilityUnsupported(RuntimeError):
    """The linked device cannot honour a capability this request needs.

    Raised before ``inference.request`` is sent when the admission frame declares
    the device's capabilities and one the request needs is missing, and when the
    device itself answers ``inference.error`` with ``UNSUPPORTED_CAPABILITY``.
    Never a ``PuppyRelayUnavailable`` and never a fallback: the device is fine,
    the request asked for something it does not do, and the caller has to say so.
    """

    def __init__(self, capability: str) -> None:
        super().__init__(f"Puppy device does not support {capability}")
        self.capability = capability


#: The capability names a device may declare, in the Puppy One harness vocabulary
#: (``hermes_cli/hussh_one_routing/profile.py``). Anything else on the wire is
#: ignored rather than trusted.
DEVICE_CAPABILITY_NAMES: tuple[str, ...] = ("tool_calling", "json_schema", "streaming")
UNSUPPORTED_CAPABILITY_CODE = "UNSUPPORTED_CAPABILITY"


def _env_float(name: str, default: float) -> float:
    try:
        value = float(str(os.getenv(name) or "").strip())
    except ValueError:
        return default
    return value if 1 <= value <= 300 else default


def _messages(request: NeutralRequest) -> list[dict[str, Any]]:
    """Flatten the neutral messages, pairing every tool result with a call id.

    ADK keeps client-minted ``adk-*`` function-call ids only for the model
    classes it knows pair by id; for this adapter they are stripped before the
    second model request, so a tool result can arrive here with an empty id.
    An OpenAI-compatible server refuses an unpaired ``tool`` message, which
    would fail every second step of a tool cycle. When the id is missing the
    call receives a deterministic ``call_<n>`` and the next result for the same
    tool name takes the oldest unmatched call id. Ids the runtime did preserve
    pass through untouched.
    """
    result: list[dict[str, Any]] = []
    unmatched_calls: dict[str, list[str]] = {}
    minted = 0
    for message in request.messages:
        item: dict[str, Any] = {"role": message.role}
        if message.text:
            item["text"] = message.text
        if message.tool_name or message.role == "tool":
            item["toolName"] = message.tool_name
            call_id = str(message.tool_call_id or "")
            if message.role == "assistant":
                if not call_id:
                    minted += 1
                    call_id = f"call_{minted}"
                unmatched_calls.setdefault(message.tool_name, []).append(call_id)
                item["toolCallId"] = call_id
                item["toolArguments"] = message.tool_arguments or {}
            elif message.role == "tool":
                pending = unmatched_calls.get(message.tool_name) or []
                if not call_id and pending:
                    call_id = pending.pop(0)
                elif call_id in pending:
                    pending.remove(call_id)
                if call_id:
                    item["toolCallId"] = call_id
                item["toolResult"] = message.tool_result
            elif call_id:
                item["toolCallId"] = call_id
        if len(item) > 1:
            result.append(item)
    return result


def _tools(request: NeutralRequest) -> list[dict[str, Any]]:
    return [
        {"name": tool.name, "description": tool.description, "parameters": tool.parameters}
        for tool in request.tools
    ]


def _response_format(request: NeutralRequest) -> dict[str, Any] | None:
    if request.response_schema is not None:
        return {"type": "json_schema", "jsonSchema": request.response_schema}
    if request.requires_json_schema():
        return {"type": "json"}
    return None


def declared_capabilities(ready: dict[str, Any]) -> dict[str, bool] | None:
    """The device capabilities an admission frame declares, or None when absent.

    Absent means an older relay or device that never said; the request proceeds
    exactly as before and the device is the only judge (negative control). A
    present block is trusted only for the allowlisted names and boolean values.
    """
    device = ready.get("device")
    if not isinstance(device, dict):
        return None
    raw = device.get("capabilities")
    if not isinstance(raw, dict):
        return None
    return {
        name: bool(raw[name])
        for name in DEVICE_CAPABILITY_NAMES
        if name in raw and isinstance(raw[name], bool)
    }


def missing_capability(request: NeutralRequest, capabilities: dict[str, bool] | None) -> str:
    """The first capability the request needs that the device declares it lacks."""
    if capabilities is None:
        return ""
    for name in request.required_capabilities():
        if name in capabilities and not capabilities[name]:
            return name
    return ""


def _reported_model(frame: dict[str, Any]) -> str:
    """The model id a device frame reports, if it reports one it may report."""
    value = frame.get("model")
    if not isinstance(value, str):
        return ""
    value = value.strip()
    if not value or len(value) > 128 or "://" in value or value.startswith("/"):
        return ""
    if any(char.isspace() for char in value):
        return ""
    return value


class PuppyRelayTransport(ProviderTransport):
    provider = "puppy"

    def __init__(
        self,
        api_key: str,
        *,
        relay_url: str | None = None,
        device_id: str | None = None,
        timeout_seconds: float | None = None,
    ) -> None:
        self._token = str(api_key or "").strip()
        self._url = (relay_url or os.getenv("PUPPY_INFERENCE_RELAY_URL") or "").strip()
        self._device_id = (device_id or os.getenv("PUPPY_INFERENCE_DEVICE_ID") or "").strip()
        self._timeout = timeout_seconds or _env_float(
            "PUPPY_INFERENCE_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS
        )
        if not self._token:
            raise ValueError("Puppy relay admission token is required")
        if not self._url.startswith(("wss://", "ws://")):
            raise ValueError("PUPPY_INFERENCE_RELAY_URL must be a ws:// or wss:// URL")
        if not self._device_id:
            raise ValueError("Puppy inference device binding is required")

    def _payload(self, request: NeutralRequest, model: str, request_id: str) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "type": "inference.request",
            "requestId": request_id,
            "deviceId": self._device_id,
            "model": model,
            "messages": _messages(request),
            "systemInstruction": request.system_instruction,
            "temperature": request.temperature,
            "maxOutputTokens": request.max_output_tokens,
            "tools": _tools(request),
        }
        # Only set knobs travel: an absent key means "not asked", which the device
        # can tell apart from "asked for the default".
        response_format = _response_format(request)
        if response_format is not None:
            payload["responseFormat"] = response_format
        if request.tool_choice is not None:
            payload["toolChoice"] = request.tool_choice
        if request.allowed_function_names:
            payload["allowedFunctionNames"] = list(request.allowed_function_names)
        if request.top_p is not None:
            payload["topP"] = request.top_p
        if request.stop_sequences:
            payload["stopSequences"] = list(request.stop_sequences)
        if request.seed is not None:
            payload["seed"] = request.seed
        if request.thinking_budget is not None or request.include_thoughts is not None:
            thinking: dict[str, Any] = {}
            if request.thinking_budget is not None:
                thinking["budgetTokens"] = request.thinking_budget
            if request.include_thoughts is not None:
                thinking["includeThoughts"] = request.include_thoughts
            payload["thinking"] = thinking
        return payload

    async def _connect(self) -> Any:
        try:
            from websockets.asyncio.client import connect

            headers = {
                "Authorization": f"Bearer {self._token}",
                "X-Hussh-Relay-Role": "pod",
            }
            relay_environment = str(
                os.getenv("PUPPY_RELAY_ENV") or os.getenv("HUSHH_DEPLOY_ENV") or ""
            ).strip()
            if relay_environment:
                headers["X-Hussh-Deploy-Env"] = relay_environment
            return await connect(
                self._url,
                additional_headers=headers,
                max_size=MAX_FRAME_BYTES,
                open_timeout=min(self._timeout, 15.0),
                ping_interval=20,
                ping_timeout=20,
                # The library's own debug logger would print every frame, prompt
                # and all, at DEBUG. Wire logging on this socket is off, always.
                logger=_WIRE_LOGGER,
            )
        except Exception as exc:  # noqa: BLE001 - credentials and endpoint are never logged
            raise PuppyRelayUnavailable("Puppy inference connection unavailable") from exc

    @staticmethod
    def _decode(frame: Any) -> dict[str, Any]:
        if isinstance(frame, bytes):
            frame = frame.decode("utf-8", errors="strict")
        if not isinstance(frame, str) or len(frame.encode("utf-8")) > MAX_FRAME_BYTES:
            raise PuppyRelayProtocolError("Puppy returned an invalid frame")
        try:
            value = json.loads(frame)
        except (TypeError, ValueError) as exc:
            raise PuppyRelayProtocolError("Puppy returned malformed data") from exc
        if not isinstance(value, dict):
            raise PuppyRelayProtocolError("Puppy returned an invalid message")
        return value

    @staticmethod
    def _calls(value: Any) -> tuple[NormalizedFunctionCall, ...]:
        calls: list[NormalizedFunctionCall] = []
        for item in value if isinstance(value, list) else []:
            if not isinstance(item, dict) or not str(item.get("name") or "").strip():
                continue
            args = item.get("args")
            calls.append(
                NormalizedFunctionCall(
                    name=str(item["name"]).strip(),
                    args=args if isinstance(args, dict) else {},
                    id=str(item.get("id") or ""),
                )
            )
        return tuple(calls)

    async def _frames(
        self, request: NeutralRequest, *, model: str
    ) -> AsyncIterator[dict[str, Any]]:
        request_id = uuid.uuid4().hex
        socket = await self._connect()
        try:
            await socket.send(
                json.dumps(
                    {"type": "relay.hello", "role": "pod", "deviceId": self._device_id},
                    separators=(",", ":"),
                )
            )
            try:
                async with asyncio.timeout(self._timeout):
                    ready = self._decode(await socket.recv())
            except Exception as exc:  # noqa: BLE001
                raise PuppyRelayUnavailable("Puppy relay admission unavailable") from exc
            if ready.get("type") != "relay.ready":
                raise PuppyRelayUnavailable("Puppy relay admission refused")
            # Refuse BEFORE dispatch. A declared capability gap is answered here,
            # with nothing sent to the device, so the device never spends a
            # cold model load on a request it was going to drop a field from.
            lacking = missing_capability(request, declared_capabilities(ready))
            if lacking:
                raise PuppyCapabilityUnsupported(lacking)
            await socket.send(
                json.dumps(self._payload(request, model, request_id), separators=(",", ":"))
            )
            while True:
                try:
                    async with asyncio.timeout(self._timeout):
                        frame = self._decode(await socket.recv())
                except asyncio.TimeoutError as exc:
                    raise PuppyRelayUnavailable("Puppy inference timed out") from exc
                except PuppyRelayProtocolError:
                    raise
                except Exception as exc:  # noqa: BLE001
                    raise PuppyRelayUnavailable("Puppy inference connection interrupted") from exc
                if str(frame.get("requestId") or "") != request_id:
                    raise PuppyRelayProtocolError("Puppy returned a mismatched request")
                kind = str(frame.get("type") or "")
                if kind == "inference.error":
                    if str(frame.get("code") or "") == UNSUPPORTED_CAPABILITY_CODE:
                        capability = str(frame.get("capability") or "")
                        raise PuppyCapabilityUnsupported(capability or "requested capability")
                    raise PuppyRelayUnavailable("Puppy inference was refused")
                yield frame
                if kind in {"inference.done", "inference.result"}:
                    return
        finally:
            try:
                await socket.close()
            except Exception:  # noqa: BLE001 - connection is already being discarded
                pass

    async def _generate(self, request: NeutralRequest, *, model: str) -> NormalizedResponse:
        text: list[str] = []
        calls: tuple[NormalizedFunctionCall, ...] = ()
        reported = ""
        async for frame in self._frames(request, model=model):
            reported = _reported_model(frame) or reported
            if str(frame.get("type") or "") in {"inference.delta", "inference.result"}:
                value = frame.get("text")
                if isinstance(value, str):
                    text.append(value)
                parsed_calls = self._calls(frame.get("functionCalls"))
                if parsed_calls:
                    calls = parsed_calls
        return NormalizedResponse(text="".join(text), function_calls=calls, model_version=reported)

    async def _stream(
        self, request: NeutralRequest, *, model: str
    ) -> AsyncIterator[NormalizedChunk]:
        emitted_result = False
        reported = ""
        async for frame in self._frames(request, model=model):
            kind = str(frame.get("type") or "")
            reported = _reported_model(frame) or reported
            if kind in {"inference.delta", "inference.result"}:
                value = frame.get("text")
                if isinstance(value, str) and value:
                    emitted_result = True
                    yield NormalizedChunk(
                        text=value,
                        function_calls=self._calls(frame.get("functionCalls")),
                        model_version=reported,
                    )
                else:
                    calls = self._calls(frame.get("functionCalls"))
                    if calls:
                        yield NormalizedChunk(function_calls=calls, model_version=reported)
            if kind == "inference.done" and not emitted_result:
                value = frame.get("text")
                if isinstance(value, str) and value:
                    yield NormalizedChunk(text=value, model_version=reported)
