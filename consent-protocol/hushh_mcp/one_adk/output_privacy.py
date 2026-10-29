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

from hushh_mcp.one_adk.owner_ai_run_errors import (
    is_owner_ai_run_error,
    owner_ai_bridge_error,
    owner_ai_error_for_exception,
)
from hushh_mcp.one_adk.receipt_client_tools import PRIVATE_RECEIPT_ANSWER
from hushh_mcp.one_adk.run_errors import (
    content_filtered_error,
    is_authored_run_error,
    managed_authority_error,
    transient_model_error_for_exception,
    transient_model_run_error,
)
from hushh_mcp.services.chat_history_rollout import (
    CHAT_HISTORY_UPGRADING,
    CHAT_HISTORY_UPGRADING_MESSAGE,
    ChatHistoryUpdatingError,
)
from hushh_mcp.services.chat_key import (
    CHAT_KEY_ERROR_MESSAGES,
    CHAT_KEY_ERRORS,
    CHAT_KEY_RECOVERY_MESSAGE,
    CHAT_KEY_REQUIRED_CODE,
)

CHAT_KEY_RUN_ERROR = RunErrorEvent(message=CHAT_KEY_RECOVERY_MESSAGE, code=CHAT_KEY_REQUIRED_CODE)
CHAT_HISTORY_UPGRADING_RUN_ERROR = RunErrorEvent(
    message=CHAT_HISTORY_UPGRADING_MESSAGE,
    code=CHAT_HISTORY_UPGRADING,
)


def normalize_history_error(event: BaseEvent) -> BaseEvent:
    """Restore fixed codes after the SDK stringifies a background refusal."""
    if isinstance(event, RunErrorEvent):
        if event.message == CHAT_HISTORY_UPGRADING_MESSAGE:
            return CHAT_HISTORY_UPGRADING_RUN_ERROR
        if event.message in CHAT_KEY_ERROR_MESSAGES:
            return CHAT_KEY_RUN_ERROR
    # The owner's own key refused first: a 429 there is their quota, not our capacity.
    return (
        content_filtered_error(event)
        or managed_authority_error(event)
        or owner_ai_bridge_error(event)
        or transient_model_run_error(event)
        or event
    )


def safe_exception_event(exc: Exception) -> RunErrorEvent:
    """Only fixed, content-free failure messages may cross the browser boundary."""
    if isinstance(exc, ChatHistoryUpdatingError):
        return CHAT_HISTORY_UPGRADING_RUN_ERROR
    if isinstance(exc, CHAT_KEY_ERRORS):
        return CHAT_KEY_RUN_ERROR
    return (
        content_filtered_error(exc)
        or managed_authority_error(exc)
        or owner_ai_error_for_exception(exc)
        or transient_model_error_for_exception(exc)
        or RunErrorEvent(
            message="One couldn't finish that request. Please try again.", code="AGENT_ERROR"
        )
    )


_PRIVATE_STATE_KEYS = frozenset(
    {
        "temp:hussh:mcp_approval",
        "hussh:mail_read_offer",
        "hussh:calendar_event_read_offer",
        "hussh:calendar_invitation_read_offer",
        "hussh:calendar_list_read_offer",
    }
)


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
        if (
            (event.code, event.message)
            in {
                (CHAT_KEY_REQUIRED_CODE, CHAT_KEY_RECOVERY_MESSAGE),
                (CHAT_HISTORY_UPGRADING, CHAT_HISTORY_UPGRADING_MESSAGE),
            }
            or is_authored_run_error(event)
            or is_owner_ai_run_error(event)
        ):
            # A fixed, content-free refusal the person can act on.
            return event.model_copy(update={"raw_event": None})
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


def _redaction_placeholder(part: Any) -> bool:
    response = getattr(getattr(part, "function_response", None), "response", None)
    return isinstance(response, dict) and response.get("content_redacted") is True


def _signature_only(part: Any) -> bool:
    return bool(getattr(part, "thought_signature", None)) and not any(
        getattr(part, name, None) for name in ("text", "function_call", "function_response")
    )


def _replay_placeholder(part: Any, role: Any, answered: set[str]) -> bool:
    if _redaction_placeholder(part):
        return True
    call = getattr(part, "function_call", None)
    if call is not None:
        # ADK prunes a result without its call, never a call without its result.
        return bool(call.id) and call.id not in answered
    return role == "model" and getattr(part, "text", None) == PRIVATE_RECEIPT_ANSWER


def drop_replayed_tool_placeholders(llm_request: Any) -> int:
    """Keep stored-history placeholders out of the outgoing model request.

    Stored history keeps an earlier read, draft or receipt call with emptied
    arguments and a ``content_redacted`` result, and an earlier spending answer
    as PRIVATE_RECEIPT_ANSWER (external_read_projection). Replayed, the model
    copied them: on UAT (2026-10-29) each mail request after the first in a chat
    became an ``ask_email_agent`` call with no request, and spending questions
    were answered with that sentence. A call that never got its result, such as
    a receipt handback the device did not answer, also made every later Azure
    request invalid. The owner's questions and earlier visible answers stay.
    Only this request changes; stored history is untouched. Returns the number
    of parts removed.
    """
    contents = getattr(llm_request, "contents", None)
    if not isinstance(contents, list):
        return 0
    answered = {
        part.function_response.id
        for content in contents
        for part in getattr(content, "parts", None) or []
        if getattr(part, "function_response", None) is not None
        and part.function_response.id
        and not _redaction_placeholder(part)
    }
    removed = 0
    kept_contents = []
    for content in contents:
        parts = getattr(content, "parts", None)
        if not isinstance(parts, list):
            kept_contents.append(content)
            continue
        role = getattr(content, "role", None)
        drop = [_replay_placeholder(part, role, answered) for part in parts]
        pairs = list(zip(drop, parts, strict=True))
        if any(drop):
            # Azure rejects a reasoning item whose following call or answer is gone.
            pairs = [(gone or _signature_only(part), part) for gone, part in pairs]
        kept = [part for gone, part in pairs if not gone]
        removed += len(parts) - len(kept)
        if len(kept) == len(parts):
            kept_contents.append(content)
        elif kept:
            kept_contents.append(content.model_copy(update={"parts": kept}))
    llm_request.contents = kept_contents
    return removed
