"""Translate genai-shaped requests into provider-neutral message lists.

The chat service builds ``genai_types.Content`` lists and a
``genai_types.GenerateContentConfig``. Native adapters do not understand those
types, so this module flattens them into a small neutral shape
(``role`` + ``text`` messages, plus the config knobs and any declared tools)
that each adapter maps onto its own SDK.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class NeutralMessage:
    role: str  # "user" | "assistant" | "tool"
    text: str = ""
    # Tool metadata is deliberately optional so existing provider adapters and
    # persisted conversation shapes remain source compatible.  The fields are
    # populated from genai function_call/function_response parts and survive a
    # relay hop without turning the provider into a second router.
    tool_call_id: str = ""
    tool_name: str = ""
    tool_arguments: dict[str, Any] | None = None
    tool_result: Any = None


@dataclass(frozen=True)
class NeutralTool:
    name: str
    description: str
    parameters: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class NeutralRequest:
    messages: tuple[NeutralMessage, ...]
    system_instruction: str | None = None
    temperature: float | None = None
    max_output_tokens: int | None = None
    tools: tuple[NeutralTool, ...] = field(default_factory=tuple)


def _text_from_parts(parts: Any) -> str:
    chunks: list[str] = []
    for part in parts or []:
        text = getattr(part, "text", None)
        if isinstance(text, str) and text:
            chunks.append(text)
    return "\n".join(chunks)


def _neutral_role(genai_role: str | None) -> str:
    # genai uses "model" for assistant turns; everything else maps to "user".
    return "assistant" if (genai_role or "").strip().lower() == "model" else "user"


def _tools_from_config(config: Any) -> tuple[NeutralTool, ...]:
    tools_attr = getattr(config, "tools", None) or []
    neutral: list[NeutralTool] = []
    for tool in tools_attr:
        declarations = getattr(tool, "function_declarations", None) or []
        for decl in declarations:
            name = str(getattr(decl, "name", "") or "").strip()
            if not name:
                continue
            description = str(getattr(decl, "description", "") or "")
            parameters = getattr(decl, "parameters", None)
            params_dict: dict[str, Any]
            if parameters is None:
                params_dict = {"type": "object", "properties": {}}
            elif isinstance(parameters, dict):
                params_dict = parameters
            elif hasattr(parameters, "model_dump"):
                params_dict = parameters.model_dump(exclude_none=True)
            elif hasattr(parameters, "to_json_dict"):
                params_dict = parameters.to_json_dict()
            else:
                params_dict = {"type": "object", "properties": {}}
            neutral.append(NeutralTool(name=name, description=description, parameters=params_dict))
    return tuple(neutral)


def to_neutral_request(contents: Any, config: Any) -> NeutralRequest:
    messages: list[NeutralMessage] = []
    for content in contents or []:
        role = _neutral_role(getattr(content, "role", None))
        text_chunks: list[str] = []
        for part in getattr(content, "parts", None) or []:
            text = getattr(part, "text", None)
            if isinstance(text, str) and text:
                text_chunks.append(text)
            call = getattr(part, "function_call", None)
            if call is not None:
                name = str(getattr(call, "name", "") or "").strip()
                if name:
                    args = getattr(call, "args", None)
                    if not isinstance(args, dict):
                        args = {}
                    messages.append(
                        NeutralMessage(
                            role="assistant",
                            tool_call_id=str(getattr(call, "id", "") or ""),
                            tool_name=name,
                            tool_arguments=args,
                        )
                    )
            response = getattr(part, "function_response", None)
            if response is not None:
                name = str(getattr(response, "name", "") or "").strip()
                result = getattr(response, "response", None)
                messages.append(
                    NeutralMessage(
                        role="tool",
                        tool_call_id=str(getattr(response, "id", "") or ""),
                        tool_name=name,
                        tool_result=result,
                    )
                )
        text = "\n".join(text_chunks)
        if text:
            messages.append(NeutralMessage(role=role, text=text))

    system_instruction = getattr(config, "system_instruction", None)
    temperature = getattr(config, "temperature", None)
    max_output_tokens = getattr(config, "max_output_tokens", None)

    return NeutralRequest(
        messages=tuple(messages),
        system_instruction=(
            str(system_instruction) if isinstance(system_instruction, str) else None
        ),
        temperature=float(temperature) if isinstance(temperature, (int, float)) else None,
        max_output_tokens=(int(max_output_tokens) if isinstance(max_output_tokens, int) else None),
        tools=_tools_from_config(config),
    )
