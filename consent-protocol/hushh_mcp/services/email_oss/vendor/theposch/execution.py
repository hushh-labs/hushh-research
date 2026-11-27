# SPDX-License-Identifier: GPL-3.0-only
"""Adapted from theposch/gmail-mcp, f4c8affe8c08b0fb3deb33570251ed0596e73d9d.

GPL-3.0 exception: NOT covered by the enclosing package's Apache-2.0 default.
Original source and license are preserved in original/. See ../PROVENANCE.md.
Only execution is retained: credentials, MCP, browser launch, logging and retries
are absent. The host injects the exact operation's owner-scoped SDK resource.
"""

from __future__ import annotations

import asyncio
import base64
from email.header import decode_header
from email.message import EmailMessage
from typing import Any


def decode_mime_header(header: str) -> str:
    """Upstream server.py:166-178; tolerate unknown or malformed charsets."""
    decoded_parts = decode_header(header)
    decoded_string = ""
    for part, encoding in decoded_parts:
        if isinstance(part, bytes):
            try:
                decoded_string += part.decode(encoding or "utf-8", errors="replace")
            except LookupError:
                decoded_string += part.decode("utf-8", errors="replace")
        else:
            decoded_string += part
    return decoded_string


def _message(recipient_id, subject, message, *, cc=None, bcc=None, html_body=None):
    """Shared MIME construction extracted from upstream send_email/create_draft."""
    message_obj = EmailMessage()
    message_obj.set_content(message)
    message_obj["To"] = recipient_id
    # Gmail supplies From for the authenticated `me`; no profile read is needed.
    message_obj["Subject"] = subject
    if cc:
        message_obj["Cc"] = ", ".join(cc)
    if bcc:
        message_obj["Bcc"] = ", ".join(bcc)
    if html_body:
        message_obj.add_alternative(html_body, subtype="html")
    encoded_message = base64.urlsafe_b64encode(message_obj.as_bytes()).decode()
    return {"raw": encoded_message}


class GmailService:
    """Resource injection replaces upstream file-based OAuth constructor."""

    def __init__(self, service: Any):
        self.service = service

    async def send_email(self, recipient_id, subject, message, **kwargs):
        """Upstream send_email:236-255; provider errors propagate to the host."""
        create_message = _message(recipient_id, subject, message, **kwargs)
        send_message = await asyncio.to_thread(
            self.service.users().messages().send(userId="me", body=create_message).execute
        )
        return {"status": "success", "message_id": send_message["id"]}

    async def create_draft(self, recipient_id, subject, message, **kwargs):
        """Upstream create_draft:389-408; no OAuth or app-review policy here."""
        create_message = _message(recipient_id, subject, message, **kwargs)
        draft = await asyncio.to_thread(
            self.service.users()
            .drafts()
            .create(userId="me", body={"message": create_message})
            .execute
        )
        return {"status": "success", "draft_id": draft["id"]}

    async def trash_email(self, email_id):
        """Upstream trash_email:371-378; execute off the event loop, no logging."""
        return await asyncio.to_thread(
            self.service.users().messages().trash(userId="me", id=email_id).execute
        )

    async def search_emails(self, query, max_results=25, page_token=None):
        """Upstream search_emails:661-731, reduced to exactly one native page.

        Metadata fanout moved to the host's bounded SDK batch. Pagination is
        returned, never followed automatically. No result selection occurs here.
        """
        params = {"userId": "me", "q": query, "maxResults": max_results}
        if page_token:
            params["pageToken"] = page_token
        return await asyncio.to_thread(self.service.users().messages().list(**params).execute)
