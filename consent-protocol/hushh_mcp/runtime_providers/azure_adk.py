"""Keyless Azure Responses transport for existing manifest-owned ADK agents.

This adapter translates protocol shapes only. It does not supply instructions,
select tools, retry requests, or grant invocation/data/action authority.
"""

from __future__ import annotations

import asyncio
import base64
import json
from collections.abc import AsyncGenerator, Awaitable, Callable
from typing import Any
from urllib.parse import urlsplit

from google.adk.labs.openai import OpenAIResponsesLlm
from google.adk.models._capabilities import LlmCapabilities
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from pydantic import BaseModel, Field, field_validator

from .azure_response_history import (
    browser_message_part,
    reasoning_part,
    restore_browser_message,
    restore_reasoning,
)


class AzureAuthenticationError(RuntimeError):
    """Workload authentication failed before model I/O; not a model outage."""


_MAX_ARGUMENT_BYTES = 256 * 1024
_MAX_MEDIA_BYTES = 25 * 1024 * 1024
_MAX_REQUEST_MEDIA_BYTES = 50 * 1024 * 1024


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


def _schema(value: Any, *, strict: bool) -> dict:
    """Translate schema syntax while leaving semantic acceptance with its owner."""
    if isinstance(value, type) and issubclass(value, BaseModel):
        value = value.model_json_schema()
    elif hasattr(value, "model_dump"):
        value = value.model_dump(mode="json", exclude_none=True)
    if not isinstance(value, dict):
        raise ValueError("Azure structured schema must be an object")

    def visit(node):
        if isinstance(node, list):
            return [visit(item) for item in node]
        if not isinstance(node, dict):
            return node
        result = {}
        for key, child in node.items():
            if key in {"default", "title"}:
                continue
            if key in {"properties", "$defs", "definitions", "patternProperties"}:
                result[key] = {name: visit(item) for name, item in child.items()}
            else:
                result["anyOf" if key == "oneOf" else key] = visit(child)
        if isinstance(result.get("type"), str):
            result["type"] = result["type"].lower()
        if "const" in result:
            result["enum"] = [result.pop("const")]
        nullable = result.pop("nullable", False)
        if strict and result.get("type") == "object":
            if result.get("additionalProperties") not in (None, False):
                raise ValueError("Azure strict output cannot represent open object fields")
            result["additionalProperties"] = False
            result["required"] = list(result.get("properties", {}))
        if nullable:
            return {"anyOf": [result, {"type": "null"}]}
        return result

    converted = visit(value)
    if not isinstance(converted, dict):
        raise ValueError("Azure structured schema must remain an object")
    return converted


def _instruction(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    parts = value.parts if isinstance(value, types.Content) else value
    if isinstance(parts, types.Part):
        parts = [parts]
    if not isinstance(parts, list):
        raise ValueError("Unsupported Azure system instruction")
    output = []
    for part in parts:
        if isinstance(part, str):
            output.append(part)
        elif isinstance(part, types.Part) and part.text is not None:
            if set(part.model_dump(exclude_none=True)) - {"text"}:
                raise ValueError("Unsupported Azure system instruction part")
            output.append(part.text)
        else:
            raise ValueError("Unsupported Azure system instruction part")
    return "\n\n".join(output)


def _inline_media(part: types.Part) -> dict:
    """Translate already-admitted bytes; never fetch URLs or persist provider files."""
    blob = part.inline_data
    if (
        blob is None
        or not isinstance(blob.data, bytes)
        or not 0 < len(blob.data) <= _MAX_MEDIA_BYTES
    ):
        raise ValueError("Azure inline media exceeds supported bounds")
    data, mime = blob.data, blob.mime_type
    if mime == "text/csv":
        return {"type": "input_text", "text": data.decode("utf-8-sig", errors="strict")}
    if mime == "application/pdf":
        if not data.startswith(b"%PDF-") or b"%%EOF" not in data[-1024:]:
            raise ValueError("Invalid Azure inline PDF")
        return {
            "type": "input_file",
            "filename": "document.pdf",
            "file_data": "data:application/pdf;base64," + base64.b64encode(data).decode("ascii"),
        }
    signatures = {
        "image/png": data.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg": data.startswith(b"\xff\xd8\xff"),
        "image/gif": data.startswith((b"GIF87a", b"GIF89a")),
        "image/webp": data.startswith(b"RIFF") and data[8:12] == b"WEBP",
    }
    if not signatures.get(mime or "", False):
        raise ValueError("Unsupported or invalid Azure inline media")
    return {
        "type": "input_image",
        "image_url": f"data:{mime};base64," + base64.b64encode(data).decode("ascii"),
    }


def _history(contents: list[types.Content], *, preserve_message_phase: bool = False) -> list[dict]:
    output, pending, seen = [], {}, set()
    media_bytes = 0
    for content in contents:
        if content.role not in {"user", "model"}:
            raise ValueError("Unsupported Azure history role")
        role = "assistant" if content.role == "model" else "user"
        text: list[str] = []
        rich: list[dict] = []

        def flush(text=text, role=role, rich=rich):
            if rich:
                if text:
                    rich.append({"type": "input_text", "text": "".join(text)})
                    text.clear()
                output.append({"role": role, "content": list(rich)})
                rich.clear()
                return
            if text:
                output.append({"role": role, "content": "".join(text)})
                text.clear()

        for part in content.parts or []:
            fields = set(part.model_dump(exclude_none=True))
            if fields - {
                "text",
                "thought",
                "thought_signature",
                "function_call",
                "function_response",
                "inline_data",
            }:
                raise ValueError("Azure text adapter does not support native media parts")
            if part.inline_data is not None:
                if role != "user" or fields != {"inline_data"}:
                    raise ValueError("Azure inline media must be a distinct user input part")
                media_bytes += len(part.inline_data.data or b"")
                if media_bytes > _MAX_REQUEST_MEDIA_BYTES:
                    raise ValueError("Azure request media exceeds supported bounds")
                if text:
                    rich.append({"type": "input_text", "text": "".join(text)})
                    text.clear()
                rich.append(_inline_media(part))
                continue
            preserved = restore_browser_message(
                part, role=role, allowed=preserve_message_phase
            ) or restore_reasoning(part, role=role)
            if preserved is not None:
                flush()
                output.append(preserved)
                continue
            if part.thought:
                continue  # Provider-private reasoning is not a user instruction.
            if part.text is not None:
                text.append(part.text)
            if part.function_call is not None:
                flush()
                call = part.function_call
                identity, name = _identifier(call.id), _identifier(call.name)
                if role != "assistant" or identity in seen:
                    raise ValueError("Invalid Azure function-call history")
                arguments = _json(call.args or {})
                if len(arguments.encode()) > _MAX_ARGUMENT_BYTES:
                    raise ValueError("Azure function arguments exceed bounds")
                pending[identity] = name
                seen.add(identity)
                output.append(
                    {
                        "type": "function_call",
                        "call_id": identity,
                        "name": name,
                        "arguments": arguments,
                    }
                )
            if part.function_response is not None:
                flush()
                response = part.function_response
                identity = _identifier(response.id)
                if (
                    role != "user"
                    or pending.get(identity) != response.name
                    or response.parts
                    or response.will_continue
                    or response.scheduling
                ):
                    raise ValueError("Invalid or unsupported Azure tool-result history")
                pending.pop(identity)
                output.append(
                    {
                        "type": "function_call_output",
                        "call_id": identity,
                        "output": _json(response.response),
                    }
                )
        flush()
    if pending or not output:
        raise ValueError("Azure history requires complete tool results and a request")
    return output


def _tools(
    config: types.GenerateContentConfig, *, allow_web_search: bool = False
) -> tuple[list[dict], str]:
    tools: list[dict] = []
    names: set[str] = set()
    for tool in config.tools or []:
        if not isinstance(tool, types.Tool):
            raise ValueError("Unsupported Azure tool declaration")
        fields = set(tool.model_dump(exclude_none=True))
        if allow_web_search and fields == {"google_search"}:
            if tool.google_search is None or tool.google_search.model_dump(exclude_none=True):
                raise ValueError("Unsupported Azure search constraints")
            if any(item["type"] == "web_search" for item in tools):
                raise ValueError("Duplicate Azure search declaration")
            tools.append({"type": "web_search", "external_web_access": False})
            continue
        if fields - {"function_declarations"}:
            raise ValueError("Azure adapter cannot execute provider-native tools")
        for function in tool.function_declarations or []:
            if (
                function.behavior
                and str(getattr(function.behavior, "value", function.behavior)) != "BLOCKING"
            ):
                raise ValueError("Azure adapter requires blocking function tools")
            name = _identifier(function.name)
            if name in names:
                raise ValueError("Duplicate Azure function declaration")
            names.add(name)
            schema = (
                function.parameters_json_schema
                or function.parameters
                or {"type": "object", "properties": {}}
            )
            tools.append(
                {
                    "type": "function",
                    "name": name,
                    "description": function.description or "",
                    "parameters": _schema(schema, strict=False),
                    "strict": False,
                }
            )
    calling = config.tool_config.function_calling_config if config.tool_config else None
    mode = str(getattr(calling.mode, "value", calling.mode)) if calling and calling.mode else "AUTO"
    choices = {"AUTO": "auto", "MODE_UNSPECIFIED": "auto", "NONE": "none", "ANY": "required"}
    if mode not in choices:
        raise ValueError("Unsupported Azure function-calling mode")
    allowed = calling.allowed_function_names if calling else None
    if allowed:
        if not set(allowed) <= names:
            raise ValueError("Unknown Azure allowed function name")
        tools = [tool for tool in tools if tool.get("name") in allowed]
    if mode == "ANY" and not tools:
        raise ValueError("Required Azure function call needs a declared tool")
    return tools, choices[mode]


def _request(
    request: LlmRequest,
    deployment: str,
    *,
    preserve_message_phase: bool = False,
    allow_web_search: bool = False,
) -> dict:
    config = request.config or types.GenerateContentConfig()
    if (
        config.cached_content
        or config.stop_sequences
        or config.safety_settings
        or config.response_modalities
        and any(str(getattr(x, "value", x)) != "TEXT" for x in config.response_modalities)
    ):
        raise ValueError("Unsupported Azure generation contract")
    tools, choice = _tools(config, allow_web_search=allow_web_search)
    kwargs: dict[str, Any] = {
        "model": deployment,
        "input": _history(request.contents, preserve_message_phase=preserve_message_phase),
        "store": False,
        "include": ["reasoning.encrypted_content"],
    }
    instruction = _instruction(config.system_instruction)
    if instruction:
        kwargs["instructions"] = instruction
    if tools:
        kwargs.update(tools=tools, tool_choice=choice)
        if any(item["type"] == "web_search" for item in tools):
            kwargs["include"].append("web_search_call.action.sources")
    if config.max_output_tokens is not None:
        kwargs["max_output_tokens"] = config.max_output_tokens
    for field in ("temperature", "top_p"):
        if getattr(config, field) is not None:
            kwargs[field] = getattr(config, field)
    if config.thinking_config and config.thinking_config.thinking_level:
        level = str(
            getattr(
                config.thinking_config.thinking_level,
                "value",
                config.thinking_config.thinking_level,
            )
        ).lower()
        if level not in {"low", "medium", "high"}:
            raise ValueError("Unsupported Azure reasoning effort")
        kwargs["reasoning"] = {"effort": level}
    if config.thinking_config and config.thinking_config.include_thoughts:
        kwargs.setdefault("reasoning", {})["summary"] = "auto"
    schema = config.response_json_schema or config.response_schema
    if schema is dict:
        # Existing untyped-JSON genes intentionally accept arbitrary keys.
        # Keep that contract instead of inventing a closed schema for them.
        kwargs["text"] = {"format": {"type": "json_object"}}
        kwargs["instructions"] = (
            kwargs.get("instructions", "") + "\nReturn a JSON object."
        ).strip()
    elif schema is not None:
        kwargs["text"] = {
            "format": {
                "type": "json_schema",
                "name": "adk_response",
                "strict": True,
                "schema": _schema(schema, strict=True),
            }
        }
    elif config.response_mime_type == "application/json":
        kwargs["text"] = {"format": {"type": "json_object"}}
    return kwargs


def _response(
    response: Any,
    *,
    allowed_names: set[str],
    preserve_message_phase: bool = False,
    allow_web_search: bool = False,
) -> LlmResponse:
    if _value(response, "status") != "completed" or _value(response, "incomplete_details"):
        raise ValueError("Azure model response did not complete")
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
    grounding = None
    if allow_web_search and any(
        _value(item, "type") == "web_search_call" for item in _value(response, "output", [])
    ):
        from hushh_mcp.one_adk.azure_web_receipts import extract_azure_web_receipts

        raw = response.model_dump(mode="json") if hasattr(response, "model_dump") else response
        if not isinstance(raw, dict):
            raise ValueError("Azure search requires a complete provider receipt")
        receipts = extract_azure_web_receipts(raw)
        if not receipts.observed:
            raise ValueError("Azure search returned no verified citations")
        grounding = types.GroundingMetadata(
            grounding_chunks=[
                types.GroundingChunk(
                    web=types.GroundingChunkWeb(uri=source.url, title=source.title)
                )
                for source in receipts.sources
            ],
        )
    return LlmResponse(
        content=types.Content(role="model", parts=parts),
        partial=False,
        turn_complete=True,
        finish_reason=types.FinishReason.STOP,
        model_version=_value(response, "model"),
        usage_metadata=metadata,
        grounding_metadata=grounding,
    )


class AzureOpenAIAdkModel(OpenAIResponsesLlm):
    """One Azure request per ADK call; callers retain deadlines and retry policy."""

    # ADK 2.9 preserves Gemini's fallback ``adk-*`` call/result IDs only for
    # Responses model subclasses. Keep that protocol compatibility while
    # overriding generation entirely; the parent public-key/client path is
    # unavailable and cannot bypass this adapter's keyless endpoint fences.
    api_key: None = Field(default=None, exclude=True, repr=False)
    client: None = Field(default=None, exclude=True, repr=False)
    endpoint: str
    token_supplier: Callable[[], str] = Field(exclude=True, repr=False)
    require_current: Callable[[], Awaitable[None]] | None = Field(
        default=None, exclude=True, repr=False
    )
    timeout_seconds: float = Field(default=60, gt=0, le=120)
    client_factory: Callable[..., Any] | None = Field(default=None, exclude=True, repr=False)
    allow_web_search: bool = False

    @field_validator("endpoint")
    @classmethod
    def trusted_endpoint(cls, value: str) -> str:
        parsed = urlsplit(value)
        if (
            parsed.scheme != "https"
            or not (parsed.hostname or "").endswith((".openai.azure.com", ".services.ai.azure.com"))
            or parsed.path.rstrip("/") != "/openai/v1"
            or parsed.username
            or parsed.password
            or parsed.port is not None
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("A trusted Azure OpenAI v1 endpoint is required")
        return value.rstrip("/") + "/"

    @field_validator("model")
    @classmethod
    def deployment(cls, value: str) -> str:
        return _identifier(value)

    @property
    def capabilities(self) -> LlmCapabilities:
        return LlmCapabilities(output_schema_and_tools=True)

    @classmethod
    def from_keyless(
        cls,
        *,
        endpoint: str,
        deployment: str,
        tenant_id: str,
        client_id: str,
        timeout_seconds: float = 60,
        require_current: Callable[[], Awaitable[None]] | None = None,
    ) -> AzureOpenAIAdkModel:
        from hushh_mcp.one_adk.azure_workload_identity import azure_openai_token_provider

        return cls(
            model=deployment,
            endpoint=endpoint,
            timeout_seconds=timeout_seconds,
            require_current=require_current,
            token_supplier=azure_openai_token_provider(tenant_id=tenant_id, client_id=client_id),
        )

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        kwargs = _request(llm_request, self.model, allow_web_search=self.allow_web_search)
        allowed = (
            {tool["name"] for tool in kwargs.get("tools", []) if tool["type"] == "function"}
            if kwargs.get("tool_choice") != "none"
            else set()
        )
        try:
            async with asyncio.timeout(5):
                token = await asyncio.to_thread(self.token_supplier)
        except Exception:
            raise AzureAuthenticationError("Azure workload authentication failed") from None
        if not isinstance(token, str) or not token:
            raise AzureAuthenticationError("Azure managed model token is unavailable")
        from openai import AsyncOpenAI

        factory = self.client_factory or AsyncOpenAI
        async with factory(
            api_key=token, base_url=self.endpoint, timeout=self.timeout_seconds, max_retries=0
        ) as client:
            if self.require_current is not None:
                await self.require_current()
            if not stream:
                response = await client.responses.create(**kwargs)
                if self.require_current is not None:
                    await self.require_current()
                yield _response(
                    response, allowed_names=allowed, allow_web_search=self.allow_web_search
                )
                return
            events = await client.responses.create(**kwargs, stream=True)
            completed = False
            observed_text = False
            try:
                async for event in events:
                    kind = _value(event, "type")
                    if kind in {
                        "response.output_text.delta",
                        "response.reasoning_summary_text.delta",
                    }:
                        delta = _value(event, "delta")
                        if not isinstance(delta, str):
                            raise ValueError("Invalid Azure streaming text")
                        if delta:
                            if not observed_text and self.require_current is not None:
                                await self.require_current()
                            observed_text = True
                            yield LlmResponse(
                                content=types.Content(
                                    role="model",
                                    parts=[
                                        types.Part(
                                            text=delta,
                                            thought=True
                                            if kind == "response.reasoning_summary_text.delta"
                                            else None,
                                        )
                                    ],
                                ),
                                partial=True,
                            )
                    elif kind == "response.completed":
                        if self.require_current is not None:
                            await self.require_current()
                        final = _response(
                            _value(event, "response"),
                            allowed_names=allowed,
                            allow_web_search=self.allow_web_search,
                        )
                        completed = True
                        yield final
                        return
                    elif kind in {"error", "response.failed", "response.incomplete"}:
                        raise ValueError("Azure streaming response did not complete")
                if not completed:
                    raise ValueError("Azure streaming response ended before completion")
            finally:
                await events.close()
