"""Bounded read-only Overview evidence on the caller's selected Gmail connection."""

from __future__ import annotations

from typing import Any

from hushh_mcp.services.gmail_message_text import MessageTextError, cap_utf8, message_text
from hushh_mcp.services.gmail_metadata_reader import (
    _FULL_FIELDS,
    _ID,
    GmailMetadataError,
    GmailMetadataReader,
    _extract_attachment_details,
    _label,
    _recipient_label,
    _validate_message,
    in_listing_order,
)
from hushh_mcp.services.gmail_sensitive_content import redact_sensitive_mail_items

BRIEF_WINDOW_DAYS = 21
BRIEF_LIST_LIMIT = 30
BRIEF_MAX_MESSAGES = 24
BRIEF_TEXT_BYTES = 1400
_BRIEF_QUERY = (
    "newer_than:{days}d -category:promotions -category:social -category:forums -in:drafts"
)
_ATTACHMENT_NAME_BYTES = 120
_NO_SUBJECT = "(no subject)"
_NO_SENDER = "Unknown sender"


class OverviewMailReader(GmailMetadataReader):
    """Use the base reader's owner and connection fences for the daily brief."""

    async def brief_window(self, *, days: int, limit: int) -> list[dict[str, Any]]:
        """Recent received and sent mail with bounded readable text, newest first.

        Read-only. Drafts, Spam, Trash and bulk categories are left out. Message
        text comes through the same hidden-instruction stripping One's chat
        reads use, and stays untrusted data for every caller.
        """
        if (
            not isinstance(limit, int)
            or isinstance(limit, bool)
            or not 1 <= limit <= BRIEF_LIST_LIMIT
        ):
            raise GmailMetadataError("invalid_argument")
        if not isinstance(days, int) or isinstance(days, bool) or not 1 <= days <= 60:
            raise GmailMetadataError("invalid_argument")

        async def body(client: Any, token: str) -> list[dict[str, Any]]:
            params: dict[str, Any] = {
                "maxResults": limit,
                "includeSpamTrash": "false",
                "q": _BRIEF_QUERY.format(days=days),
                "fields": "messages(id,threadId),nextPageToken",
            }
            listing = await self._get(client, token, "/messages", params)
            entries = listing.get("messages", [])
            if not isinstance(entries, list) or len(entries) > limit:
                raise GmailMetadataError("invalid_response")
            ids: list[str] = []
            for entry in entries:
                identity = entry.get("id") if isinstance(entry, dict) else None
                if not isinstance(identity, str) or not _ID.fullmatch(identity):
                    raise GmailMetadataError("invalid_response")
                if identity not in ids:
                    ids.append(identity)
            request = {"format": "full", "fields": _FULL_FIELDS}

            async def fetch(identity: str) -> dict[str, Any]:
                payload: dict[str, Any] = await self._get(
                    client, token, f"/messages/{identity}", request, recheck=False
                )
                if payload.get("id") != identity:
                    raise GmailMetadataError("invalid_response")
                _validate_message(payload, max_headers=400)
                return payload

            await self.require_current()
            payloads = await in_listing_order(ids, fetch)
            await self.require_current()
            rows = [self._brief_row(payload) for payload in payloads]
            return [row for row in rows if row is not None]

        result: list[dict[str, Any]] = await self._session(body, reads_bodies=True)
        return result

    def _brief_row(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        labels = payload.get("labelIds") or []
        if "DRAFT" in labels:
            return None
        headers = self._gmail._extract_headers(payload)
        name, address = self._gmail._parse_from_header(headers.get("from", ""))
        received = self._gmail._message_received_at(payload, headers)
        if received is None:
            return None
        try:
            text = message_text(payload["payload"])
        except MessageTextError:
            raise GmailMetadataError("invalid_response") from None
        text, text_cut = cap_utf8(text, BRIEF_TEXT_BYTES)
        subject, _ = _label(headers.get("subject"), 320)
        sanitized, _, _ = redact_sensitive_mail_items(
            [{"subject": subject, "body": text}], owner_user_id="", conversation_id=""
        )
        subject = sanitized[0]["subject"]
        text = sanitized[0]["body"]
        details = _extract_attachment_details(payload.get("payload"))
        return {
            "message_id": str(payload["id"]),
            "thread_id": str(payload.get("threadId") or ""),
            "direction": "sent" if "SENT" in labels else "received",
            "from_name": _label(name, 160)[0] or None,
            "from_address": (address or "").strip().lower() or None,
            "to": _recipient_label(headers.get("to", "")) or None,
            "subject": subject if subject and subject.casefold() != _NO_SUBJECT else None,
            "received_at": received.isoformat(),
            "unread": "UNREAD" in labels,
            "text": text,
            "text_cut": text_cut,
            "attachments": [
                _label(item["filename"], _ATTACHMENT_NAME_BYTES)[0] for item in details[:5]
            ],
        }
