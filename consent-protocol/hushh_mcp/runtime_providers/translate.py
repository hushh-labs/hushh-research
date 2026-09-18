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
    # Structured output, tool choice, sampling and thinking knobs. Each one is
    # optional so every existing adapter keeps its shape; an adapter that cannot
    # honour a set field refuses before dispatch rather than dropping it, because
    # a silently ignored schema or tool choice produces an answer that looks
    # right and is not the one the agent asked for.
    response_schema: dict[str, Any] | None = None
    response_mime_type: str | None = None
    tool_choice: str | None = None  # "auto" | "any" | "none"
    allowed_function_names: tuple[str, ...] = field(default_factory=tuple)
    top_p: float | None = None
    stop_sequences: tuple[str, ...] = field(default_factory=tuple)
    seed: int | None = None
    thinking_budget: int | None = None
    include_thoughts: bool | None = None

    def requires_tool_calling(self) -> bool:
        return bool(self.tools) or bool(self.allowed_function_names)

    def requires_json_schema(self) -> bool:
        mime = str(self.response_mime_type or "").strip().lower()
        return self.response_schema is not None or mime == "application/json"

    def required_capabilities(self) -> tuple[str, ...]:
        """Capability names (Puppy One harness vocabulary) this request needs."""
        needed: list[str] = []
        if self.requires_tool_calling():
            needed.append("tool_calling")
        if self.requires_json_schema():
            needed.append("json_schema")
        return tuple(needed)


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


def _schema_dict(value: Any) -> dict[str, Any] | None:
    """One JSON-schema shape for a genai ``Schema``, a pydantic model or a dict."""
    if value is None:
        return None
    if isinstance(value, dict):
        return value
    if hasattr(value, "model_dump"):
        dumped = value.model_dump(exclude_none=True)
        return dumped if isinstance(dumped, dict) else None
    if hasattr(value, "to_json_dict"):
        dumped = value.to_json_dict()
        return dumped if isinstance(dumped, dict) else None
    return None


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
            params_dict = _schema_dict(getattr(decl, "parameters", None))
            if params_dict is None:
                params_dict = {"type": "object", "properties": {}}
            neutral.append(NeutralTool(name=name, description=description, parameters=params_dict))
    return tuple(neutral)


def _tool_choice_from_config(config: Any) -> tuple[str | None, tuple[str, ...]]:
    """``tool_config.function_calling_config`` -> (mode, allowed function names)."""
    tool_config = getattr(config, "tool_config", None)
    calling = getattr(tool_config, "function_calling_config", None)
    if calling is None:
        return None, ()
    raw_mode = getattr(calling, "mode", None)
    mode_text = str(getattr(raw_mode, "value", raw_mode) or "").strip().lower()
    mode = mode_text if mode_text in {"auto", "any", "none"} else None
    names = getattr(calling, "allowed_function_names", None) or []
    allowed = tuple(str(name).strip() for name in names if str(name or "").strip())
    return mode, allowed


def _thinking_from_config(config: Any) -> tuple[int | None, bool | None]:
    thinking = getattr(config, "thinking_config", None)
    if thinking is None:
        return None, None
    budget = getattr(thinking, "thinking_budget", None)
    include = getattr(thinking, "include_thoughts", None)
    return (
        int(budget) if isinstance(budget, int) and not isinstance(budget, bool) else None,
        bool(include) if isinstance(include, bool) else None,
    )


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
    response_mime_type = getattr(config, "response_mime_type", None)
    top_p = getattr(config, "top_p", None)
    stop_sequences = getattr(config, "stop_sequences", None) or []
    seed = getattr(config, "seed", None)
    tool_choice, allowed_function_names = _tool_choice_from_config(config)
    thinking_budget, include_thoughts = _thinking_from_config(config)

    return NeutralRequest(
        messages=tuple(messages),
        system_instruction=(
            str(system_instruction) if isinstance(system_instruction, str) else None
        ),
        temperature=float(temperature) if isinstance(temperature, (int, float)) else None,
        max_output_tokens=(int(max_output_tokens) if isinstance(max_output_tokens, int) else None),
        tools=_tools_from_config(config),
        response_schema=_schema_dict(getattr(config, "response_schema", None)),
        response_mime_type=(
            str(response_mime_type) if isinstance(response_mime_type, str) else None
        ),
        tool_choice=tool_choice,
        allowed_function_names=allowed_function_names,
        top_p=float(top_p)
        if isinstance(top_p, (int, float)) and not isinstance(top_p, bool)
        else None,
        stop_sequences=tuple(
            str(stop) for stop in stop_sequences if isinstance(stop, str) and stop
        ),
        seed=int(seed) if isinstance(seed, int) and not isinstance(seed, bool) else None,
        thinking_budget=thinking_budget,
        include_thoughts=include_thoughts,
    )
