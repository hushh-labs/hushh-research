"""Existing editable Mail and mailbox-review owners; never effect execution."""

from __future__ import annotations

import re
from typing import Any


def _mailbox_change(tool_name, arguments):
    added, removed = arguments.get("add_label_ids") or [], arguments.get("remove_label_ids") or []
    if tool_name == "trash_message":
        return "trash", ""
    if added == ["UNREAD"] and not removed:
        return "mark_unread", ""
    if removed == ["UNREAD"] and not added:
        return "mark_read", ""
    if removed == ["INBOX"] and not added:
        return "archive", ""
    if len(added) == 1 and not removed:
        return "add_label", added[0]
    if len(removed) == 1 and not added:
        return "remove_label", removed[0]
    return None


def _mailbox_confirmation(execution, proposal, ids, action, label):
    return {
        "status": "confirmation_required",
        "approved": False,
        "message": "Review these exact messages. Nothing has changed yet.",
        "directive": {
            "type": "gmail.execute_mailbox_proposal",
            "proposalId": proposal["proposal_id"],
            "action": action,
            "label": label or None,
            "summary": f"{action.replace('_', ' ').capitalize()} {len(ids)} selected emails?",
            "confirmLabel": "Confirm",
            "expiresAt": proposal["expires_at"],
            "truncated": False,
            "messages": [
                {
                    "subject": execution.observed_messages[identity].get("subject"),
                    "sender": execution.observed_messages[identity].get("from"),
                    "receivedAt": execution.observed_messages[identity].get("date"),
                }
                for identity in ids
            ],
        },
    }


class ExistingReviewPort:
    """Keep invocation distinct from approval and the existing effect ledger."""

    def __init__(self, execution: Any, pending_email_draft: str = "") -> None:
        self.execution = execution
        refs = re.findall(
            r"^Source mail reference: (rs1\.[A-Za-z0-9_-]{16,2044})$",
            pending_email_draft,
            re.MULTILINE,
        )
        self.pending_ref = refs[0] if len(refs) == 1 else None

    async def _reply_source(self, context, arguments):
        from hushh_mcp.services.gmail_reply_source_service import (
            open_reply_source_ref,
            read_reply_source,
            verified_reply_source,
        )

        selected = self.execution.observed_messages.get(str(arguments.get("message_id") or ""))
        if self.pending_ref:
            ref = open_reply_source_ref(self.pending_ref, owner_user_id=context.user_id)
            source = await verified_reply_source(
                gmail=self.execution.gmail,
                user_id=context.user_id,
                ref=ref,
                require_access=context.require_access,
            )
            if arguments.get("thread_id") and arguments["thread_id"] != source.thread_id:
                return {
                    "status": "input_required",
                    "approved": False,
                    "message": "A reply revision must keep the original thread.",
                }
            return source
        if (
            selected is None
            or selected.get("thread_id") != arguments.get("thread_id")
            or self.execution.grant_binding is None
        ):
            return {
                "status": "input_required",
                "approved": False,
                "message": "Read and select the exact message before preparing its reply.",
            }
        return await read_reply_source(
            gmail=self.execution.gmail,
            user_id=context.user_id,
            message_id=selected["id"],
            expected_account=self.execution.grant_binding[2],
            require_access=context.require_access,
        )

    async def _review_send(self, context, tool_name, arguments):
        from hushh_mcp.services.gmail_delivery_service import normalize_draft

        payload, source_ref = dict(arguments), None
        if tool_name == "reply_to_thread":
            from hushh_mcp.services.gmail_reply_source_service import seal_reply_source_ref

            source = await self._reply_source(context, arguments)
            if isinstance(source, dict):
                return source
            payload.update(to=[source.recipient_email], subject=source.subject, cc=[], bcc=[])
            source_ref = seal_reply_source_ref(source, owner_user_id=context.user_id)
        draft = normalize_draft(payload)
        ready = {
            "to": ", ".join(draft.to),
            "cc": ", ".join(draft.cc),
            "bcc": ", ".join(draft.bcc),
            "subject": draft.subject,
            "body": draft.body,
        }
        if source_ref:
            ready["sourceMailRef"] = source_ref
        await context.require_access()
        return {
            "status": "confirmation_required",
            "approved": False,
            "message": "Review the editable draft and press Send to send it.",
            "directive": {"type": "gmail.review_requested", "operation": tool_name, "draft": ready},
        }

    async def _review_mailbox(self, context, tool_name, arguments):
        from hushh_mcp.services.gmail_mailbox_actions import get_gmail_mailbox_actions

        ids = (
            [arguments.get("message_id")]
            if tool_name == "trash_message"
            else arguments.get("message_ids", [])
        )
        if (
            not ids
            or len(ids) > 25
            or any(identity not in self.execution.observed_messages for identity in ids)
        ):
            return {
                "status": "input_required",
                "approved": False,
                "message": "Search and select at most 25 exact messages before reviewing a mailbox change.",
            }
        change = _mailbox_change(tool_name, arguments)
        if change is None:
            return {
                "status": "input_required",
                "approved": False,
                "message": "Review one mailbox change at a time.",
            }
        action, label = change
        proposal = await get_gmail_mailbox_actions().propose_selected(
            user_id=context.user_id,
            action=action,
            message_ids=ids,
            label_id=label,
            expected_account=self.execution.grant_binding[2]
            if self.execution.grant_binding
            else "",
            require_access=context.require_access,
        )
        return _mailbox_confirmation(self.execution, proposal, ids, action, label)

    async def review(self, context: Any, tool_name: str, arguments: dict[str, Any]) -> dict:
        await context.require_access()
        if tool_name in {"send_email", "reply_to_thread"}:
            return await self._review_send(context, tool_name, arguments)
        if tool_name in {"batch_modify_messages", "trash_message"}:
            return await self._review_mailbox(context, tool_name, arguments)
        return {
            "status": "confirmation_required",
            "approved": False,
            "tool_name": tool_name,
            "message": "Review this Gmail change before it can execute.",
            "directive": {
                "type": "gmail.review_requested",
                "operation": tool_name,
                "arguments": arguments,
            },
        }
