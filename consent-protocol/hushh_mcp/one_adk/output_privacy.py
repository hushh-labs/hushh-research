"""Public One output projections; provider continuation state stays untouched."""

from __future__ import annotations

from typing import Any

from ag_ui.core import BaseEvent, MessagesSnapshotEvent, StateDeltaEvent, StateSnapshotEvent

_PRIVATE_STATE_KEYS = frozenset({"temp:hussh:mcp_approval"})


def _public_state(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: item for key, item in value.items() if key not in _PRIVATE_STATE_KEYS}
    return value


def _private_pointer(pointer: Any) -> bool:
    if not isinstance(pointer, str) or not pointer.startswith("/"):
        return False
    key = pointer.split("/", 2)[1].replace("~1", "/").replace("~0", "~")
    return key in _PRIVATE_STATE_KEYS


def public_event(event: BaseEvent) -> BaseEvent | None:
    """Remove reasoning from the wire without mutating the stored SDK event."""
    event_type = getattr(event.type, "value", event.type)
    if str(event_type).startswith("REASONING_"):
        return None
    if isinstance(event, StateSnapshotEvent):
        return event.model_copy(
            update={"snapshot": _public_state(event.snapshot), "raw_event": None}
        )
    if isinstance(event, StateDeltaEvent):
        delta = []
        for operation in event.delta:
            if _private_pointer(operation.get("path")) or _private_pointer(operation.get("from")):
                continue
            projected = dict(operation)
            if projected.get("path") == "" and "value" in projected:
                projected["value"] = _public_state(projected["value"])
            delta.append(projected)
        return event.model_copy(update={"delta": delta, "raw_event": None})
    if isinstance(event, MessagesSnapshotEvent):
        messages = [
            message
            for message in event.messages
            if (message.get("role") if isinstance(message, dict) else message.role) != "reasoning"
        ]
        return event.model_copy(update={"messages": messages, "raw_event": None})
    if event.raw_event is not None:
        return event.model_copy(update={"raw_event": None})
    return event


def public_text(event: Any) -> str:
    """Project visible text from a provider event, including legacy sessions."""
    parts = getattr(getattr(event, "content", None), "parts", None) or []
    return "".join(
        part.text
        for part in parts
        if isinstance(getattr(part, "text", None), str)
        and not bool(getattr(part, "thought", False))
    ).strip()
