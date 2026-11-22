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

from hushh_mcp.services.email_delegated_read import current_mail_read_offer
from hushh_mcp.services.gmail_mailbox_actions import (
    LABEL_ACTIONS,
    MAILBOX_ACTIONS,
    get_gmail_mailbox_actions,
)
from hushh_mcp.services.gmail_metadata_reader import GmailMetadataError, GmailMetadataReader
from hushh_mcp.services.gmail_receipts_service import GmailApiError, get_gmail_receipts_service

logger = logging.getLogger(__name__)

_STATE_USER_ID = "hussh:user_id"
_STATE_CONVERSATION_ID = "hussh:conversation_id"
_STATE_EXECUTION_SURFACE = "temp:one_execution_surface"
_STATE_MAIL_READ_OFFER = "hussh:mail_read_offer"
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


def _resolve_offered_message_ids(
    tool_context: ToolContext,
    *,
    user_id: str,
    ordinals: list[int] | None,
    max_items: int,
) -> tuple[tuple[str, ...] | None, str | None, str | None, dict[str, Any] | None]:
    """Resolve 1-based positions from server-minted ``STATE_MAIL_READ_OFFER``.

    Returns ``(message_ids, account, mailbox, error_response)``. Never accepts
    model-supplied provider IDs.
    """
    if not ordinals:
        return None, None, None, None
    if not isinstance(ordinals, list):
        return (
            None,
            None,
            None,
            {
                "status": "invalid_argument",
                "message": "Choose email positions from the list shown in this chat.",
            },
        )
    clean_ordinals: list[int] = []
    for value in ordinals[:max_items]:
        if type(value) is not int or not 1 <= value <= 25:
            return (
                None,
                None,
                None,
                {
                    "status": "invalid_argument",
                    "message": "Choose email positions from the list shown in this chat.",
                },
            )
        if value not in clean_ordinals:
            clean_ordinals.append(value)
    if not clean_ordinals:
        return None, None, None, None

    conversation_id = str(tool_context.state.get(_STATE_CONVERSATION_ID) or "").strip() or "chat"
    offer = current_mail_read_offer(
        tool_context.state.get(_STATE_MAIL_READ_OFFER),
        owner_id=user_id,
        conversation_id=conversation_id,
    )
    if offer is None:
        return (
            None,
            None,
            None,
            {
                "status": "source_changed",
                "message": "That email list expired. Search for those emails again first.",
            },
        )
    resolved: list[str] = []
    for ordinal in clean_ordinals:
        msg_id = offer.message_id_at(ordinal)
        if not msg_id:
            return (
                None,
                None,
                None,
                {
                    "status": "invalid_argument",
                    "message": (
                        f"Only {len(offer.message_ids)} email(s) were shown. "
                        "Choose positions from that list."
                    ),
                },
            )
        if msg_id not in resolved:
            resolved.append(msg_id)
    return tuple(resolved), offer.account, offer.mailbox, None


_FRIENDLY_ACTION_MAP: dict[str, tuple[str, str]] = {
    "star": ("add_label", "STARRED"),
    "unstar": ("remove_label", "STARRED"),
    "mark_important": ("add_label", "IMPORTANT"),
    "unmark_important": ("remove_label", "IMPORTANT"),
    "unarchive": ("add_label", "INBOX"),
    "move_to_inbox": ("add_label", "INBOX"),
    "mark_spam": ("add_label", "SPAM"),
    "not_spam": ("remove_label", "SPAM"),
}


async def propose_gmail_mailbox_change(
    tool_context: ToolContext,
    action: str,
    query: str = "",
    mailbox: str = "inbox",
    limit: int = 10,
    label: str = "",
    ordinals: list[int] | None = None,
    scope: str = "message",
    confirmed: bool = False,
) -> dict[str, Any]:
    """Prepare a Gmail mailbox change for the owner's review. Nothing changes until they confirm.

    action is one of archive, unarchive, move_to_inbox, add_label, remove_label,
    mark_read, mark_unread, star, unstar, mark_important, unmark_important,
    mark_spam, not_spam, trash (Gmail's recoverable Trash), or untrash (recover
    messages from Trash — requires confirmed=True after asking).
    Use ``ordinals`` (e.g. ``[1, 3]``) when the owner refers to emails by
    position from the list already shown in this chat — the server resolves the
    exact offered message IDs without re-searching. Set ``scope="thread"`` to
    apply the label/change across every message in the selected thread(s).
    Otherwise pass ``query`` built from the person's description (sender, subject,
    words, unread, dates); leave it empty only for their newest mail. mailbox is
    inbox, sent or anywhere. limit is how many matching emails, 1 to 25. label is
    the label name for add_label and remove_label only.
    """
    from hushh_mcp.one_adk.workspace_mcp_tools import _owner

    user_id = await _owner(tool_context, "gmail")
    if user_id is None:
        return {"status": "unavailable", "message": "Mailbox changes require an authorized chat."}

    raw_action = str(action or "").strip().lower()
    raw_label = str(label or "").strip()

    # Recovering from Trash uses Gmail's dedicated /messages/{id}/untrash endpoint.
    if raw_action == "untrash":
        offered_ids, offered_account, _, ordinal_error = _resolve_offered_message_ids(
            tool_context, user_id=user_id, ordinals=ordinals, max_items=25
        )
        if ordinal_error is not None:
            return ordinal_error
        if not offered_ids:
            return {
                "status": "invalid_argument",
                "message": "Search Trash first (e.g. query='in:trash') and pass ordinals=[...] to recover from Trash.",
            }
        if not confirmed:
            return {
                "status": "confirmation_required",
                "action": "untrash",
                "count": len(offered_ids),
                "message": (
                    f"Ready to recover {len(offered_ids)} email(s) from Trash. "
                    "Ask the person to confirm, then call again with confirmed=True."
                ),
            }
        try:
            from hushh_mcp.services.gmail_labels_drafts_settings_service import (
                get_gmail_labels_drafts_settings_service,
            )

            return await get_gmail_labels_drafts_settings_service().untrash_messages(
                user_id=user_id, message_ids=offered_ids
            )
        except GmailApiError as exc:
            if exc.code == "GMAIL_MODIFY_PERMISSION_REQUIRED":
                return _connection_directive(tool_context)
            return {"status": "failed", "message": exc.message}

    if raw_action in _FRIENDLY_ACTION_MAP:
        resolved_action, resolved_label = _FRIENDLY_ACTION_MAP[raw_action]
    else:
        resolved_action, resolved_label = raw_action, raw_label

    if resolved_action not in MAILBOX_ACTIONS:
        return {"status": "invalid_action", "message": "Choose one mailbox change."}
    if (resolved_action in LABEL_ACTIONS) != bool(resolved_label):
        return {"status": "invalid_label", "message": "Name the label for a label change only."}

    offered_ids, offered_account, offered_mailbox, ordinal_error = _resolve_offered_message_ids(
        tool_context,
        user_id=user_id,
        ordinals=ordinals,
        max_items=25,
    )
    if ordinal_error is not None:
        return ordinal_error

    async def require_access() -> None:
        if await _owner(tool_context, "gmail") != user_id:
            raise PermissionError("Mail owner authority is unavailable")

    # Optional thread-wide expansion ("apply label Work to all messages in this thread")
    if offered_ids is not None and str(scope or "message").strip().lower() == "thread":
        conversation_id = (
            str(tool_context.state.get(_STATE_CONVERSATION_ID) or "").strip() or "chat"
        )
        offer = current_mail_read_offer(
            tool_context.state.get(_STATE_MAIL_READ_OFFER),
            owner_id=user_id,
            conversation_id=conversation_id,
        )
        if offer is not None and ordinals:
            tids = [tid for o in ordinals if type(o) is int and (tid := offer.thread_id_at(o))]
            if tids:
                try:
                    expand_reader = GmailMetadataReader(
                        gmail=get_gmail_receipts_service(),
                        user_id=user_id,
                        require_access=require_access,
                        expect_account=offered_account,
                    )
                    expanded = await expand_reader.resolve_thread_message_ids(tids, max_items=25)
                    if expanded:
                        offered_ids = expanded
                except Exception:  # noqa: BLE001 - fall back to direct offered message IDs
                    pass

    try:
        await require_access()
        propose_kwargs: dict[str, Any] = {
            "user_id": user_id,
            "action": resolved_action,
            "query": str(query or ""),
            "mailbox": offered_mailbox or str(mailbox or "inbox"),
            "limit": limit if type(limit) is int else 10,
            "label": resolved_label,
            "require_access": require_access,
        }
        if offered_ids is not None:
            propose_kwargs["message_ids"] = offered_ids
            propose_kwargs["expect_account"] = offered_account
        proposal = await get_gmail_mailbox_actions().propose(**propose_kwargs)
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
    summary, confirm_label = _summary(resolved_action, resolved_label, preview)
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
            "action": resolved_action,
            "label": resolved_label or None,
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
    ordinals: list[int] | None = None,
) -> dict[str, Any]:
    """Prepare selected Gmail follow-ups for the owner's To-do list.

    Use only when the owner explicitly asks to add named email follow-ups to
    their list. Use ``ordinals`` (e.g. ``[2]``) when referring to emails shown
    earlier in this chat; otherwise pass ``query`` built from the owner's
    description (leave empty only for their newest mail). No Gmail message is
    changed, and an email's received time is never treated as a due date.
    """

    from hushh_mcp.one_adk.workspace_mcp_tools import _owner

    user_id = await _owner(tool_context, "gmail")
    if user_id is None:
        return {"status": "unavailable", "message": "Gmail follow-ups require an authorized chat."}

    offered_ids, offered_account, offered_mailbox, ordinal_error = _resolve_offered_message_ids(
        tool_context,
        user_id=user_id,
        ordinals=ordinals,
        max_items=10,
    )
    if ordinal_error is not None:
        return ordinal_error

    async def require_access() -> None:
        if await _owner(tool_context, "gmail") != user_id:
            raise PermissionError("Mail owner authority is unavailable")

    bounded_limit = limit if type(limit) is int and 1 <= limit <= 10 else 10
    normalized_mailbox = str(mailbox or "inbox")
    normalized_query = str(query or "")
    operation = "search_inbox" if normalized_query.strip() else "list_recent"
    arguments: dict[str, Any] = {"mailbox": normalized_mailbox, "limit": bounded_limit}
    if operation == "search_inbox":
        arguments["query"] = normalized_query
    try:
        if offered_ids is not None:
            reader = GmailMetadataReader(
                gmail=get_gmail_receipts_service(),
                user_id=user_id,
                require_access=require_access,
                expect_account=offered_account,
            )
            targets = await reader.resolve_targets_by_ids(
                offered_ids,
                mailbox=offered_mailbox or "anywhere",
            )
            preview = targets.preview
        else:
            reader = GmailMetadataReader(
                gmail=get_gmail_receipts_service(),
                user_id=user_id,
                require_access=require_access,
            )
            preview = await reader.read(operation, arguments)
        await require_access()
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
