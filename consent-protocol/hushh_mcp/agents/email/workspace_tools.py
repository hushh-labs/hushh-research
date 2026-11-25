"""Direct Gmail REST tools for Labels CRUD, Drafts/Scheduled Sends & Settings.

All write operations obey two-layer safety:
1. CaMeL external-read barrier: blocked automatically after any untrusted mail
   read in the same model invocation so email text can never invoke mutations.
2. Explicit confirmation discipline: high-impact or destructive writes
   (delete label, delete draft, cancel scheduled send, create/delete filter,
   update vacation responder, update signature/send-as) return a structured
   preview with ``status="confirmation_required"`` unless ``confirmed=True``
   after the owner has explicitly confirmed.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from google.adk.tools.tool_context import ToolContext

from hushh_mcp.services.gmail_delivery_service import get_gmail_delivery_service
from hushh_mcp.services.gmail_labels_drafts_settings_service import (
    GMAIL_LABEL_COLORS,
    get_gmail_labels_drafts_settings_service,
)
from hushh_mcp.services.gmail_receipts_service import GmailApiError

logger = logging.getLogger(__name__)

_STATE_TIMEZONE = "hussh:timezone"
_STATE_DRAFT_OFFER = "hussh:mail_draft_offer"
_STATE_SCHEDULED_OFFER = "hussh:mail_scheduled_offer"
_STATE_PENDING_DIRECTIVE = "hussh:pending_directive:gmail_mailbox"


async def _owner_id(tool_context: ToolContext) -> str | None:
    from hushh_mcp.one_adk.workspace_mcp_tools import _owner

    return await _owner(tool_context, "gmail")


def _connect_directive(
    tool_context: ToolContext, *, purpose: str, message: str, label: str
) -> dict[str, Any]:
    tool_context.state[_STATE_PENDING_DIRECTIVE] = {
        "kind": "action",
        "delegateAgentId": "agent_email",
        "payload": {
            "type": "gmail.connect",
            "purpose": purpose,
            "summary": message,
            "confirmLabel": label,
        },
    }
    return {
        "status": "connection_required",
        "purpose": purpose,
        "message": message,
        "next_step": "The app is showing a Gmail permission control. Ask the person to approve it.",
    }


def _handle_gmail_error(tool_context: ToolContext, exc: GmailApiError) -> dict[str, Any]:
    if exc.code == "GMAIL_NOT_CONNECTED":
        return {"status": "connect_required", "message": "Connect Gmail in Connections first."}
    if exc.code == "GMAIL_MODIFY_PERMISSION_REQUIRED":
        return _connect_directive(
            tool_context,
            purpose="modify",
            message="Allow One to organize your Gmail (labels, archive, spam, trash) first.",
            label="Allow Gmail changes",
        )
    if exc.code == "GMAIL_COMPOSE_PERMISSION_REQUIRED":
        return _connect_directive(
            tool_context,
            purpose="compose",
            message="Allow One to create and manage Gmail drafts first.",
            label="Allow Gmail drafts",
        )
    if exc.code == "GMAIL_SETTINGS_PERMISSION_REQUIRED":
        return _connect_directive(
            tool_context,
            purpose="settings",
            message="Allow Gmail settings permission so One can view or update filters, signatures, and vacation responder.",
            label="Allow Gmail settings",
        )
    if exc.code == "GMAIL_REAUTH_REQUIRED":
        return {
            "status": "reconnect_required",
            "message": "Reconnect Gmail in Connections to continue.",
        }
    return {"status": "failed", "code": exc.code, "message": exc.message}


def _date_to_epoch_ms(date_str: str, tz_name: str, *, end_of_day: bool = False) -> int | None:
    raw = str(date_str or "").strip()
    if not raw:
        return None
    try:
        zone = ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError):
        zone = ZoneInfo("UTC")
    try:
        if "T" in raw:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=zone)
        else:
            dt = datetime.strptime(raw, "%Y-%m-%d").replace(
                hour=23 if end_of_day else 0,
                minute=59 if end_of_day else 0,
                second=59 if end_of_day else 0,
                tzinfo=zone,
            )
        return int(dt.timestamp() * 1000)
    except ValueError:
        return None


async def gmail_manage_labels(
    tool_context: ToolContext,
    action: str = "list",
    filter_type: str = "all",
    name: str = "",
    new_name: str = "",
    color: str = "",
    label_list_visibility: str = "",
    message_list_visibility: str = "",
    confirmed: bool = False,
) -> dict[str, Any]:
    """List, create, rename/color/hide/show, or delete Gmail labels.

    Args:
        action: One of ``"list"``, ``"create"``, ``"update"``, or ``"delete"``.
        filter_type: For ``list``: ``"all"``, ``"user"`` (custom), or ``"system"``.
        name: Label name (or ID). Supports nested labels like ``"Work/Clients"``
            and Unicode/Hindi names.
        new_name: New label name for ``action="update"`` (rename).
        color: Optional color name (``blue``, ``green``, ``red``, ``yellow``,
            ``orange``, ``purple``, ``pink``, ``teal``, ``gray``, ``navy``).
        label_list_visibility: ``"show"``, ``"show_if_unread"``, or ``"hide"``.
        message_list_visibility: ``"show"`` or ``"hide"``.
        confirmed: Set ``True`` ONLY after the person explicitly confirms
            deleting a label (or renaming when confirmation was requested).
    """
    user_id = await _owner_id(tool_context)
    if user_id is None:
        return {
            "status": "unavailable",
            "message": "Gmail label management requires an authorized chat.",
        }
    svc = get_gmail_labels_drafts_settings_service()
    act = str(action or "list").strip().lower()

    try:
        if act == "list":
            return await svc.list_labels(
                user_id=user_id,
                filter_type=str(filter_type or "all"),
                include_counts=True,
            )
        if act == "create":
            if not str(name or "").strip():
                return {
                    "status": "invalid_argument",
                    "message": "Provide a name for the new label.",
                }
            if (
                color
                and color.strip().lower().replace("-", "_").replace(" ", "_")
                not in GMAIL_LABEL_COLORS
            ):
                return {
                    "status": "invalid_argument",
                    "message": f"Unsupported color '{color}'. Supported colors: {', '.join(sorted(GMAIL_LABEL_COLORS))}.",
                }
            return await svc.create_label(
                user_id=user_id,
                name=name,
                color_name=color or None,
                label_list_visibility=label_list_visibility or None,
                message_list_visibility=message_list_visibility or None,
            )
        if act == "update":
            if not str(name or "").strip():
                return {"status": "invalid_argument", "message": "Specify which label to update."}
            if new_name and not confirmed:
                return {
                    "status": "confirmation_required",
                    "action": "rename_label",
                    "current_name": name.strip(),
                    "new_name": new_name.strip(),
                    "message": (
                        f"Ready to rename label '{name.strip()}' to '{new_name.strip()}'. "
                        "Ask the person to confirm, then call again with confirmed=True."
                    ),
                }
            return await svc.update_label(
                user_id=user_id,
                current_name_or_id=name,
                new_name=new_name or None,
                color_name=color or None,
                label_list_visibility=label_list_visibility or None,
                message_list_visibility=message_list_visibility or None,
            )
        if act == "delete":
            if not str(name or "").strip():
                return {"status": "invalid_argument", "message": "Specify which label to delete."}
            if not confirmed:
                return {
                    "status": "confirmation_required",
                    "action": "delete_label",
                    "label_name": name.strip(),
                    "message": (
                        f"Deleting label '{name.strip()}' will remove the label only — all emails "
                        "stay safe in All Mail. Ask the person to confirm, then call again with confirmed=True."
                    ),
                }
            return await svc.delete_label(user_id=user_id, name_or_id=name)
        return {
            "status": "invalid_argument",
            "message": "action must be one of list, create, update, or delete.",
        }
    except GmailApiError as exc:
        return _handle_gmail_error(tool_context, exc)
    except Exception:  # noqa: BLE001
        logger.exception("one_adk.gmail_manage_labels_failed")
        return {
            "status": "failed",
            "message": "Could not update Gmail labels right now. Try again.",
        }


async def gmail_manage_drafts(
    tool_context: ToolContext,
    action: str = "list",
    ordinal: int = 0,
    to: str = "",
    subject: str = "",
    body: str = "",
    cc: str = "",
    bcc: str = "",
    limit: int = 15,
    confirmed: bool = False,
) -> dict[str, Any]:
    """List, read, create, update, or delete Gmail drafts, and view/cancel scheduled sends.

    Args:
        action: One of ``"list"``, ``"get"``, ``"create"``, ``"update"``,
            ``"delete"``, ``"list_scheduled"``, or ``"cancel_scheduled"``.
        ordinal: 1-based position from the latest draft or scheduled-send list.
        to: Recipient email(s) for ``create`` / ``update``.
        subject: Email subject for ``create`` / ``update``.
        body: Email body for ``create`` / ``update``.
        cc: Optional Cc recipients.
        bcc: Optional Bcc recipients.
        limit: Max drafts/scheduled sends to list (1 to 25).
        confirmed: Set ``True`` ONLY after the person explicitly confirms
            ``delete`` or ``cancel_scheduled``.
    """
    user_id = await _owner_id(tool_context)
    if user_id is None:
        return {"status": "unavailable", "message": "Gmail drafts require an authorized chat."}
    tz_name = str(tool_context.state.get(_STATE_TIMEZONE) or "UTC").strip() or "UTC"
    svc = get_gmail_labels_drafts_settings_service()
    act = str(action or "list").strip().lower()

    try:
        if act == "list":
            res = await svc.list_drafts(user_id=user_id, limit=limit, timezone_name=tz_name)
            tool_context.state[_STATE_DRAFT_OFFER] = list(res.get("draft_ids") or [])
            return {k: v for k, v in res.items() if k != "draft_ids"}

        if act in {"get", "update", "delete"}:
            offered = tool_context.state.get(_STATE_DRAFT_OFFER)
            if not isinstance(offered, list) or not offered:
                return {
                    "status": "source_changed",
                    "message": "List the person's drafts first so I know which draft to open or modify.",
                }
            if type(ordinal) is not int or not 1 <= ordinal <= len(offered):
                return {
                    "status": "invalid_argument",
                    "message": f"Choose a draft position between 1 and {len(offered)}.",
                }
            draft_id = str(offered[ordinal - 1])
            if act == "get":
                return await svc.get_draft(user_id=user_id, draft_id=draft_id)
            if act == "delete":
                if not confirmed:
                    detail = await svc.get_draft(user_id=user_id, draft_id=draft_id)
                    return {
                        "status": "confirmation_required",
                        "action": "delete_draft",
                        "ordinal": ordinal,
                        "subject": detail.get("subject"),
                        "to": detail.get("to"),
                        "message": (
                            f"Ready to delete draft #{ordinal} ('{detail.get('subject')}' to {detail.get('to')}). "
                            "Ask the person to confirm, then call again with confirmed=True."
                        ),
                    }
                return await svc.delete_draft(user_id=user_id, draft_id=draft_id)
            # update
            existing = await svc.get_draft(user_id=user_id, draft_id=draft_id)
            return await svc.update_draft(
                user_id=user_id,
                draft_id=draft_id,
                to=to or existing.get("to", ""),
                subject=subject or existing.get("subject", ""),
                body=body if body != "" else existing.get("body", ""),
                cc=cc or existing.get("cc", ""),
                bcc=bcc or existing.get("bcc", ""),
            )

        if act == "create":
            return await svc.create_draft(
                user_id=user_id,
                to=to,
                subject=subject,
                body=body,
                cc=cc,
                bcc=bcc,
            )

        if act == "list_scheduled":
            delivery = get_gmail_delivery_service()
            rows = await delivery.list_scheduled_sends(
                user_id=user_id, limit=max(1, min(int(limit), 20))
            )
            action_ids = [str(r.get("actionId") or r.get("action_id") or "") for r in rows]
            tool_context.state[_STATE_SCHEDULED_OFFER] = action_ids
            items = [
                {
                    "ordinal": idx,
                    "to": r.get("to") or r.get("recipientEmail") or "",
                    "subject": r.get("subject") or "(no subject)",
                    "scheduled_for": r.get("scheduledFor") or r.get("scheduled_for") or "",
                    "status": r.get("status") or "scheduled",
                }
                for idx, r in enumerate(rows, 1)
            ]
            return {"status": "ok", "count": len(items), "scheduled_sends": items}

        if act == "cancel_scheduled":
            offered_sched = tool_context.state.get(_STATE_SCHEDULED_OFFER)
            if not isinstance(offered_sched, list) or not offered_sched:
                return {
                    "status": "source_changed",
                    "message": "List scheduled emails first so I know which one to cancel.",
                }
            if type(ordinal) is not int or not 1 <= ordinal <= len(offered_sched):
                return {
                    "status": "invalid_argument",
                    "message": f"Choose a scheduled email position between 1 and {len(offered_sched)}.",
                }
            if not confirmed:
                return {
                    "status": "confirmation_required",
                    "action": "cancel_scheduled_send",
                    "ordinal": ordinal,
                    "message": (
                        f"Ready to cancel scheduled email #{ordinal}. "
                        "Ask the person to confirm, then call again with confirmed=True."
                    ),
                }
            action_id = str(offered_sched[ordinal - 1])
            delivery = get_gmail_delivery_service()
            res = await delivery.cancel_scheduled_send(user_id=user_id, action_id=action_id)
            return {"status": "scheduled_cancelled", "result": res}

        return {
            "status": "invalid_argument",
            "message": "action must be list, get, create, update, delete, list_scheduled, or cancel_scheduled.",
        }
    except GmailApiError as exc:
        return _handle_gmail_error(tool_context, exc)
    except Exception:  # noqa: BLE001
        logger.exception("one_adk.gmail_manage_drafts_failed")
        return {
            "status": "failed",
            "message": "Could not access Gmail drafts right now. Try again.",
        }


async def gmail_manage_settings(
    tool_context: ToolContext,
    action: str = "list_filters",
    filter_id: str = "",
    criteria_from: str = "",
    criteria_to: str = "",
    criteria_subject: str = "",
    criteria_query: str = "",
    criteria_negated_query: str = "",
    criteria_has_attachment: bool = False,
    criteria_size_bytes: int = 0,
    criteria_size_comparison: str = "",
    action_add_labels: list[str] | None = None,
    action_remove_labels: list[str] | None = None,
    action_archive: bool = False,
    action_mark_read: bool = False,
    action_star: bool = False,
    action_mark_important: bool = False,
    action_never_spam: bool = False,
    action_trash: bool = False,
    action_forward: str = "",
    vacation_enabled: bool = False,
    vacation_subject: str = "",
    vacation_message: str = "",
    vacation_start_date: str = "",
    vacation_end_date: str = "",
    vacation_contacts_only: bool = False,
    send_as_email: str = "",
    signature: str | None = None,
    display_name: str | None = None,
    reply_to: str | None = None,
    make_default: bool = False,
    confirmed: bool = False,
) -> dict[str, Any]:
    """Inspect and manage Gmail Filters, Signatures, Send-As, Vacation & Forwarding.

    Actions:
    - Filters: ``"list_filters"``, ``"preview_filter"``, ``"create_filter"``, ``"delete_filter"``
    - Vacation / Out-of-Office: ``"get_vacation"``, ``"update_vacation"``
    - Signatures & Send-As aliases: ``"list_send_as"``, ``"update_signature"``, ``"update_send_as"``
    - Auto-Forwarding status (read-only): ``"get_forwarding"``

    All mutations require ``confirmed=True`` after showing the person a clear
    preview. If the user has not yet granted ``gmail.settings.basic``, this tool
    surfaces an in-chat one-click permission card cleanly.
    """
    user_id = await _owner_id(tool_context)
    if user_id is None:
        return {"status": "unavailable", "message": "Gmail settings require an authorized chat."}
    tz_name = str(tool_context.state.get(_STATE_TIMEZONE) or "UTC").strip() or "UTC"
    svc = get_gmail_labels_drafts_settings_service()
    act = str(action or "list_filters").strip().lower()

    def _build_filter_payload() -> tuple[dict[str, Any], dict[str, Any], str]:
        crit: dict[str, Any] = {}
        query_parts: list[str] = []
        if criteria_from.strip():
            crit["from"] = criteria_from.strip()
            query_parts.append(f"from:({criteria_from.strip()})")
        if criteria_to.strip():
            crit["to"] = criteria_to.strip()
            query_parts.append(f"to:({criteria_to.strip()})")
        if criteria_subject.strip():
            crit["subject"] = criteria_subject.strip()
            query_parts.append(f"subject:({criteria_subject.strip()})")
        if criteria_query.strip():
            crit["query"] = criteria_query.strip()
            query_parts.append(criteria_query.strip())
        if criteria_negated_query.strip():
            crit["negatedQuery"] = criteria_negated_query.strip()
            query_parts.append(f"-({criteria_negated_query.strip()})")
        if criteria_has_attachment:
            crit["hasAttachment"] = True
            query_parts.append("has:attachment")
        if type(criteria_size_bytes) is int and criteria_size_bytes > 0:
            crit["size"] = criteria_size_bytes
            comp = str(criteria_size_comparison or "larger").strip().lower()
            crit["sizeComparison"] = "smaller" if comp == "smaller" else "larger"
            query_parts.append(f"{crit['sizeComparison']}:{criteria_size_bytes}")

        add_labels = [str(x).strip() for x in (action_add_labels or []) if str(x).strip()]
        rem_labels = [str(x).strip() for x in (action_remove_labels or []) if str(x).strip()]
        if action_archive and "INBOX" not in rem_labels:
            rem_labels.append("INBOX")
        if action_mark_read and "UNREAD" not in rem_labels:
            rem_labels.append("UNREAD")
        if action_star and "STARRED" not in add_labels:
            add_labels.append("STARRED")
        if action_mark_important and "IMPORTANT" not in add_labels:
            add_labels.append("IMPORTANT")
        if action_never_spam and "SPAM" not in rem_labels:
            rem_labels.append("SPAM")
        if action_trash and "TRASH" not in add_labels:
            add_labels.append("TRASH")

        filt_action: dict[str, Any] = {}
        if add_labels:
            filt_action["addLabelIds"] = add_labels
        if rem_labels:
            filt_action["removeLabelIds"] = rem_labels
        if action_forward.strip():
            filt_action["forward"] = action_forward.strip()
        return crit, filt_action, " ".join(query_parts).strip()

    try:
        if act == "list_filters":
            return await svc.list_filters(user_id=user_id)

        if act == "preview_filter":
            crit, _, q_preview = _build_filter_payload()
            if not q_preview:
                return {
                    "status": "invalid_argument",
                    "message": "Specify filter criteria to test/preview.",
                }
            res = await svc.preview_filter_matches(user_id=user_id, query=q_preview)
            res["criteria"] = crit
            return res

        if act == "create_filter":
            crit, filt_action, q_preview = _build_filter_payload()
            if not crit or not filt_action:
                return {
                    "status": "invalid_argument",
                    "message": "A Gmail filter requires both criteria (from/subject/query/etc.) and at least one action (label/archive/star/read/etc.).",
                }
            if not confirmed:
                est = 0
                if q_preview:
                    try:
                        prev = await svc.preview_filter_matches(user_id=user_id, query=q_preview)
                        est = prev.get("estimated_matches", 0)
                    except Exception:  # noqa: BLE001
                        est = 0
                return {
                    "status": "confirmation_required",
                    "action": "create_filter",
                    "criteria": crit,
                    "filter_action": filt_action,
                    "estimated_existing_matches": est,
                    "message": (
                        f"Filter preview ready (matches ~{est} existing emails). "
                        "Ask the person to confirm, then call again with confirmed=True."
                    ),
                }
            return await svc.create_filter(user_id=user_id, criteria=crit, action=filt_action)

        if act == "delete_filter":
            if not filter_id.strip():
                return {
                    "status": "invalid_argument",
                    "message": "Specify the filter_id to delete (list filters first).",
                }
            if not confirmed:
                return {
                    "status": "confirmation_required",
                    "action": "delete_filter",
                    "filter_id": filter_id.strip(),
                    "message": (
                        f"Ready to delete Gmail filter {filter_id.strip()}. "
                        "Ask the person to confirm, then call again with confirmed=True."
                    ),
                }
            return await svc.delete_filter(user_id=user_id, filter_id=filter_id.strip())

        if act == "get_vacation":
            return await svc.get_vacation(user_id=user_id)

        if act == "update_vacation":
            start_ms = _date_to_epoch_ms(vacation_start_date, tz_name, end_of_day=False)
            end_ms = _date_to_epoch_ms(vacation_end_date, tz_name, end_of_day=True)
            if not confirmed:
                return {
                    "status": "confirmation_required",
                    "action": "update_vacation",
                    "preview": {
                        "enabled": bool(vacation_enabled),
                        "subject": vacation_subject,
                        "message": vacation_message,
                        "start_date": vacation_start_date or None,
                        "end_date": vacation_end_date or None,
                        "contacts_only": bool(vacation_contacts_only),
                    },
                    "message": (
                        "Vacation responder preview ready. Ask the person to confirm, "
                        "then call again with confirmed=True."
                    ),
                }
            return await svc.update_vacation(
                user_id=user_id,
                enabled=bool(vacation_enabled),
                subject=vacation_subject,
                message=vacation_message,
                restrict_to_contacts=bool(vacation_contacts_only),
                start_time_ms=start_ms,
                end_time_ms=end_ms,
            )

        if act == "list_send_as":
            return await svc.list_send_as(user_id=user_id)

        if act in {"update_signature", "update_send_as"}:
            if not confirmed:
                return {
                    "status": "confirmation_required",
                    "action": act,
                    "preview": {
                        "send_as_email": send_as_email or "(primary address)",
                        "signature": signature,
                        "display_name": display_name,
                        "reply_to": reply_to,
                        "make_default": bool(make_default),
                    },
                    "message": (
                        "Send-As / signature update preview ready. Ask the person to confirm, "
                        "then call again with confirmed=True."
                    ),
                }
            return await svc.update_send_as(
                user_id=user_id,
                send_as_email=send_as_email,
                signature=signature,
                display_name=display_name,
                reply_to=reply_to,
                make_default=True if make_default else None,
            )

        if act == "get_forwarding":
            return await svc.get_forwarding_settings(user_id=user_id)

        return {
            "status": "invalid_argument",
            "message": (
                "Unsupported action. Use list_filters, preview_filter, create_filter, "
                "delete_filter, get_vacation, update_vacation, list_send_as, "
                "update_signature, update_send_as, or get_forwarding."
            ),
        }
    except GmailApiError as exc:
        return _handle_gmail_error(tool_context, exc)
    except Exception:  # noqa: BLE001
        logger.exception("one_adk.gmail_manage_settings_failed")
        return {
            "status": "failed",
            "message": "Could not update Gmail settings right now. Try again.",
        }


GMAIL_WORKSPACE_TOOLS = [
    gmail_manage_labels,
    gmail_manage_drafts,
    gmail_manage_settings,
]
