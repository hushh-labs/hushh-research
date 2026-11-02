"""Owner-scoped visible history from completed, exclusive Email turns only.

The trusted One publication gate authors the provenance marker. This projection
does not classify messages, recover tool bodies, infer facts, or read a store.
Other specialists' answers and legacy unmarked turns never enter Email context.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal, TypedDict

EMAIL_ANSWER_KIND = "one_delegated_email_answer_v1"
MAX_HISTORY_MESSAGES = 12
MAX_MESSAGE_CHARS = 4000
MAX_HISTORY_CHARS = 16_000


class EmailHistoryMessage(TypedDict):
    role: Literal["user", "assistant"]
    content: str


def _field(value: Any, name: str, default: Any = None) -> Any:
    return value.get(name, default) if isinstance(value, Mapping) else getattr(value, name, default)


def _completed_email_answer(event: Any) -> bool:
    metadata = _field(event, "custom_metadata")
    return (
        _field(event, "author") == "one"
        and not _field(event, "partial", False)
        and not _field(event, "error_code")
        and isinstance(metadata, Mapping)
        and metadata.get("kind") == EMAIL_ANSWER_KIND
        and _field(_field(event, "content"), "role") == "model"
    )


def _visible_text(event: Any) -> str:
    # These are exact authored control/placeholder forms, not semantic filters.
    # Internal facts remain in their own turn-scoped ports, never this history.
    from hushh_mcp.one_adk.receipt_client_tools import PRIVATE_RECEIPT_ANSWER

    hidden_prefixes = (
        "[App route context]",
        "PENDING MAIL DRAFT (",
        "PENDING SOURCE-BOUND GMAIL REPLY (",
        "CURRENT AUTHENTICATED TURN FACTS (",
        "MEMORY COMMIT:",
        "LIVE MIRROR FACTS v1",
        "BEGIN SHARED-",
    )
    hidden_text = {
        PRIVATE_RECEIPT_ANSWER,
        "[redacted]",
        "[Shared information removed: it belonged to an earlier turn.]",
    }
    selected: list[str] = []
    remaining = MAX_MESSAGE_CHARS
    parts = _field(_field(event, "content"), "parts", ()) or ()
    for part in parts:
        if (
            _field(part, "thought", False)
            or _field(part, "function_call") is not None
            or _field(part, "function_response") is not None
        ):
            continue
        text = _field(part, "text")
        if not isinstance(text, str):
            continue
        clean = text.strip()
        if not clean or clean in hidden_text or clean.startswith(hidden_prefixes):
            continue
        piece = text[:remaining]
        selected.append(piece)
        remaining -= len(piece)
        if not remaining:
            break
    return "".join(selected).strip()


def project_email_history(
    session: Any,
    *,
    owner_id: str,
    conversation_id: str,
    current_invocation_id: str,
) -> list[EmailHistoryMessage]:
    """Return recent prior Email conversation text, without mutating the session.

    Call only with the trusted SDK session and ingress owner/conversation binding.
    A publication marker proves a completed exclusive Email answer, not ongoing
    Gmail permission. The existing provider port must still verify its grant.
    Each text is bounded to 4000 characters; newest messages take priority within
    twelve messages and 16000 total characters. No timestamp is synthesized.
    """
    if (
        not owner_id
        or not conversation_id
        or not current_invocation_id
        or _field(session, "user_id") != owner_id
        or _field(session, "id") != conversation_id
    ):
        return []
    events = _field(session, "events", ()) or ()
    if not isinstance(events, (list, tuple)):
        return []
    eligible = {
        invocation
        for event in events
        if isinstance(invocation := _field(event, "invocation_id"), str)
        and invocation
        and invocation != current_invocation_id
        and _completed_email_answer(event)
        and _visible_text(event)
    }
    selected: list[EmailHistoryMessage] = []
    remaining = MAX_HISTORY_CHARS
    for event in reversed(events):
        if _field(event, "invocation_id") not in eligible or _field(event, "partial", False):
            continue
        author = _field(event, "author")
        role = _field(_field(event, "content"), "role")
        visible_role: Literal["user", "assistant"]
        if author == "user" and role == "user":
            visible_role = "user"
        elif _completed_email_answer(event):
            visible_role = "assistant"
        else:
            continue
        text = _visible_text(event)
        if not text:
            continue
        selected.append({"role": visible_role, "content": text[:remaining]})
        remaining -= len(selected[-1]["content"])
        if len(selected) == MAX_HISTORY_MESSAGES or remaining == 0:
            break
    selected.reverse()
    return selected
