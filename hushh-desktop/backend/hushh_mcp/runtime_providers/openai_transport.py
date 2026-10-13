"""Native OpenAI-compatible transport adapter.

Serves both OpenAI (native realtime) and Grok/x.ai, which speaks the OpenAI
wire format on its own host. Grok is configured via ``base_url`` so there is
one code path for both.
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator

from .base import ProviderTransport
from .normalized import NormalizedChunk, NormalizedFunctionCall, NormalizedResponse
from .translate import NeutralRequest, NeutralTool

GROK_BASE_URL = "https://api.x.ai/v1"


def _messages(request: NeutralRequest) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    if request.system_instruction:
        messages.append({"role": "system", "content": request.system_instruction})
    for m in request.messages:
        if not m.text:
            continue
        messages.append({"role": m.role, "content": m.text})
    return messages


def _tools(tools: tuple[NeutralTool, ...]) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters or {"type": "object", "properties": {}},
            },
        }
        for tool in tools
    ]


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


class OpenAITransport(ProviderTransport):
    def __init__(self, api_key: str, *, base_url: str | None = None, provider: str = "openai"):
        # Imported lazily so the dependency is only required when this runs.
        from openai import AsyncOpenAI

        self.provider = provider
        if base_url:
            self._client = AsyncOpenAI(api_key=api_key, base_url=base_url)
        else:
            self._client = AsyncOpenAI(api_key=api_key)

    def _request_kwargs(self, request: NeutralRequest, *, model: str) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "model": model,
            "messages": _messages(request),
        }
        if request.temperature is not None:
            kwargs["temperature"] = request.temperature
        if request.max_output_tokens is not None:
            kwargs["max_completion_tokens"] = request.max_output_tokens
        if request.tools:
            kwargs["tools"] = _tools(request.tools)
            kwargs["tool_choice"] = "auto"
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
        return NormalizedResponse(text=text, function_calls=tuple(calls))

    async def _stream(
        self, request: NeutralRequest, *, model: str
    ) -> AsyncIterator[NormalizedChunk]:
        stream = await self._client.chat.completions.create(
            stream=True, **self._request_kwargs(request, model=model)
        )
        async for chunk in stream:
            choices = getattr(chunk, "choices", None) or []
            if not choices:
                continue
            delta = getattr(choices[0], "delta", None)
            text = getattr(delta, "content", None)
            if isinstance(text, str) and text:
                yield NormalizedChunk(text=text)
