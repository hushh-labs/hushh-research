"""Public One output projections; provider continuation state stays untouched."""

from __future__ import annotations

from typing import Any

from ag_ui.core import (
    BaseEvent,
    MessagesSnapshotEvent,
    ReasoningMessageContentEvent,
    RunErrorEvent,
    StateDeltaEvent,
    StateSnapshotEvent,
)

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


class ThoughtSummaryReplayFilter:
    """Drop a thought-summary message that replays text this turn already streamed.

    With SSE streaming the bridge forwards a model's thought summary twice: once
    from the partial event while it streams, and again from the final aggregated
    event under a new message id (measured 2026-09-25: the same 231-character
    summary arrived twice, 2.2 s apart). Only a whole replayed message is dropped:
    the first chunk of a new message must equal an earlier message's complete text
    or the complete text streamed so far. A genuine streaming piece is never
    compared against a substring, so short chunks cannot be lost to coincidence.
    One instance serves exactly one turn.
    """

    def __init__(self) -> None:
        self._messages: dict[str, str] = {}
        self._order: list[str] = []
        self._suppressed: set[str] = set()

    def admit(self, event: BaseEvent) -> bool:
        if not isinstance(event, ReasoningMessageContentEvent):
            return True
        message_id = str(event.message_id or "")
        delta = event.delta or ""
        if message_id in self._suppressed:
            return False
        if message_id in self._messages:
            self._messages[message_id] += delta
            return True
        candidate = delta.strip()
        if candidate:
            prior = [self._messages[key].strip() for key in self._order]
            if (
                candidate in prior
                or candidate == "".join(self._messages[key] for key in self._order).strip()
            ):
                self._suppressed.add(message_id)
                return False
        self._messages[message_id] = delta
        self._order.append(message_id)
        return True


def public_event(event: BaseEvent, *, allow_thought_summary: bool = False) -> BaseEvent | None:
    """Expose only bounded provider summary text on authenticated Chat.

    Thought signatures, provider metadata and reasoning snapshots never cross
    this projection. The ADK continuation event remains untouched.
    """
    event_type = getattr(event.type, "value", event.type)
    if str(event_type).startswith("REASONING_"):
        if allow_thought_summary and isinstance(event, ReasoningMessageContentEvent):
            summary = event.delta[:2048]
            if summary:
                return event.model_copy(
                    update={
                        "delta": summary,
                        "metadata": {"husshThoughtSummary": True},
                        "raw_event": None,
                    }
                )
        return None
    if isinstance(event, RunErrorEvent):
        # The installed bridge builds this event from str(exception). Neither
        # its message nor its code is safe to forward to browser diagnostics.
        return event.model_copy(
            update={
                "message": "One couldn't finish that request. Please try again.",
                "code": "AGENT_ERROR",
                "raw_event": None,
            }
        )
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


_PART_DATA_FIELDS = (
    "function_call",
    "function_response",
    "inline_data",
    "file_data",
    "executable_code",
    "code_execution_result",
    "thought_signature",
)


def _part_carries_data(part: Any) -> bool:
    text = getattr(part, "text", None)
    if isinstance(text, str) and text:
        return True
    return any(getattr(part, name, None) for name in _PART_DATA_FIELDS)


def drop_empty_history_parts(llm_request: Any) -> int:
    """Remove history parts that carry no data before the provider sees them.

    With thought summaries on, ADK's streaming aggregation can store a model
    turn with an empty ``thought`` part (no text, no signature). Replaying it
    made every second turn in a conversation fail with a provider 400 (measured
    2026-09-25). A part with a thought signature is kept: Gemini needs it to
    continue reasoning. Only the outgoing request changes; stored history is
    untouched. Returns the number of parts removed.
    """
    removed = 0
    contents = getattr(llm_request, "contents", None)
    if not isinstance(contents, list):
        return 0
    kept_contents = []
    for content in contents:
        parts = getattr(content, "parts", None)
        if not isinstance(parts, list):
            kept_contents.append(content)
            continue
        kept = [part for part in parts if _part_carries_data(part)]
        removed += len(parts) - len(kept)
        if kept:
            content.parts = kept
            kept_contents.append(content)
    llm_request.contents = kept_contents
    return removed
