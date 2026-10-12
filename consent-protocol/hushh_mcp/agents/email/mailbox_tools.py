"""Reviewed Gmail mailbox actions and To-do follow-ups for One's typed chat.

The Calendar proposal pattern (``hushh_mcp/agents/calendar/tools.py``) applied
to Gmail. The tool resolves the exact messages and returns a confirmation
directive; Gmail changes only when the owner presses the card's control. Gmail
credentials stay inside ``GmailReceiptsService``; message IDs stay server-side.
"""

from __future__ import annotations

import logging
from typing import Any
from uuid import uuid4

from google.adk.tools.tool_context import ToolContext

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.gmail_mailbox_actions import (
    LABEL_ACTIONS,
    MAILBOX_ACTIONS,
    get_gmail_mailbox_actions,
)
from hushh_mcp.services.gmail_metadata_reader import GmailMetadataError, GmailMetadataReader
from hushh_mcp.services.gmail_receipts_service import GmailApiError, get_gmail_receipts_service

logger = logging.getLogger(__name__)

_STATE_USER_ID = "hussh:user_id"
_STATE_EXECUTION_SURFACE = "temp:one_execution_surface"
# The app drains this key into the review card. Subjects and senders travel
# only here, to the owner's card, and are never returned to the tool-bearing
# model: untrusted mail text must not steer One's next tool call.
_STATE_PENDING_DIRECTIVE = "hussh:pending_directive:gmail_mailbox"
_UNAVAILABLE = "I couldn't reach Gmail just now. Try again in a moment."
# Card and voice copy per action: (verb for the confirm control, summary phrase).
_ACTION_COPY: dict[str, tuple[str, str]] = {
    "archive": ("Archive", "Archive"),
    "add_label": ("Add label", "Add the label “{label}” to"),
    "remove_label": ("Remove label", "Remove the label “{label}” from"),
    "mark_read": ("Mark as read", "Mark as read"),
    "mark_unread": ("Mark as unread", "Mark as unread"),
    "trash": ("Move to Trash", "Move to Trash"),
}
_READ_ERRORS = {
    "connect_required": "Connect Mail in Connections first.",
    "reconnect_required": "Reconnect Mail in Connections to continue.",
    "connection_changed": "Your Mail connection changed. Please try again.",
    "label_not_found": "I couldn't find a Gmail label with that name.",
    "invalid_argument": "Describe which emails to change with a sender, subject, words or dates.",
    "response_too_large": "That selection is too large. Try a narrower description.",
}


def _todo_title(value: Any) -> str:
    """Keep a visible Gmail follow-up title short and inert."""

    subject = " ".join(str(value or "").split())
    if not subject:
        subject = "Email follow-up"
    return (f"Follow up: {subject}").encode("utf-8")[:240].decode("utf-8", errors="ignore")


def _todo_read_error(error: GmailApiError) -> dict[str, Any]:
    if error.code == "GMAIL_NOT_CONNECTED":
        return {"status": "connect_required", "message": _READ_ERRORS["connect_required"]}
    if error.code in {"GMAIL_READ_PERMISSION_REQUIRED", "GMAIL_REAUTH_REQUIRED"}:
        return {"status": "reconnect_required", "message": _READ_ERRORS["reconnect_required"]}
    logger.warning("one_adk_gmail_todo_propose_failed code=%s", error.code)
    return {"status": "failed", "message": _UNAVAILABLE}


def _connection_directive(tool_context: ToolContext) -> dict[str, Any]:
    message = "Allow One to organize your Gmail before I can change your mailbox."
    directive = {
        "kind": "action",
        "delegateAgentId": "agent_email",
        "payload": {
            "type": "gmail.connect",
            "purpose": "modify",
            "summary": message,
            "confirmLabel": "Allow Gmail changes",
        },
    }
    tool_context.state[_STATE_PENDING_DIRECTIVE] = directive
    return {
        "status": "connection_required",
        "message": message,
        "next_step": "The app is showing a Gmail permission control. Ask the person to approve it.",
    }


def _summary(action: str, label: str, preview: dict[str, Any]) -> tuple[str, str]:
    verb, phrase = _ACTION_COPY[action]
    items = preview.get("untrusted_external_content") or []
    count = len(items)
    noun = "email" if count == 1 else f"{count} emails"
    subject = str(items[0].get("subject") or "") if count == 1 else ""
    target = f"“{subject}”" if subject else noun
    more = " (the first matches only)" if preview.get("truncated") else ""
    return f"{phrase.format(label=label)} {target}{more}?", verb


async def propose_gmail_mailbox_change(
    tool_context: ToolContext,
    action: str,
    query: str = "",
    mailbox: str = "inbox",
    limit: int = 10,
    label: str = "",
) -> dict[str, Any]:
    """Prepare a Gmail mailbox change for the owner's review. Nothing changes until they confirm.

    action is one of archive, add_label, remove_label, mark_read, mark_unread or
    trash (Gmail's recoverable Trash). query is a Gmail search built from the
    person's description (sender, subject, words, unread, dates); leave it empty
    only for their newest mail. mailbox is inbox, sent or anywhere. limit is how
    many matching emails, 1 to 25. label is the label name for add_label and
    remove_label only.
    """
    user_id = str(tool_context.state.get(_STATE_USER_ID) or "").strip()
    if (
        not user_id
        or tool_context.state.get(_STATE_EXECUTION_SURFACE) != "typed_chat"
        or not connector_feature_enabled("gmail_chat_reads", user_id)
    ):
        return {"status": "unavailable", "message": "Mailbox changes are available in chat only."}
    if action not in MAILBOX_ACTIONS:
        return {"status": "invalid_action", "message": "Choose one mailbox change."}
    if (action in LABEL_ACTIONS) != bool(str(label or "").strip()):
        return {"status": "invalid_label", "message": "Name the label for a label change only."}

    async def require_access() -> None:
        # The chat turn's owner and surface, rechecked around every provider hop.
        if (
            str(tool_context.state.get(_STATE_USER_ID) or "").strip() != user_id
            or tool_context.state.get(_STATE_EXECUTION_SURFACE) != "typed_chat"
        ):
            raise PermissionError("Mail owner authority is unavailable")

    try:
        proposal = await get_gmail_mailbox_actions().propose(
            user_id=user_id,
            action=action,
            query=str(query or ""),
            mailbox=str(mailbox or "inbox"),
            limit=limit if type(limit) is int else 10,
            label=str(label or ""),
            require_access=require_access,
        )
    except GmailApiError as exc:
        if exc.code == "GMAIL_MODIFY_PERMISSION_REQUIRED":
            return _connection_directive(tool_context)
        if exc.code == "GMAIL_NOT_CONNECTED":
            return {"status": "connect_required", "message": _READ_ERRORS["connect_required"]}
        logger.warning("one_adk_gmail_mailbox_propose_failed code=%s", exc.code)
        return {"status": "failed", "message": _UNAVAILABLE}
    except GmailMetadataError as exc:
        return {"status": exc.code, "message": _READ_ERRORS.get(exc.code, _UNAVAILABLE)}
    except Exception:  # noqa: BLE001 - the model is told something failed, not why internally
        logger.exception("one_adk_gmail_mailbox_propose_failed reason=unexpected")
        return {"status": "failed", "message": _UNAVAILABLE}
    preview = proposal["preview"]
    if proposal["status"] == "no_match":
        return {
            "status": "no_match",
            "message": "No emails matched that description, so nothing was prepared.",
        }
    summary, confirm_label = _summary(action, str(label or "").strip(), preview)
    messages = [
        {
            "subject": item.get("subject"),
            "sender": item.get("sender"),
            "receivedAt": item.get("received_at"),
        }
        for item in preview["untrusted_external_content"]
    ]
    directive = {
        "kind": "action",
        "delegateAgentId": "agent_email",
        "payload": {
            "type": "gmail.execute_mailbox_proposal",
            "proposalId": proposal["proposal_id"],
            "action": action,
            "label": str(label or "").strip() or None,
            "summary": summary,
            "confirmLabel": confirm_label,
            "expiresAt": proposal["expires_at"],
            "messages": messages,
            "truncated": bool(preview.get("truncated")),
        },
    }
    tool_context.state[_STATE_PENDING_DIRECTIVE] = directive
    return {
        "status": "confirmation_required",
        "action": action,
        "count": len(messages),
        "first_matches_only": bool(preview.get("truncated")),
        "message": (
            "The app is showing the exact emails for the owner's confirmation. "
            "Nothing changes in Gmail until they press the confirmation control."
        ),
    }


async def propose_gmail_todo(
    tool_context: ToolContext,
    query: str = "",
    mailbox: str = "inbox",
    limit: int = 10,
) -> dict[str, Any]:
    """Prepare selected Gmail follow-ups for the owner's To-do list.

    Use only when the owner explicitly asks to add named email follow-ups to
    their list. ``query`` is a Gmail search from the owner's description;
    leave it empty only for their newest mail. No Gmail message is changed,
    and an email's received time is never treated as a due date.
    """

    user_id = str(tool_context.state.get(_STATE_USER_ID) or "").strip()
    if (
        not user_id
        or tool_context.state.get(_STATE_EXECUTION_SURFACE) != "typed_chat"
        or not connector_feature_enabled("gmail_chat_reads", user_id)
    ):
        return {"status": "unavailable", "message": "Gmail follow-ups are available in chat only."}

    async def require_access() -> None:
        if (
            str(tool_context.state.get(_STATE_USER_ID) or "").strip() != user_id
            or tool_context.state.get(_STATE_EXECUTION_SURFACE) != "typed_chat"
        ):
            raise PermissionError("Mail owner authority is unavailable")

    bounded_limit = limit if type(limit) is int and 1 <= limit <= 10 else 10
    normalized_mailbox = str(mailbox or "inbox")
    normalized_query = str(query or "")
    operation = "search_inbox" if normalized_query.strip() else "list_recent"
    arguments: dict[str, Any] = {"mailbox": normalized_mailbox, "limit": bounded_limit}
    if operation == "search_inbox":
        arguments["query"] = normalized_query
    try:
        reader = GmailMetadataReader(
            gmail=get_gmail_receipts_service(),
            user_id=user_id,
            require_access=require_access,
        )
        preview = await reader.read(operation, arguments)
    except GmailApiError as exc:
        return _todo_read_error(exc)
    except GmailMetadataError as exc:
        return {"status": exc.code, "message": _READ_ERRORS.get(exc.code, _UNAVAILABLE)}
    except PermissionError:
        raise
    except Exception:  # noqa: BLE001 - provider errors never enter the chat transcript
        logger.exception("one_adk_gmail_todo_propose_failed reason=unexpected")
        return {"status": "failed", "message": _UNAVAILABLE}

    messages = list(preview.get("untrusted_external_content") or [])
    if not messages:
        return {"status": "no_match", "message": "No emails matched that description."}

    proposal_id = f"gmail_todo_{uuid4().hex}"
    visible_messages = [
        {
            "subject": item.get("subject"),
            "sender": item.get("sender"),
            "receivedAt": item.get("received_at"),
        }
        for item in messages
    ]
    todos = [
        {"id": f"{proposal_id}:{index}", "title": _todo_title(item.get("subject"))}
        for index, item in enumerate(messages, start=1)
    ]
    noun = "this email" if len(todos) == 1 else f"these {len(todos)} emails"
    more = " (the first matches only)" if preview.get("truncated") else ""
    directive = {
        "kind": "action",
        "delegateAgentId": "agent_email",
        "payload": {
            "type": "gmail.create_todos",
            "proposalId": proposal_id,
            "summary": f"Add follow-ups for {noun}{more} to your To-do list?",
            "confirmLabel": "Add to To-do list",
            "messages": visible_messages,
            "todos": todos,
            "truncated": bool(preview.get("truncated")),
        },
    }
    tool_context.state[f"{_STATE_PENDING_DIRECTIVE}:todo"] = directive
    return {
        "status": "confirmation_required",
        "count": len(todos),
        "first_matches_only": bool(preview.get("truncated")),
        "message": "The app is showing the selected emails for confirmation.",
    }


GMAIL_MAILBOX_TOOLS = [propose_gmail_mailbox_change, propose_gmail_todo]
