"""Pure Azure response decoding; adapter compatibility imports retain one authority."""

from __future__ import annotations

import json
from typing import Any

from google.adk.models.llm_response import LlmResponse
from google.genai import types

from .azure_call_lifecycle import AzureContentFilteredError, AzureProtocolError
from .azure_response_history import browser_message_part, reasoning_part

_MAX_ARGUMENT_BYTES = 256 * 1024


def _value(obj: Any, name: str, default=None):
    return obj.get(name, default) if isinstance(obj, dict) else getattr(obj, name, default)


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _identifier(value: Any) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 256
        or any(ord(char) < 32 or ord(char) == 127 for char in value)
    ):
        raise ValueError("Invalid Azure function identity")
    return value


def _require_complete(response: Any) -> None:
    if (
        _value(response, "status") == "incomplete"
        and _value(_value(response, "incomplete_details"), "reason") == "content_filter"
    ):
        raise AzureContentFilteredError()
    if _value(response, "status") != "completed" or _value(response, "incomplete_details"):
        raise ValueError("Azure model response did not complete")


def _raise_stream_error(event: Any) -> None:
    if _value(event, "type") == "response.incomplete":
        _require_complete(_value(event, "response"))
    raise ValueError("Azure streaming response did not complete")


def _output_parts(
    response: Any, *, allowed_names: set[str], preserve_message_phase: bool, allow_web_search: bool
) -> list[types.Part]:
    parts, ids = [], set()
    for item in _value(response, "output", []) or []:
        kind = _value(item, "type")
        if kind == "reasoning":
            part = reasoning_part(item)
            if part is not None:
                parts.append(part)
            for summary in _value(item, "summary", []) or []:
                if _value(summary, "type") != "summary_text" or not isinstance(
                    _value(summary, "text"), str
                ):
                    raise ValueError("Unsupported Azure reasoning summary")
                parts.append(types.Part(text=_value(summary, "text"), thought=True))
        elif kind == "message":
            if preserve_message_phase and _value(item, "phase") is not None:
                parts.append(browser_message_part(item))
                continue
            for segment in _value(item, "content", []) or []:
                if _value(segment, "type") != "output_text":
                    raise ValueError("Unsupported or refused Azure output")
                text = _value(segment, "text")
                if not isinstance(text, str):
                    raise ValueError("Invalid Azure output text")
                parts.append(types.Part(text=text))
        elif kind == "function_call":
            name, identity = _identifier(_value(item, "name")), _identifier(_value(item, "call_id"))
            raw = _value(item, "arguments")
            if (
                name not in allowed_names
                or identity in ids
                or not isinstance(raw, str)
                or len(raw.encode()) > _MAX_ARGUMENT_BYTES
            ):
                raise ValueError("Invalid Azure output function call")
            args = json.loads(raw)
            if not isinstance(args, dict):
                raise ValueError("Azure function arguments must be a JSON object")
            _json(args)  # Reject non-finite JSON constants before an executable call exists.
            ids.add(identity)
            parts.append(
                types.Part(function_call=types.FunctionCall(id=identity, name=name, args=args))
            )
        elif kind == "web_search_call" and allow_web_search:
            continue  # Only receipt validation below may admit search evidence.
        else:
            raise ValueError("Unsupported Azure native output tool")
    if not any(part.text is not None or part.function_call is not None for part in parts):
        raise ValueError("Azure model returned no usable output")
    return parts


def _grounding(response: Any, *, allow_web_search: bool) -> types.GroundingMetadata | None:
    grounding = None
    if allow_web_search and any(
        _value(item, "type") == "web_search_call" for item in _value(response, "output", [])
    ):
        from hushh_mcp.one_adk.azure_web_receipts import extract_azure_web_receipts

        raw = response.model_dump(mode="json") if hasattr(response, "model_dump") else response
        if not isinstance(raw, dict):
            raise ValueError("Azure search requires a complete provider receipt")
        try:
            receipts = extract_azure_web_receipts(raw)
        except ValueError as error:
            if str(error) == "Completed Azure web retrieval has no valid billable request count":
                raise AzureProtocolError("search.billing") from None
            raise
        if not receipts.observed:
            raise AzureProtocolError("search." + receipts.rejection_reason)
        grounding = types.GroundingMetadata(
            grounding_chunks=[
                types.GroundingChunk(
                    web=types.GroundingChunkWeb(uri=source.url, title=source.title)
                )
                for source in receipts.sources
            ],
        )
    return grounding


def _response(
    response: Any,
    *,
    allowed_names: set[str],
    preserve_message_phase: bool = False,
    allow_web_search: bool = False,
) -> LlmResponse:
    _require_complete(response)
    parts = _output_parts(
        response,
        allowed_names=allowed_names,
        preserve_message_phase=preserve_message_phase,
        allow_web_search=allow_web_search,
    )
    usage = _value(response, "usage")
    metadata = None
    if usage is not None:
        cached = _value(_value(usage, "input_tokens_details"), "cached_tokens")
        reasoning = _value(_value(usage, "output_tokens_details"), "reasoning_tokens")
        metadata = types.GenerateContentResponseUsageMetadata(
            prompt_token_count=_value(usage, "input_tokens"),
            candidates_token_count=_value(usage, "output_tokens"),
            total_token_count=_value(usage, "total_tokens"),
            cached_content_token_count=cached,
            thoughts_token_count=reasoning,
        )
    return LlmResponse(
        content=types.Content(role="model", parts=parts),
        partial=False,
        turn_complete=True,
        finish_reason=types.FinishReason.STOP,
        model_version=_value(response, "model"),
        usage_metadata=metadata,
        grounding_metadata=_grounding(response, allow_web_search=allow_web_search),
    )
