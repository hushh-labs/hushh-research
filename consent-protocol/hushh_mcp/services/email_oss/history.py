"""Chronological repair of prior native tool exchanges, without inventing effects."""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage


def _message(value: Any) -> BaseMessage | None:
    if isinstance(value, BaseMessage):
        return value
    row = value if isinstance(value, dict) else vars(value) if hasattr(value, "__dict__") else {}
    role = row.get("role") or row.get("type")
    content = row.get("content") or ""
    if not isinstance(content, (str, list)):
        return None
    if role in {"user", "human"}:
        return HumanMessage(content=content)
    if role in {"assistant", "ai", "model"}:
        calls = []
        for call in row.get("tool_calls") or []:
            if not isinstance(call, dict):
                continue
            function = call.get("function") or {}
            args = call.get("args", function.get("arguments", {}))
            if isinstance(args, str):
                import json

                try:
                    args = json.loads(args)
                except (ValueError, TypeError):
                    continue
            if isinstance(args, dict):
                calls.append(
                    {
                        "id": str(call.get("id") or ""),
                        "name": str(call.get("name") or function.get("name") or ""),
                        "args": args,
                    }
                )
        return AIMessage(content=content, tool_calls=calls)
    if role == "tool" and isinstance(row.get("tool_call_id"), str):
        return ToolMessage(
            content=content,
            tool_call_id=row["tool_call_id"],
            name=row.get("name"),
            status="error"
            if row.get("status") in {"error", "interrupted", "cancelled"}
            else "success",
        )
    return None


def sanitize_email_history(
    history: Iterable[Any], allowed_tools: Iterable[str], *, max_messages: int = 48
) -> list[BaseMessage]:
    """Keep complete local exchanges; IDs are scoped to their AI message.

    Only an exact matching result with a declared name can repair an unknown
    name. Orphan results and duplicate IDs are dropped. Missing results receive
    an explicit interruption error, never a fabricated successful observation.
    """
    allowed = frozenset(allowed_tools)
    output: list[BaseMessage] = []
    pending: AIMessage | None = None
    results: dict[str, ToolMessage] = {}
    result_names: dict[str, set[str]] = {}

    def flush() -> None:
        nonlocal pending, results, result_names
        if pending is None:
            return
        counts = Counter(call["id"] for call in pending.tool_calls if call.get("id"))
        calls, paired = [], []
        for original in pending.tool_calls:
            call = dict(original)
            identity = call.get("id")
            if not identity or counts[identity] != 1:
                continue
            result = results.get(identity)
            if call["name"] not in allowed:
                if (
                    result is None
                    or result.name not in allowed
                    or len(result_names.get(identity, set())) != 1
                ):
                    continue
                call["name"] = result.name
            if result is not None and result.name and result.name != call["name"]:
                # A conflicting result is not evidence for either operation.
                result = None
            calls.append(call)
            paired.append(
                result.model_copy(update={"name": call["name"]})
                if result is not None
                else ToolMessage(
                    content="The previous tool call was interrupted. Its outcome is unknown; do not repeat a mutation without checking its existing receipt.",
                    tool_call_id=identity,
                    name=call["name"],
                    status="error",
                )
            )
        if calls or pending.content:
            output.append(pending.model_copy(update={"tool_calls": calls}))
            output.extend(paired)
        pending, results, result_names = None, {}, {}

    for raw in history:
        try:
            message = _message(raw)
        except (ValueError, TypeError):
            continue
        if message is None:
            continue
        if isinstance(message, ToolMessage):
            if pending is not None:
                if message.name:
                    result_names.setdefault(message.tool_call_id, set()).add(message.name)
                if message.tool_call_id not in results:
                    results[message.tool_call_id] = message
            continue
        flush()
        if isinstance(message, AIMessage) and message.tool_calls:
            pending = message
        elif isinstance(message, (AIMessage, HumanMessage)):
            output.append(message)
    flush()
    if len(output) > max_messages:
        start = len(output) - max_messages
        while start < len(output) and not isinstance(output[start], HumanMessage):
            start += 1
        output = output[start:]
    return output
