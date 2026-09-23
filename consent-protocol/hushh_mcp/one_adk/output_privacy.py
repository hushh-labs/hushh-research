"""Public One output projections; provider continuation state stays untouched."""

from __future__ import annotations

from typing import Any

from ag_ui.core import BaseEvent, MessagesSnapshotEvent


def public_event(event: BaseEvent) -> BaseEvent | None:
    """Remove reasoning from the wire without mutating the stored SDK event."""
    event_type = getattr(event.type, "value", event.type)
    if str(event_type).startswith("REASONING_"):
        return None
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
