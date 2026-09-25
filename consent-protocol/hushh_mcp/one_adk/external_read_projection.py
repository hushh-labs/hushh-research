"""Redacted durable projection of connector-read turns, never a live mutation."""

from __future__ import annotations

from typing import Any

from google.adk.sessions import Session

from hushh_mcp.adk_bridge.contract import SpecialistReadResult
from hushh_mcp.one_adk.external_read_boundary import (
    READ_TOOLS,
    STATE_EXECUTION_SURFACE,
    STATE_EXTERNAL_READ,
    STATE_EXTERNAL_READ_CONTINUATION,
)

_EPHEMERAL = frozenset(
    {
        STATE_EXECUTION_SURFACE,
        STATE_EXTERNAL_READ,
        STATE_EXTERNAL_READ_CONTINUATION,
        "temp:hussh:workspace_chat_admission",
        "temp:hussh:mcp_approval",
        # Agent Chat stores source text behind an in-process request secret.
        # Remove both handles before encrypting a conversation snapshot so a
        # selected Gmail request cannot affect a later turn.
        "temp:hussh:gmail_information_request_workflow_id",
        "temp:hussh:gmail_information_request_context",
        "hussh:gmail_information_request_context",
        "hussh:pending_directive:gmail_information_request_reply",
    }
)
_PRIVATE_DRAFT_TOOLS = frozenset({"open_gmail_email_draft", "open_gmail_information_request_reply"})


def redacted_read_receipt(response: Any) -> dict[str, Any]:
    receipt: dict[str, Any] = {"content_redacted": True}
    try:
        structured = SpecialistReadResult.model_validate(response.get("structured"))
    except (AttributeError, ValueError):
        return receipt
    # Source labels are authored constants today. Do not start retaining file
    # names if a future source adds them; keep only opaque refs and kind here.
    safe = structured.model_dump(mode="json")
    for source in safe["sources"]:
        source["label"] = "Mail" if safe["connector"] == "mail" else "Document"
    receipt["structured"] = safe
    receipt["status"] = structured.status
    return receipt


def durable_external_read_projection(session: Session) -> Session:
    read_invocations = {
        event.invocation_id
        for event in session.events
        if event.content
        for part in (event.content.parts or [])
        if (part.function_call and part.function_call.name in READ_TOOLS)
        or (part.function_response and part.function_response.name in READ_TOOLS)
    }
    private_draft_invocations = {
        event.invocation_id
        for event in session.events
        if event.content
        for part in (event.content.parts or [])
        if (part.function_call and part.function_call.name in _PRIVATE_DRAFT_TOOLS)
        or (part.function_response and part.function_response.name in _PRIVATE_DRAFT_TOOLS)
    }
    if (
        not read_invocations
        and not private_draft_invocations
        and not any(key in session.state for key in _EPHEMERAL)
        and not any(
            key in event.actions.state_delta for event in session.events for key in _EPHEMERAL
        )
    ):
        return session
    projected = session.model_copy(deep=True)
    for key in _EPHEMERAL:
        projected.state.pop(key, None)
    for event in projected.events:
        for key in _EPHEMERAL:
            event.actions.state_delta.pop(key, None)
        if event.content is None:
            continue
        for part in event.content.parts or []:
            # Keep SDK call names, IDs, associations and opaque thought
            # signatures. Only tool arguments/results are redacted. Ordinary
            # user requests and the encrypted assistant answer are preserved.
            # Unrelated tools may have completed before Mail was selected;
            # retain their governed history cards. After Mail, only governed
            # reviewed MCP calls or the redacted client-only draft may follow.
            if part.function_call and part.function_call.name in READ_TOOLS:
                part.function_call.args = {}
            if part.thought and part.text:
                part.text = None
            if part.function_response and part.function_response.name in READ_TOOLS:
                part.function_response.response = redacted_read_receipt(
                    part.function_response.response
                )
            if event.invocation_id in private_draft_invocations and (
                (part.function_call and part.function_call.name in _PRIVATE_DRAFT_TOOLS)
                or (part.function_response and part.function_response.name in _PRIVATE_DRAFT_TOOLS)
            ):
                if part.function_call:
                    part.function_call.args = {}
                if part.function_response:
                    part.function_response.response = {"content_redacted": True}
    return projected
