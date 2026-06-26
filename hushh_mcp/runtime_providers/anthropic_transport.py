"""Native Anthropic transport adapter (chained-only voice; no native realtime)."""

from __future__ import annotations

from typing import Any, AsyncIterator

from .base import ProviderTransport
from .normalized import NormalizedChunk, NormalizedFunctionCall, NormalizedResponse
from .translate import NeutralRequest, NeutralTool

_DEFAULT_MAX_TOKENS = 4096


def _messages(request: NeutralRequest) -> list[dict[str, Any]]:
    return [{"role": m.role, "content": m.text} for m in request.messages if m.text]


def _tools(tools: tuple[NeutralTool, ...]) -> list[dict[str, Any]]:
    return [
        {
            "name": tool.name,
            "description": tool.description,
            "input_schema": tool.parameters or {"type": "object", "properties": {}},
        }
        for tool in tools
    ]


class AnthropicTransport(ProviderTransport):
    provider = "anthropic"

    def __init__(self, api_key: str):
        # Imported lazily so the dependency is only required when Anthropic runs.
        from anthropic import AsyncAnthropic

        self._client = AsyncAnthropic(api_key=api_key)

    def _request_kwargs(self, request: NeutralRequest, *, model: str) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "model": model,
            "max_tokens": request.max_output_tokens or _DEFAULT_MAX_TOKENS,
            "messages": _messages(request),
        }
        if request.system_instruction:
            kwargs["system"] = request.system_instruction
        if request.temperature is not None:
            kwargs["temperature"] = request.temperature
        if request.tools:
            kwargs["tools"] = _tools(request.tools)
        return kwargs

    async def _generate(self, request: NeutralRequest, *, model: str) -> NormalizedResponse:
        message = await self._client.messages.create(**self._request_kwargs(request, model=model))
        text_parts: list[str] = []
        calls: list[NormalizedFunctionCall] = []
        for block in getattr(message, "content", None) or []:
            block_type = getattr(block, "type", None)
            if block_type == "text":
                text = getattr(block, "text", None)
                if isinstance(text, str) and text:
                    text_parts.append(text)
            elif block_type == "tool_use":
                calls.append(
                    NormalizedFunctionCall(
                        name=str(getattr(block, "name", "") or ""),
                        args=dict(getattr(block, "input", None) or {}),
                        id=str(getattr(block, "id", "") or ""),
                    )
                )
        return NormalizedResponse(text="".join(text_parts), function_calls=tuple(calls))

    async def _stream(
        self, request: NeutralRequest, *, model: str
    ) -> AsyncIterator[NormalizedChunk]:
        async with self._client.messages.stream(
            **self._request_kwargs(request, model=model)
        ) as stream:
            async for text in stream.text_stream:
                if text:
                    yield NormalizedChunk(text=text)
