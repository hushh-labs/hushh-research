"""Bounded checks and the result for One's typed-chat Gmail draft tool.

``agent_tree.open_gmail_email_draft`` keeps the model-facing signature and
docstring. This module holds its field limits, resolves recipients under the
app's draft contract and assembles the draft-opened result, so the tool body
stays a short sequence of authority checks.
"""

from __future__ import annotations

import logging
from typing import Any

from hushh_mcp.one_adk.email_draft_recipients import (
    MAX_RECIPIENT_FIELD_LENGTH,
    gmail_send_readiness,
    resolve_draft_recipients,
)
from hushh_mcp.one_adk.mail_instruction import draft_opened_message, needs_draft_addresses

logger = logging.getLogger(__name__)

_FIELD_LIMITS = {
    "to": MAX_RECIPIENT_FIELD_LENGTH,
    "cc": MAX_RECIPIENT_FIELD_LENGTH,
    "bcc": MAX_RECIPIENT_FIELD_LENGTH,
    "subject": 512,
    "body": 12_000,
    "recipient_names": 512,
    "cc_names": 512,
}
_DRIVE_FILE_ID_LIMIT = 256
_RECIPIENT_FIELDS = ("to", "cc", "bcc", "recipient_names", "cc_names")
_ADDRESS_REQUIRED = {
    "status": "recipient_address_required",
    "message": (
        "This app can't take names. Look the email up with list_my_connections and call "
        "again with it in to (cc for cc); ask one question only if the name matches "
        "several connections or has no email."
    ),
}


def draft_field_refusal(fields: dict[str, Any], drive_file_id: Any) -> dict[str, Any] | None:
    """Refuse an oversized or non-text field before any read or directive."""
    for name, value in fields.items():
        if not isinstance(value, str) or len(value.strip()) > _FIELD_LIMITS[name]:
            return {
                "status": "invalid_draft",
                "message": "Keep the editable mail draft within the supported size and try again.",
            }
    if len(str(drive_file_id or "").strip()) > _DRIVE_FILE_ID_LIMIT:
        return {
            "status": "invalid_file_selection",
            "message": "Choose one Drive file to attach and try again.",
        }
    return None


async def draft_envelope(user_id: str, fields: dict[str, str], state: Any) -> dict[str, Any]:
    """The resolved envelope, or a refusal whose message names One's next step.

    An app before draft contract 2 shows the call's own To, Cc and Bcc, never the
    envelope, so for it any name is refused: one in the name fields before a
    lookup, one in to, cc or bcc once it resolves. One then looks the address up.
    """
    legacy = needs_draft_addresses(state.get)
    if legacy and (fields["recipient_names"].strip() or fields["cc_names"].strip()):
        logger.info("one.email_draft.recipients outcome=legacy_names")
        return dict(_ADDRESS_REQUIRED)
    envelope = await resolve_draft_recipients(user_id, **{k: fields[k] for k in _RECIPIENT_FIELDS})
    if legacy and envelope.get("status") == "ok" and envelope.get("recipients"):
        logger.info("one.email_draft.recipients outcome=legacy_names")
        return dict(_ADDRESS_REQUIRED)
    return envelope


async def draft_opened_result(
    user_id: str, envelope: dict[str, Any], *, prefilled: bool
) -> dict[str, Any]:
    """The draft-opened result: resolved envelope, matched names and send readiness.

    One reads this result for the current turn, and the live card takes its
    recipients and send readiness from it. Durable history keeps neither this
    call's draft fields nor its result: ``external_read_projection`` empties
    the call's arguments and replaces its result with a redaction marker before
    a session is stored. The request text and any Drive file ID remain in the
    pending directive (``hussh:pending_directive:gmail_email_draft``), which is
    stored with the session.
    """
    gmail_send = await gmail_send_readiness(user_id)
    return {
        "status": "draft_opened",
        "prefilled": prefilled,
        "envelope": {key: envelope[key] for key in ("to", "cc", "bcc")},
        "recipients": envelope["recipients"],
        "gmail_send": gmail_send,
        "message": draft_opened_message(gmail_send),
    }


__all__ = ["draft_envelope", "draft_field_refusal", "draft_opened_result"]
