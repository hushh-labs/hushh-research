"""Keep raw Drive MCP results in the current model turn, not chat storage/wire."""

from __future__ import annotations

import json
import re
from typing import Any

from ag_ui.core import BaseEvent, EventType, ToolCallArgsEvent

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


def _confirmation_view(arguments: dict) -> dict | None:
    original = arguments.get("originalFunctionCall")
    if not isinstance(original, dict) or not _private_tool_name(original.get("name")):
        return None
    confirmation = arguments.get("toolConfirmation")
    payload = confirmation.get("payload") if isinstance(confirmation, dict) else None
    safe_payload = {}
    if (
        isinstance(payload, dict)
        and payload.get("kind") == "mcp_call_review"
        and payload.get("version") == 1
    ):
        patterns = {
            "connectorId": r"[A-Za-z0-9_-]{1,128}",
            "toolName": r"mcp_[0-9a-f]{40}",
            "directiveId": r"dir_[0-9a-f]{32}",
            "pendingHandle": r"one_secret_ref:[A-Za-z0-9_-]{32}",
            "expiresAt": r"[0-9T:+.Z-]{1,64}",
        }
        if all(
            isinstance(payload.get(key), str) and re.fullmatch(pattern, payload[key])
            for key, pattern in patterns.items()
        ):
            safe_payload = {
                "kind": "mcp_call_review",
                "version": 1,
                **{key: payload[key] for key in patterns},
            }
    return {
        "originalFunctionCall": {"id": original.get("id"), "name": original["name"], "args": {}},
        "toolConfirmation": {"confirmed": False, "payload": safe_payload},
    }


class ConfirmationWireProjection:
    """Bound fragmented native confirmations before exposing a review handle."""

    def __init__(self):
        self._pending: dict[str, tuple[BaseEvent, list[str], int]] = {}
        self._private_confirmations: set[str] = set()
        self._private_followups: set[str] = set()
        self._external_content = False

    def project(self, event: BaseEvent) -> list[BaseEvent]:
        if _private_tool_name(getattr(event, "tool_call_name", None)):
            self._external_content = True
        call_id = str(getattr(event, "tool_call_id", ""))
        if event.type == EventType.MESSAGES_SNAPSHOT:
            for message in getattr(event, "messages", []):
                if getattr(message, "role", None) == "user":
                    self._external_content = False
                if any(
                    _private_tool_name(call.function.name)
                    for call in (getattr(message, "tool_calls", None) or [])
                ):
                    self._external_content = True
        if (
            self._external_content
            and event.type == EventType.TOOL_CALL_START
            and getattr(event, "tool_call_name", None) != "adk_request_confirmation"
        ):
            self._private_followups.add(call_id)
        if (
            self._external_content
            and event.type == EventType.TOOL_CALL_CHUNK
            and call_id not in self._pending
        ):
            self._private_followups.add(call_id)
        if call_id in self._private_followups:
            if event.type in {EventType.TOOL_CALL_ARGS, EventType.TOOL_CALL_CHUNK}:
                return []
            if event.type == EventType.TOOL_CALL_RESULT:
                return [
                    event.model_copy(
                        update={
                            "content": json.dumps(_safe_result(getattr(event, "content", None))),
                            "raw_event": None,
                            "metadata": None,
                        }
                    )
                ]
            return [event.model_copy(update={"raw_event": None, "metadata": None})]
        if event.type == EventType.RUN_FINISHED and self._pending:
            raise ValueError("Connector confirmation was incomplete.")
        if event.type == EventType.TOOL_CALL_RESULT and call_id in self._private_confirmations:
            return [
                event.model_copy(
                    update={
                        "content": json.dumps(_safe_result(getattr(event, "content", None))),
                        "raw_event": None,
                        "metadata": None,
                    }
                )
            ]
        if (
            event.type == EventType.TOOL_CALL_START
            and getattr(event, "tool_call_name", None) == "adk_request_confirmation"
        ):
            if len(self._pending) >= 32:
                raise ValueError("Too many pending connector confirmations.")
            self._pending[call_id] = (event, [], 0)
            return []
        pending = self._pending.get(call_id)
        if pending is None:
            return [event]
        start, chunks, size = pending
        if event.type in {EventType.TOOL_CALL_ARGS, EventType.TOOL_CALL_CHUNK}:
            delta = getattr(event, "delta", "") or ""
            size += len(delta.encode())
            if size > 64_000:
                self._pending.pop(call_id, None)
                raise ValueError("Connector confirmation is too large to display safely.")
            chunks.append(delta)
            self._pending[call_id] = (start, chunks, size)
            return []
        if event.type != EventType.TOOL_CALL_END:
            return [event]
        self._pending.pop(call_id, None)
        try:
            arguments = json.loads("".join(chunks))
            if not isinstance(arguments, dict):
                raise ValueError
        except (TypeError, ValueError):
            raise ValueError("Connector confirmation is malformed.") from None
        safe = _confirmation_view(arguments)
        if safe is None and self._external_content:
            # A model can hallucinate another confirmation despite the tool
            # filter. Its copied provider content must not escape as arguments.
            safe = {}
        if safe is not None:
            self._private_confirmations.add(call_id)
        return [
            start.model_copy(update={"raw_event": None, "metadata": None}),
            ToolCallArgsEvent(
                tool_call_id=call_id, delta=json.dumps(safe if safe is not None else arguments)
            ),
            event.model_copy(update={"raw_event": None, "metadata": None}),
        ]


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
    """Project session content for the existing owner-bound encrypted store.

    Connector payloads are transient, including successful native MCP results.
    Keep safe outcomes only, never approval authority, private call arguments,
    result bodies or blocked downstream payloads. The live turn is unchanged.
    """
    if "mcp_" not in serialized and not any(name in serialized for name in _PRIVATE_TOOLS):
        return serialized
    document: dict[str, Any] = json.loads(serialized)
    changed = False
    private_ids: set[str] = set()
    confirmation_ids: set[str] = set()
    private_invocations: set[str] = set()
    # ADK duplicates a pending call inside its confirmation envelope. Index
    # both identities before projecting, including out-of-order responses.
    for event in document.get("events", []):
        parts = (event.get("content") or {}).get("parts") or []
        invocation = event.get("invocationId")
        if isinstance(invocation, str) and any(
            _private_tool_name((part.get("functionCall") or {}).get("name"))
            or _private_tool_name((part.get("functionResponse") or {}).get("name"))
            for part in parts
        ):
            private_invocations.add(invocation)
        if invocation in private_invocations:
            for part in parts:
                call = part.get("functionCall")
                if isinstance(call, dict) and isinstance(call.get("id"), str):
                    private_ids.add(call["id"])
        for part in (event.get("content") or {}).get("parts") or []:
            call = part.get("functionCall")
            if not isinstance(call, dict):
                continue
            if _private_tool_name(call.get("name")) and isinstance(call.get("id"), str):
                private_ids.add(call["id"])
            if call.get("name") != "adk_request_confirmation":
                continue
            arguments = call.get("args")
            original = (
                arguments.get("originalFunctionCall") if isinstance(arguments, dict) else None
            )
            if isinstance(original, dict) and _private_tool_name(original.get("name")):
                if isinstance(original.get("id"), str):
                    private_ids.add(original["id"])
                if isinstance(call.get("id"), str):
                    confirmation_ids.add(call["id"])
                # This is a historical skeleton, never a replay capability.
                # Native resume must recover reviewed arguments in live memory
                # and pass the exact-call ledger before dispatch.
                call["args"] = {
                    "originalFunctionCall": {
                        "id": original.get("id"),
                        "name": original["name"],
                        "args": {},
                    },
                    "toolConfirmation": {"confirmed": False},
                }
                call["partialArgs"] = None
                changed = True
            elif invocation in private_invocations:
                call["args"] = {}
                call["partialArgs"] = None
                changed = True
    for event in document.get("events", []):
        confirmations = (event.get("actions") or {}).get("requestedToolConfirmations")
        if isinstance(confirmations, dict):
            for call_id in private_ids.intersection(confirmations):
                confirmations[call_id] = {"confirmed": False}
                changed = True
        for part in (event.get("content") or {}).get("parts") or []:
            call = part.get("functionCall")
            if isinstance(call, dict) and (
                _private_tool_name(call.get("name"))
                or (
                    call.get("id") in private_ids and call.get("name") != "adk_request_confirmation"
                )
            ):
                call["args"] = {}
                call["partialArgs"] = None
                changed = True
            response = part.get("functionResponse")
            if isinstance(response, dict) and (
                _private_tool_name(response.get("name"))
                or response.get("id") in confirmation_ids
                or response.get("id") in private_ids
            ):
                result = response.get("response")
                response["response"] = _safe_result(result)
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
        external_content = False
        for message in getattr(event, "messages", []):
            if getattr(message, "role", None) == "user":
                external_content = False
            for call in getattr(message, "tool_calls", None) or []:
                if _private_tool_name(getattr(call.function, "name", None)):
                    external_content = True
                    private_call_ids.add(str(getattr(call, "id", "")))
                elif external_content:
                    private_call_ids.add(str(getattr(call, "id", "")))
                if getattr(call.function, "name", None) == "adk_request_confirmation":
                    try:
                        raw = call.function.arguments
                        if len(raw.encode()) > 64_000:
                            raise ValueError
                        parsed = json.loads(raw)
                        if not isinstance(parsed, dict):
                            raise ValueError
                        if _confirmation_view(parsed) is not None:
                            private_call_ids.add(str(call.id))
                    except (TypeError, ValueError, AttributeError):
                        private_call_ids.add(str(call.id))
        safe = []
        changed = False
        for message in getattr(event, "messages", []):
            calls = getattr(message, "tool_calls", None)
            if calls:
                safe_calls = []
                call_changed = False
                for call in calls:
                    if getattr(call.function, "name", None) == "adk_request_confirmation":
                        try:
                            raw = call.function.arguments
                            if len(raw.encode()) > 64_000:
                                raise ValueError
                            parsed = json.loads(raw)
                            if not isinstance(parsed, dict):
                                raise ValueError
                            confirmation = _confirmation_view(parsed)
                        except (TypeError, ValueError, AttributeError):
                            confirmation = {}
                        if confirmation is not None:
                            safe_calls.append(
                                call.model_copy(
                                    update={
                                        "function": call.function.model_copy(
                                            update={"arguments": json.dumps(confirmation)}
                                        ),
                                        "metadata": None,
                                        "encrypted_value": None,
                                    }
                                )
                            )
                            call_changed = True
                            continue
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
