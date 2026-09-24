"""Keep raw Drive MCP results in the current model turn, not chat storage/wire."""

from __future__ import annotations

import json
import re
from typing import Any

from ag_ui.core import BaseEvent, EventType

from hushh_mcp.one_adk.drive_tools import DRIVE_PRIVATE_SOURCE, DRIVE_READ_TOOL_NAME
from hushh_mcp.one_adk.selected_drive_status import PRIVATE_SOURCE as SELECTED_STATUS_SOURCE

_OUTCOMES = frozenset({"ok", "blocked", "unavailable", "permission_required"})
_WORKSPACE_PROVIDERS = frozenset({"drive", "gmail", "calendar"})
_PRIVATE_TOOLS = frozenset(
    {DRIVE_READ_TOOL_NAME, "inspect_selected_drive_files", "read_workspace_tool"}
)
_PRIVATE_SOURCES = frozenset({DRIVE_PRIVATE_SOURCE, SELECTED_STATUS_SOURCE, "workspace_mcp"})
_DYNAMIC_MCP_TOOL = re.compile(r"mcp_[0-9a-f]{40}\Z")


def _private_tool_name(name: object) -> bool:
    """Recognize the governed namespace without importing the runtime toolset."""
    return isinstance(name, str) and (
        name in _PRIVATE_TOOLS or _DYNAMIC_MCP_TOOL.fullmatch(name) is not None
    )


def _safe_result(value: object) -> dict[str, Any]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            value = None
    result = value if isinstance(value, dict) else {}
    status = result.get("status")
    safe = {
        "status": status if status in _OUTCOMES else "unavailable",
        "private_result": "not_retained",
        "truncated": result.get("truncated") is True,
    }
    # The provider enum is safe to expose and is needed for the in-chat OAuth
    # card after private tool arguments and results have been removed.
    if status == "permission_required" and result.get("provider") in _WORKSPACE_PROVIDERS:
        safe["provider"] = result["provider"]
    return safe


def redact_drive_session_json(serialized: str) -> str:
    """Remove the raw function response from the serialized storage copy.

    The live ADK session remains untouched until the model finishes this turn.
    Restored sessions retain the invocation and safe outcome, not provider text.
    """
    if "mcp_" not in serialized and not any(name in serialized for name in _PRIVATE_TOOLS):
        return serialized
    document: dict[str, Any] = json.loads(serialized)
    changed = False
    for event in document.get("events", []):
        for part in (event.get("content") or {}).get("parts") or []:
            call = part.get("functionCall")
            if isinstance(call, dict) and _private_tool_name(call.get("name")):
                call["args"] = {}
                call["partialArgs"] = None
                changed = True
            response = part.get("functionResponse")
            if isinstance(response, dict) and _private_tool_name(response.get("name")):
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
        if _private_tool_name(getattr(event, "tool_call_name", None)):
            private_call_ids.add(str(getattr(event, "tool_call_id", "")))
            return event.model_copy(update={"raw_event": None, "metadata": None})
        return event
    if event_type == EventType.TOOL_CALL_CHUNK:
        if (
            _private_tool_name(getattr(event, "tool_call_name", None))
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
        # A resumed snapshot may arrive without TOOL_CALL_START, and messages
        # need not put the function call before its response. Index identities
        # first so provider content cannot escape through that ordering.
        for message in getattr(event, "messages", []):
            for call in getattr(message, "tool_calls", None) or []:
                if _private_tool_name(getattr(call.function, "name", None)):
                    private_call_ids.add(str(getattr(call, "id", "")))
        safe = []
        changed = False
        for message in getattr(event, "messages", []):
            calls = getattr(message, "tool_calls", None)
            if calls:
                safe_calls = []
                call_changed = False
                for call in calls:
                    if (
                        _private_tool_name(getattr(call.function, "name", None))
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
