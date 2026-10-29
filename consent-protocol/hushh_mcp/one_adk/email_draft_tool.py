"""Bounded checks and the result for One's typed-chat Gmail draft tool.

``agent_tree.open_gmail_email_draft`` keeps the model-facing signature and
docstring. This module holds its field limits and assembles the draft-opened
result, so the tool body stays a short sequence of authority checks.
"""

from __future__ import annotations

from typing import Any

from hushh_mcp.one_adk.email_draft_recipients import gmail_send_readiness
from hushh_mcp.one_adk.mail_instruction import draft_opened_message

_FIELD_LIMITS = {
    "to": 2048,
    "cc": 2048,
    "bcc": 2048,
    "subject": 512,
    "body": 12_000,
    "recipient_names": 512,
    "cc_names": 512,
}
_DRIVE_FILE_ID_LIMIT = 256


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


async def draft_opened_result(
    user_id: str, envelope: dict[str, Any], *, prefilled: bool
) -> dict[str, Any]:
    """The live card's envelope plus Gmail send readiness.

    Durable history redacts this tool's result
    (``external_read_projection._PRIVATE_DRAFT_TOOLS``), so resolved addresses
    reach only the live card.
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


__all__ = ["draft_field_refusal", "draft_opened_result"]
