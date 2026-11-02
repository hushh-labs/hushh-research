# SPDX-License-Identifier: GPL-3.0-only
"""Explicit Gmail effects; the runtime retains OAuth and review authority."""

from __future__ import annotations

import asyncio

from .execution_types import (
    _HEADERS,
    _ID,
    GmailExecutionError,
    _addresses,
    _identifier,
    _payload,
    _text,
)
from .mime_projection import _headers
from .vendor.eaia.execution import send_message
from .vendor.theposch.execution import decode_mime_header


class GmailEffectOperations:
    @staticmethod
    def _envelope(to, subject, body, cc, bcc, html_body=None):
        recipients = _addresses(to, required=True)
        cc, bcc = _addresses(cc), _addresses(bcc)
        if len(recipients) + len(cc) + len(bcc) > 50:
            raise GmailExecutionError("invalid_argument")
        _text(subject, 512, required=False)
        if "\r" in subject or "\n" in subject:
            raise GmailExecutionError("invalid_argument")
        _text(body, 50000, required=False)
        if html_body is not None:
            _text(html_body, 50000, required=False)
        return recipients, cc, bcc

    async def create_draft(self, to, subject, body, *, cc=None, bcc=None, html_body=None):
        to, cc, bcc = self._envelope(to, subject, body, cc, bcc, html_body)

        async def run():
            result = await self._donor.create_draft(
                ", ".join(to), subject, body, cc=cc, bcc=bcc, html_body=html_body
            )
            if not _ID.fullmatch(str(result.get("draft_id") or "")):
                raise GmailExecutionError("outcome_unknown", outcome_unknown=True)
            return result

        return await self._call(run, mutation=True)

    async def send_email(self, to, subject, body, *, cc=None, bcc=None, html_body=None):
        to, cc, bcc = self._envelope(to, subject, body, cc, bcc, html_body)

        async def run():
            result = await self._donor.send_email(
                ", ".join(to), subject, body, cc=cc, bcc=bcc, html_body=html_body
            )
            if not _ID.fullmatch(str(result.get("message_id") or "")):
                raise GmailExecutionError("outcome_unknown", outcome_unknown=True)
            return result

        return await self._call(run, mutation=True)

    async def reply_to_thread(
        self, thread_id, to, body, *, message_id=None, subject=None, cc=None, bcc=None
    ):
        thread_id = _identifier(thread_id)
        if message_id is not None:
            _identifier(message_id)
        to, cc, bcc = self._envelope(to, subject or "", body, cc, bcc)

        async def run():
            result = _payload(
                await asyncio.to_thread(
                    self._service.users()
                    .threads()
                    .get(
                        userId="me", id=thread_id, format="metadata", metadataHeaders=list(_HEADERS)
                    )
                    .execute
                )
            )
            if result.get("id") != thread_id or not isinstance(result.get("messages"), list):
                raise GmailExecutionError("invalid_provider_response")
            messages = result["messages"]
            if not messages or len(messages) > 200:
                raise GmailExecutionError("invalid_provider_response")
            original = (
                next((m for m in messages if m.get("id") == message_id), None)
                if message_id
                else messages[-1]
            )
            if original is None or original.get("threadId") != thread_id:
                raise GmailExecutionError("source_changed")
            headers = _headers(original)
            original_id = headers.get("message-id", "")
            if not original_id or any(
                "\r" in s or "\n" in s for s in (original_id, headers.get("references", ""))
            ):
                raise GmailExecutionError("invalid_provider_response")
            references = " ".join(x for x in (headers.get("references", ""), original_id) if x)
            message = self._create_reply_message(
                None,
                to,
                subject if subject is not None else decode_mime_header(headers.get("subject", "")),
                body,
                thread_id,
                original_id,
                references=references,
                cc=cc,
                bcc=bcc,
            )
            await self._access()  # Reading a thread never supplies send authority.
            sent = await asyncio.to_thread(send_message, self._service, "me", message)
            if not isinstance(sent, dict) or not _ID.fullmatch(str(sent.get("id") or "")):
                raise GmailExecutionError("outcome_unknown", outcome_unknown=True)
            return {"status": "success", "message_id": sent["id"], "thread_id": thread_id}

        return await self._call(run, mutation=True)

    async def batch_modify_messages(
        self, message_ids, *, add_label_ids=None, remove_label_ids=None
    ):
        if not isinstance(message_ids, list) or not 1 <= len(message_ids) <= 50:
            raise GmailExecutionError("invalid_argument")
        ids = list(dict.fromkeys(_identifier(item) for item in message_ids))
        add, remove = add_label_ids or [], remove_label_ids or []
        if (
            not isinstance(add, list)
            or not isinstance(remove, list)
            or len(add) + len(remove) > 100
        ):
            raise GmailExecutionError("invalid_argument")
        add, remove = [_identifier(item) for item in add], [_identifier(item) for item in remove]
        if not (add or remove) or set(add) & set(remove):
            raise GmailExecutionError("invalid_argument")

        async def run():
            await asyncio.to_thread(
                self._service.users()
                .messages()
                .batchModify(
                    userId="me", body={"ids": ids, "addLabelIds": add, "removeLabelIds": remove}
                )
                .execute
            )
            return {"status": "success", "modified_count": len(ids)}

        return await self._call(run, mutation=True)

    async def trash_message(self, message_id):
        identity = _identifier(message_id)

        async def run():
            result = await self._donor.trash_email(identity)
            if not isinstance(result, dict) or result.get("id") != identity:
                raise GmailExecutionError("outcome_unknown", outcome_unknown=True)
            return {"status": "success", "message_id": identity}

        return await self._call(run, mutation=True)
