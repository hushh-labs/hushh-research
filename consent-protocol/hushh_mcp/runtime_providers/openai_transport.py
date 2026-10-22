"""Native OpenAI-compatible transport adapter.

Serves OpenAI (native realtime), Grok/x.ai and the person's own Azure OpenAI
deployment, which all speak the OpenAI wire format on their own host. The host is
configured via ``base_url`` so there is one code path for all three.

The credential is either a static API key or a refreshing bearer-token provider
(a callable returning a token), never both. The provider is asked once per request,
so a workload token that rotates is always current; caching belongs to the provider.
"""

from __future__ import annotations

import asyncio
import base64
import datetime
import json
import re
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Awaitable, Callable

from .base import ProviderTransport
from .normalized import NormalizedChunk, NormalizedFunctionCall, NormalizedResponse
from .translate import NeutralMessage, NeutralRequest, NeutralTool


def _json_default(value: Any) -> Any:
    """What genai would carry for a non-JSON tool value: ISO dates, base64 bytes, else text."""
    if isinstance(value, (datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, (bytes, bytearray)):
        return base64.b64encode(bytes(value)).decode("ascii")
    if isinstance(value, (set, frozenset)):
        return sorted(value, key=str)
    return str(value)


def tool_json(value: Any) -> str:
    """A tool's arguments or result on the wire. A memory recall carries datetimes:
    plain ``json.dumps`` raised TypeError and ended the first live Azure tool turn."""
    return json.dumps(value, separators=(",", ":"), default=_json_default)


GROK_BASE_URL = "https://api.x.ai/v1"

TokenProvider = Callable[[], str]


class BearerTokenUnavailable(RuntimeError):
    """The token provider returned no usable access token."""


def _tool_call(m: NeutralMessage) -> dict[str, Any]:
    return {
        "id": m.tool_call_id or f"call_{m.tool_name}",
        "type": "function",
        "function": {
            "name": m.tool_name,
            "arguments": tool_json(m.tool_arguments or {}),
        },
    }


def _join_assistant(messages: list[dict[str, Any]], m: NeutralMessage) -> bool:
    """Fold a tool call, or its narration, into the assistant message it belongs to.

    The OpenAI wire format wants ONE assistant message per model turn, carrying every
    tool call of that turn, followed by one tool message per call. The neutral request
    flattens a model turn into one entry per call plus one for its text, so a turn that
    narrated ("let me check") or called two tools at once reached the wire as
    consecutive assistant messages, which the API refuses with a 400.
    """
    last = messages[-1] if messages else None
    if last is None or last.get("role") != "assistant":
        return False
    if m.tool_name:
        last.setdefault("tool_calls", []).append(_tool_call(m))
        return True
    if last.get("tool_calls") and not last.get("content"):
        last["content"] = m.text
        return True
    return False


def _messages(request: NeutralRequest) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    if request.system_instruction:
        messages.append({"role": "system", "content": request.system_instruction})
    for m in request.messages:
        if m.role == "assistant" and (m.tool_name or m.text) and _join_assistant(messages, m):
            continue
        if m.tool_name and m.role == "assistant":
            messages.append(
                {"role": "assistant", "content": m.text or None, "tool_calls": [_tool_call(m)]}
            )
        elif m.role == "tool" and (m.tool_name or m.tool_call_id):
            messages.append(
                {
                    "role": "tool",
                    # Paired with the assistant entry's fallback id above, so a call the
                    # provider sent without an id still finds its result.
                    "tool_call_id": m.tool_call_id or f"call_{m.tool_name}",
                    "content": tool_json(m.tool_result),
                }
            )
        elif m.text:
            messages.append({"role": m.role, "content": m.text})
    return messages


def _tools(tools: tuple[NeutralTool, ...]) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.json_schema
                or tool.parameters
                or {"type": "object", "properties": {}},
            },
        }
        for tool in tools
    ]


_SCHEMA_NAME_UNSAFE = re.compile(r"[^A-Za-z0-9_-]+")


def _schema_name(schema: dict[str, Any]) -> str:
    """The wire format's ``json_schema.name``: 1-64 of ``[A-Za-z0-9_-]``."""
    cleaned = _SCHEMA_NAME_UNSAFE.sub("_", str(schema.get("title") or "")).strip("_")
    return cleaned[:64] or "response"


def _parse_args(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def _refreshing_bearer(token_provider: TokenProvider) -> Callable[[], Awaitable[str]]:
    """Adapt a blocking token provider to the SDK's per-request async credential hook."""

    async def bearer() -> str:
        token = await asyncio.to_thread(token_provider)
        if not isinstance(token, str) or not token.strip():
            raise BearerTokenUnavailable("the token provider returned no access token")
        return token.strip()

    return bearer


def _credential(api_key: str, token_provider: TokenProvider | None) -> Any:
    if token_provider is None:
        if not str(api_key or "").strip():
            raise ValueError("an OpenAI-compatible transport needs an API key or a token provider")
        return api_key
    if str(api_key or "").strip():
        raise ValueError("pass an API key or a token provider, never both")
    return _refreshing_bearer(token_provider)


@dataclass
class _ToolCallFragments:
    id: str = ""
    name: str = ""
    arguments: list[str] = field(default_factory=list)


class _StreamedToolCalls:
    """Assembles streamed ``tool_calls`` deltas, keyed by their ``index``.

    The first delta of a call carries its id and name; later deltas carry argument
    fragments only. A call is complete only when the stream ends.
    """

    def __init__(self) -> None:
        self._calls: dict[int, _ToolCallFragments] = {}

    def add(self, deltas: Any) -> None:
        for position, delta in enumerate(deltas or ()):
            index = getattr(delta, "index", None)
            key = index if isinstance(index, int) and not isinstance(index, bool) else position
            call = self._calls.setdefault(key, _ToolCallFragments())
            call_id = getattr(delta, "id", None)
            if isinstance(call_id, str) and call_id and not call.id:
                call.id = call_id
            function = getattr(delta, "function", None)
            name = getattr(function, "name", None)
            if isinstance(name, str) and name and not call.name:
                call.name = name
            arguments = getattr(function, "arguments", None)
            if isinstance(arguments, str) and arguments:
                call.arguments.append(arguments)

    def assemble(self) -> tuple[NormalizedFunctionCall, ...]:
        return tuple(
            NormalizedFunctionCall(
                name=call.name, args=_parse_args("".join(call.arguments)), id=call.id
            )
            for _, call in sorted(self._calls.items())
            if call.name
        )


class OpenAITransport(ProviderTransport):
    def __init__(
        self,
        api_key: str = "",
        *,
        base_url: str | None = None,
        provider: str = "openai",
        token_provider: TokenProvider | None = None,
        http_client: Any = None,
        send_sampling_controls: bool = True,
    ):
        # Imported lazily so the dependency is only required when this runs.
        from openai import AsyncOpenAI

        self.provider = provider
        self._send_sampling_controls = send_sampling_controls
        client_kwargs: dict[str, Any] = {"api_key": _credential(api_key, token_provider)}
        if base_url:
            client_kwargs["base_url"] = base_url
        if http_client is not None:
            client_kwargs["http_client"] = http_client
        self._client = AsyncOpenAI(**client_kwargs)

    def _request_kwargs(self, request: NeutralRequest, *, model: str) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "model": model,
            "messages": _messages(request),
        }
        if request.temperature is not None and self._send_sampling_controls:
            kwargs["temperature"] = request.temperature
        if request.max_output_tokens is not None:
            kwargs["max_completion_tokens"] = request.max_output_tokens
        if request.tools:
            kwargs["tools"] = _tools(request.tools)
            kwargs["tool_choice"] = "auto"
        if request.response_schema is not None:
            # A schema the agent asked for is sent, never silently dropped: an
            # unconstrained answer looks right and is not the one requested.
            # Non-strict, because strict mode refuses optional properties and
            # ``default`` keywords that ordinary pydantic schemas carry.
            kwargs["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": _schema_name(request.response_schema),
                    "schema": request.response_schema,
                    "strict": False,
                },
            }
        return kwargs

    async def _generate(self, request: NeutralRequest, *, model: str) -> NormalizedResponse:
        completion = await self._client.chat.completions.create(
            **self._request_kwargs(request, model=model)
        )
        choices = getattr(completion, "choices", None) or []
        if not choices:
            return NormalizedResponse()
        message = getattr(choices[0], "message", None)
        text = str(getattr(message, "content", "") or "")
        calls: list[NormalizedFunctionCall] = []
        for tool_call in getattr(message, "tool_calls", None) or []:
            function = getattr(tool_call, "function", None)
            name = str(getattr(function, "name", "") or "")
            if not name:
                continue
            calls.append(
                NormalizedFunctionCall(
                    name=name,
                    args=_parse_args(getattr(function, "arguments", None)),
                    id=str(getattr(tool_call, "id", "") or ""),
                )
            )
        return NormalizedResponse(
            text=text,
            function_calls=tuple(calls),
            model_version=str(getattr(completion, "model", "") or ""),
        )

    async def _stream(
        self, request: NeutralRequest, *, model: str
    ) -> AsyncIterator[NormalizedChunk]:
        stream = await self._client.chat.completions.create(
            stream=True, **self._request_kwargs(request, model=model)
        )
        tool_calls = _StreamedToolCalls()
        reported = ""
        async for chunk in stream:
            reported = reported or str(getattr(chunk, "model", "") or "")
            choices = getattr(chunk, "choices", None) or []
            if not choices:
                continue
            delta = getattr(choices[0], "delta", None)
            tool_calls.add(getattr(delta, "tool_calls", None))
            text = getattr(delta, "content", None)
            if isinstance(text, str) and text:
                yield NormalizedChunk(text=text, model_version=reported)
        calls = tool_calls.assemble()
        if calls:
            yield NormalizedChunk(function_calls=calls, model_version=reported)
