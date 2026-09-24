"""Keep raw Drive MCP results in the current model turn, not chat storage/wire."""

from __future__ import annotations

import json
from typing import Any

from ag_ui.core import BaseEvent, EventType

from hushh_mcp.one_adk.drive_tools import DRIVE_PRIVATE_SOURCE, DRIVE_READ_TOOL_NAME
from hushh_mcp.one_adk.selected_drive_status import PRIVATE_SOURCE as SELECTED_STATUS_SOURCE

_OUTCOMES = frozenset({"ok", "blocked", "unavailable"})
_PRIVATE_TOOLS = frozenset(
    {DRIVE_READ_TOOL_NAME, "inspect_selected_drive_files", "read_workspace_tool"}
)
_PRIVATE_SOURCES = frozenset({DRIVE_PRIVATE_SOURCE, SELECTED_STATUS_SOURCE, "workspace_mcp"})


def _safe_result(value: object) -> dict[str, Any]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            value = None
    result = value if isinstance(value, dict) else {}
    status = result.get("status")
    return {
        "status": status if status in _OUTCOMES else "unavailable",
        "private_result": "not_retained",
        "truncated": result.get("truncated") is True,
    }


def redact_drive_session_json(serialized: str) -> str:
    """Remove the raw function response from the serialized storage copy.

    The live ADK session remains untouched until the model finishes this turn.
    Restored sessions retain the invocation and safe outcome, not provider text.
    """
    if not any(name in serialized for name in _PRIVATE_TOOLS):
        return serialized
    document: dict[str, Any] = json.loads(serialized)
    changed = False
    for event in document.get("events", []):
        for part in (event.get("content") or {}).get("parts") or []:
            call = part.get("functionCall")
            if isinstance(call, dict) and call.get("name") in _PRIVATE_TOOLS:
                call["args"] = {}
                call["partialArgs"] = None
                changed = True
            response = part.get("functionResponse")
            if isinstance(response, dict) and response.get("name") in _PRIVATE_TOOLS:
                response["response"] = _safe_result(response.get("response"))
                response["parts"] = None
                changed = True
    return json.dumps(document, separators=(",", ":")) if changed else serialized


def _is_private_result(content: object) -> bool:
    if not isinstance(content, str):
        return False
    try:
        value = json.loads(content)
    except (TypeError, ValueError):
        return False
    return isinstance(value, dict) and value.get("source") in _PRIVATE_SOURCES


def redact_drive_wire_event(event: BaseEvent, private_call_ids: set[str]) -> BaseEvent | None:
    """Project a safe AG-UI event while preserving model-visible tool output."""
    event_type = getattr(event, "type", None)
    if event_type == EventType.TOOL_CALL_START:
        if getattr(event, "tool_call_name", None) in _PRIVATE_TOOLS:
            private_call_ids.add(str(getattr(event, "tool_call_id", "")))
        return event
    if event_type == EventType.TOOL_CALL_CHUNK:
        if (
            getattr(event, "tool_call_name", None) in _PRIVATE_TOOLS
            or str(getattr(event, "tool_call_id", "")) in private_call_ids
        ):
            return None
        return event
    if event_type == EventType.TOOL_CALL_ARGS:
        if str(getattr(event, "tool_call_id", "")) in private_call_ids:
            return None
        return event
    if event_type == EventType.TOOL_CALL_RESULT:
        if str(getattr(event, "tool_call_id", "")) in private_call_ids or _is_private_result(
            getattr(event, "content", None)
        ):
            return event.model_copy(
                update={
                    "content": json.dumps(_safe_result(getattr(event, "content", None))),
                    "raw_event": None,
                    "metadata": None,
                }
            )
        return event
    if event_type == EventType.MESSAGES_SNAPSHOT:
        safe = []
        changed = False
        for message in getattr(event, "messages", []):
            calls = getattr(message, "tool_calls", None)
            if calls:
                safe_calls = []
                call_changed = False
                for call in calls:
                    if (
                        getattr(call.function, "name", None) in _PRIVATE_TOOLS
                        or str(getattr(call, "id", "")) in private_call_ids
                    ):
                        safe_calls.append(
                            call.model_copy(
                                update={
                                    "function": call.function.model_copy(
                                        update={"arguments": "{}"}
                                    ),
                                    "metadata": None,
                                    "encrypted_value": None,
                                }
                            )
                        )
                        call_changed = True
                    else:
                        safe_calls.append(call)
                if call_changed:
                    safe.append(
                        message.model_copy(update={"tool_calls": safe_calls, "metadata": None})
                    )
                    changed = True
                    continue
            if getattr(message, "role", None) == "tool" and (
                str(getattr(message, "tool_call_id", "")) in private_call_ids
                or _is_private_result(getattr(message, "content", None))
            ):
                safe.append(
                    message.model_copy(
                        update={
                            "content": json.dumps(_safe_result(getattr(message, "content", None))),
                            "encrypted_value": None,
                            "metadata": None,
                        }
                    )
                )
                changed = True
            else:
                safe.append(message)
        return (
            event.model_copy(update={"messages": safe, "raw_event": None, "metadata": None})
            if changed
            else event
        )
    return event
