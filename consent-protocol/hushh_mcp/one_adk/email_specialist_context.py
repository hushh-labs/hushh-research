"""Transient Email task context and proposal admission at One's existing boundary."""

from __future__ import annotations

from typing import Any

from hushh_mcp.one_adk.email_memory_turn import (
    STATE_EMAIL_MEMORY,
    STATE_EMAIL_MEMORY_PENDING,
    pending_memory_receipt,
)
from hushh_mcp.one_adk.email_review_contract import valid_gmail_review
from hushh_mcp.one_adk.receipt_memory_turn import resolve_receipt_memory
from hushh_mcp.one_adk.request_secrets import resolve_request_secret
from hushh_mcp.services.email_oss.memory import memory_save_digest
from hushh_mcp.services.email_oss.turn_context import project_email_history


def email_task_context(
    tool_context: Any, *, owner_id: str, conversation_id: str, agent_id: str
) -> dict[str, Any]:
    state = tool_context.state
    is_email = agent_id == "agent_email"
    stored_cursor = state.get("hussh:receipt_cursor")

    async def email_text(text: str) -> None:
        from hushh_mcp.one_adk.search_answer import publish_email_preview

        await publish_email_preview(tool_context, text)

    return {
        "receipt_memory": resolve_receipt_memory(state.get) if is_email else None,
        "receipt_cursor": stored_cursor
        if is_email and isinstance(stored_cursor, str) and stored_cursor
        else None,
        "mail_read_offer": state.get("hussh:mail_read_offer") if is_email else None,
        "memory_markdown": resolve_request_secret(state.get(STATE_EMAIL_MEMORY))
        if is_email
        else "",
        "pending_email_draft": resolve_request_secret(state.get("temp:hussh:pending_email_draft"))
        if is_email
        else "",
        "email_page": state.get("hussh:email_page") if is_email else None,
        "supports_email_reviews": state.get("temp:one_email_review_contract") is True,
        "email_history": project_email_history(
            getattr(tool_context, "session", None),
            owner_id=owner_id,
            conversation_id=conversation_id,
            current_invocation_id=str(getattr(tool_context, "invocation_id", "") or ""),
        )
        if is_email
        else [],
        "email_selection": state.get("hussh:email_selection") if is_email else None,
        "on_email_text": email_text if is_email else None,
    }


def admit_email_directive(tool_context: Any, *, kind: str, payload: dict) -> bool:
    memory_proposal = (
        payload.get("kind") == "email_memory_save"
        and payload.get("owner_id") == str(tool_context.state.get("hussh:user_id") or "")
        and set(payload)
        == {"kind", "owner_id", "request_id", "domain_tag", "fact_markdown", "section", "digest"}
        and isinstance(payload.get("fact_markdown"), str)
        and 1 <= len(payload["fact_markdown"]) <= 2048
        and payload.get("digest") == memory_save_digest(payload)
    )
    if kind != "action" or not (memory_proposal or valid_gmail_review(payload)):
        return False
    if memory_proposal:
        tool_context.state[STATE_EMAIL_MEMORY_PENDING] = pending_memory_receipt(payload)
    return True
