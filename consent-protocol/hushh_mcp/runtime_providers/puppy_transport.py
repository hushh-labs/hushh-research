"""Authenticated outbound transport to an owner-linked Puppy One model.

The pod remains the agent runtime. Puppy is a bounded inference endpoint: it
receives a neutral request, emits deltas or one result, and cannot invoke tools
or access the pod filesystem. Every request uses a fresh id and accepts frames
for that id only; an interrupted request is failed rather than replayed.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from typing import Any, AsyncIterator

from .base import ProviderTransport
from .normalized import NormalizedChunk, NormalizedFunctionCall, NormalizedResponse
from .translate import NeutralRequest

DEFAULT_TIMEOUT_SECONDS = 120.0
MAX_FRAME_BYTES = 1_048_576


class PuppyRelayUnavailable(RuntimeError):
    """The linked Puppy connection is unavailable or was interrupted."""


class PuppyRelayProtocolError(RuntimeError):
    """Puppy returned a malformed, mismatched, or explicitly failed frame."""


def _env_float(name: str, default: float) -> float:
    try:
        value = float(str(os.getenv(name) or "").strip())
    except ValueError:
        return default
    return value if 1 <= value <= 300 else default


def _messages(request: NeutralRequest) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for message in request.messages:
        item: dict[str, Any] = {"role": message.role}
        if message.text:
            item["text"] = message.text
        if message.tool_name or message.role == "tool":
            item["toolName"] = message.tool_name
            if message.tool_call_id:
                item["toolCallId"] = message.tool_call_id
            if message.role == "assistant":
                item["toolArguments"] = message.tool_arguments or {}
            elif message.role == "tool":
                item["toolResult"] = message.tool_result
        if len(item) > 1:
            result.append(item)
    return result


def _tools(request: NeutralRequest) -> list[dict[str, Any]]:
    return [
        {"name": tool.name, "description": tool.description, "parameters": tool.parameters}
        for tool in request.tools
    ]


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
        return {
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
        async for frame in self._frames(request, model=model):
            if str(frame.get("type") or "") in {"inference.delta", "inference.result"}:
                value = frame.get("text")
                if isinstance(value, str):
                    text.append(value)
                parsed_calls = self._calls(frame.get("functionCalls"))
                if parsed_calls:
                    calls = parsed_calls
        return NormalizedResponse(text="".join(text), function_calls=calls)

    async def _stream(
        self, request: NeutralRequest, *, model: str
    ) -> AsyncIterator[NormalizedChunk]:
        emitted_result = False
        async for frame in self._frames(request, model=model):
            kind = str(frame.get("type") or "")
            if kind in {"inference.delta", "inference.result"}:
                value = frame.get("text")
                if isinstance(value, str) and value:
                    emitted_result = True
                    yield NormalizedChunk(text=value)
            if kind == "inference.done" and not emitted_result:
                value = frame.get("text")
                if isinstance(value, str) and value:
                    yield NormalizedChunk(text=value)
