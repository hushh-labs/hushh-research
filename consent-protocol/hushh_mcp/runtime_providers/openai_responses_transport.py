"""OpenAI Responses API transport: tools WITH reasoning, for the person's Azure OpenAI.

WHY A SECOND OPENAI-WIRE TRANSPORT
GPT-6 and GPT-5.6 models cannot combine function tools with reasoning on Chat
Completions. They default to ``medium`` effort, so a Chat Completions request that
merely carries ``tools`` is refused ("Function tools with reasoning_effort are not
supported ... use /v1/responses or set reasoning_effort to 'none'"; measured 26 of
26 on ``gpt-6-luna``, 2026-10-03). Microsoft's recommended path is the Responses
API, which supports each model's full reasoning range with tools
(learn.microsoft.com/azure/foundry/openai/how-to/reasoning, "Tool calling with
reasoning models"). Every Azure OpenAI chat model in that table supports it.

STATELESS, ALWAYS
``store`` is ``False`` on every request: nothing a person says is kept by the model
host between calls. Reasoning items come back encrypted and are not replayed in this
version, so each step of a tool loop reasons afresh. That is correct, only less
token-efficient; carrying them is a later, measured change.

THE REQUEST, FROM THE NEUTRAL SHAPE
* system instruction -> ``instructions``
* user / assistant text -> input messages
* an assistant tool call -> a ``function_call`` item; its result -> a
  ``function_call_output`` item, paired by ``call_id`` (no item ids, which would
  reference stored items that stateless mode never kept)
* tools -> Responses function tools (non-strict: ordinary pydantic schemas carry
  ``default`` and optional fields that strict mode refuses)
* response schema -> ``text.format`` json_schema (non-strict, never dropped)
* thinking level (Gemini's LOW/MEDIUM/HIGH) -> ``reasoning.effort``, only when the
  agent asked for one; the model's own default otherwise

Usage (input, cached, output and reasoning tokens) is returned on the final chunk so
an owner-cloud pod can account for its own model spend.
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator

from .base import ProviderTransport
from .normalized import (
    NormalizedChunk,
    NormalizedFunctionCall,
    NormalizedResponse,
    NormalizedUsage,
)
from .openai_transport import TokenProvider, _credential, _parse_args, _schema_name
from .translate import NeutralMessage, NeutralRequest, NeutralTool

#: The efforts a neutral thinking level may become. ``none`` is never inferred:
#: some models refuse it, so it is sent only when the agent names it explicitly.
_EFFORTS = {"none", "minimal", "low", "medium", "high", "xhigh", "max"}


def _call_id(m: NeutralMessage) -> str:
    return m.tool_call_id or f"call_{m.tool_name}"


def _input_items(request: NeutralRequest) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for m in request.messages:
        if m.role == "assistant" and m.tool_name:
            items.append(
                {
                    "type": "function_call",
                    "call_id": _call_id(m),
                    "name": m.tool_name,
                    "arguments": json.dumps(m.tool_arguments or {}, separators=(",", ":")),
                }
            )
        elif m.role == "tool" and (m.tool_name or m.tool_call_id):
            items.append(
                {
                    "type": "function_call_output",
                    "call_id": _call_id(m),
                    "output": json.dumps(m.tool_result, separators=(",", ":")),
                }
            )
        elif m.text and m.role in {"user", "assistant"}:
            items.append({"role": m.role, "content": m.text})
    return items


def _tools(tools: tuple[NeutralTool, ...]) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.json_schema
            or tool.parameters
            or {"type": "object", "properties": {}},
            "strict": False,
        }
        for tool in tools
    ]


def reasoning_effort(request: NeutralRequest) -> str | None:
    """The effort the agent asked for, in Responses vocabulary, or None for the default."""
    level = str(request.thinking_level or "").strip().lower()
    if level in _EFFORTS:
        return level
    if request.thinking_budget == 0:
        # Gemini's "no thinking" budget: the explicit way an agent turns reasoning off.
        return "none"
    return None


def _usage(raw: Any) -> NormalizedUsage | None:
    if raw is None:
        return None
    input_details = getattr(raw, "input_tokens_details", None)
    output_details = getattr(raw, "output_tokens_details", None)
    return NormalizedUsage(
        input_tokens=int(getattr(raw, "input_tokens", 0) or 0),
        output_tokens=int(getattr(raw, "output_tokens", 0) or 0),
        cached_input_tokens=int(getattr(input_details, "cached_tokens", 0) or 0),
        reasoning_tokens=int(getattr(output_details, "reasoning_tokens", 0) or 0),
    )


def _function_call(item: Any) -> NormalizedFunctionCall | None:
    if getattr(item, "type", None) != "function_call":
        return None
    name = str(getattr(item, "name", "") or "")
    if not name:
        return None
    return NormalizedFunctionCall(
        name=name,
        args=_parse_args(getattr(item, "arguments", None)),
        id=str(getattr(item, "call_id", "") or ""),
    )


def _output_text(response: Any) -> str:
    chunks: list[str] = []
    for item in getattr(response, "output", None) or []:
        if getattr(item, "type", None) != "message":
            continue
        for part in getattr(item, "content", None) or []:
            text = getattr(part, "text", None)
            if getattr(part, "type", None) == "output_text" and isinstance(text, str):
                chunks.append(text)
    return "".join(chunks)


class OpenAIResponsesTransport(ProviderTransport):
    """The Responses API over an OpenAI-wire host (the person's Azure OpenAI)."""

    def __init__(
        self,
        api_key: str = "",
        *,
        base_url: str | None = None,
        provider: str = "openai",
        token_provider: TokenProvider | None = None,
        http_client: Any = None,
    ):
        from openai import AsyncOpenAI  # noqa: PLC0415 - only needed when this runs

        self.provider = provider
        client_kwargs: dict[str, Any] = {"api_key": _credential(api_key, token_provider)}
        if base_url:
            client_kwargs["base_url"] = base_url
        if http_client is not None:
            client_kwargs["http_client"] = http_client
        self._client = AsyncOpenAI(**client_kwargs)

    def _request_kwargs(self, request: NeutralRequest, *, model: str) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "model": model,
            "input": _input_items(request),
            "store": False,
        }
        if request.system_instruction:
            kwargs["instructions"] = request.system_instruction
        if request.max_output_tokens is not None:
            kwargs["max_output_tokens"] = request.max_output_tokens
        if request.tools:
            kwargs["tools"] = _tools(request.tools)
            kwargs["tool_choice"] = "auto"
        effort = reasoning_effort(request)
        if effort is not None:
            kwargs["reasoning"] = {"effort": effort}
        if request.response_schema is not None:
            kwargs["text"] = {
                "format": {
                    "type": "json_schema",
                    "name": _schema_name(request.response_schema),
                    "schema": request.response_schema,
                    "strict": False,
                }
            }
        return kwargs

    async def _generate(self, request: NeutralRequest, *, model: str) -> NormalizedResponse:
        response = await self._client.responses.create(**self._request_kwargs(request, model=model))
        calls = tuple(
            call
            for call in (_function_call(item) for item in getattr(response, "output", None) or [])
            if call is not None
        )
        return NormalizedResponse(
            text=_output_text(response),
            function_calls=calls,
            model_version=str(getattr(response, "model", "") or ""),
            usage=_usage(getattr(response, "usage", None)),
        )

    async def _stream(
        self, request: NeutralRequest, *, model: str
    ) -> AsyncIterator[NormalizedChunk]:
        stream = await self._client.responses.create(
            stream=True, **self._request_kwargs(request, model=model)
        )
        calls: list[NormalizedFunctionCall] = []
        reported = ""
        usage: NormalizedUsage | None = None
        async for event in stream:
            kind = getattr(event, "type", "")
            if kind == "response.output_text.delta":
                delta = getattr(event, "delta", None)
                if isinstance(delta, str) and delta:
                    yield NormalizedChunk(text=delta, model_version=reported)
            elif kind == "response.output_item.done":
                call = _function_call(getattr(event, "item", None))
                if call is not None:
                    calls.append(call)
            elif kind in {"response.created", "response.completed", "response.incomplete"}:
                response = getattr(event, "response", None)
                reported = reported or str(getattr(response, "model", "") or "")
                usage = _usage(getattr(response, "usage", None)) or usage
        yield NormalizedChunk(function_calls=tuple(calls), model_version=reported, usage=usage)


__all__ = ["OpenAIResponsesTransport", "reasoning_effort"]
