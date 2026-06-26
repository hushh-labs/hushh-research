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
    role: str  # "user" | "assistant"
    text: str


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
        text = _text_from_parts(getattr(content, "parts", None))
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
