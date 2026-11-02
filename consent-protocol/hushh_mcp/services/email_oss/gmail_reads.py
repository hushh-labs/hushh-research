# SPDX-License-Identifier: GPL-3.0-only
"""Native page/message/attachment reads composed by GmailExecution."""

from __future__ import annotations

import asyncio
import base64
import binascii

from .execution_types import (
    GmailExecutionError,
    _attachment_identifier,
    _identifier,
    _payload,
    _text,
)
from .mime_projection import _message_fields


class GmailReadOperations:
    async def search_threads(self, q, max_results=25, page_token=None, include_clean_body=False):
        """One native message-search page, carrying thread IDs; no automatic paging."""
        _text(q, 2048)
        if (
            isinstance(max_results, bool)
            or not isinstance(max_results, int)
            or not 1 <= max_results <= 50
        ):
            raise GmailExecutionError("invalid_argument")
        if not isinstance(include_clean_body, bool):
            raise GmailExecutionError("invalid_argument")
        if page_token is not None:
            _text(page_token, 4096)

        async def run():
            listing = _payload(await self._donor.search_emails(q, max_results, page_token))
            entries = listing.get("messages", [])
            if not isinstance(entries, list) or len(entries) > max_results:
                raise GmailExecutionError("invalid_provider_response")
            ids = []
            for item in entries:
                identity = _identifier(item.get("id") if isinstance(item, dict) else None)
                if identity not in ids:
                    ids.append(identity)
            responses, errors = {}, set()

            def received(request_id, response, exception):
                if exception is not None:
                    errors.add(request_id)
                else:
                    responses[request_id] = response

            # One googleapiclient HTTP batch, not N parallel httplib2 clients.
            if ids:
                batch = self._service.new_batch_http_request(callback=received)
                for identity in ids:
                    batch.add(
                        self._service.users()
                        .messages()
                        .get(
                            userId="me",
                            id=identity,
                            format="full",
                            fields=_message_fields(include_clean_body),
                        ),
                        request_id=identity,
                    )
                await self._access()
                await asyncio.to_thread(batch.execute)
                await self._access()
            messages = []
            for identity in ids:
                if identity not in responses:
                    errors.add(identity)
                    continue
                projected = self._project_message(
                    responses[identity], include_body=include_clean_body
                )
                if projected["id"] != identity:
                    raise GmailExecutionError("invalid_provider_response")
                messages.append(projected)
            cursor = listing.get("nextPageToken")
            if cursor is not None:
                _text(cursor, 4096)
            estimate = listing.get("resultSizeEstimate")
            if estimate is not None and (not isinstance(estimate, int) or estimate < 0):
                raise GmailExecutionError("invalid_provider_response")
            return {
                "messages": messages,
                "next_page_token": cursor,
                "result_size_estimate": estimate,
                "returned_count": len(messages),
                "failed_count": len(errors),
                "truncated": bool(cursor),
            }

        return await self._call(run)

    async def get_message(self, message_id):
        identity = _identifier(message_id)

        async def run():
            result = await asyncio.to_thread(
                self._service.users()
                .messages()
                .get(userId="me", id=identity, format="full", fields=_message_fields(True))
                .execute
            )
            message = self._project_message(result, include_body=True)
            if message["id"] != identity:
                raise GmailExecutionError("invalid_provider_response")
            return message

        return await self._call(run)

    async def get_thread(self, thread_id):
        identity = _identifier(thread_id)

        async def run():
            result = _payload(
                await asyncio.to_thread(
                    self._service.users()
                    .threads()
                    .get(
                        userId="me",
                        id=identity,
                        format="full",
                        fields="id,messages(" + _message_fields(True) + ")",
                    )
                    .execute
                )
            )
            if result.get("id") != identity or not isinstance(result.get("messages"), list):
                raise GmailExecutionError("invalid_provider_response")
            messages = [
                self._project_message(item, include_body=True) for item in result["messages"][:50]
            ]
            if any(item["thread_id"] != identity for item in messages):
                raise GmailExecutionError("invalid_provider_response")
            return {"id": identity, "messages": messages, "truncated": len(result["messages"]) > 50}

        return await self._call(run)

    async def get_attachment(self, message_id, attachment_id):
        message_id, attachment_id = _identifier(message_id), _attachment_identifier(attachment_id)

        async def run():
            result = await asyncio.to_thread(
                self._service.users()
                .messages()
                .attachments()
                .get(userId="me", messageId=message_id, id=attachment_id)
                .execute
            )
            if not isinstance(result, dict) or not isinstance(result.get("data"), str):
                raise GmailExecutionError("invalid_provider_response")
            data = result["data"]
            if len(data) > ((self._attachment_limit + 2) // 3) * 4:
                raise GmailExecutionError("response_too_large")
            try:
                content = base64.b64decode(
                    data + "=" * (-len(data) % 4), altchars=b"-_", validate=True
                )
            except (binascii.Error, ValueError):
                raise GmailExecutionError("invalid_provider_response") from None
            if len(content) > self._attachment_limit:
                raise GmailExecutionError("response_too_large")
            if result.get("size", len(content)) != len(content):
                raise GmailExecutionError("invalid_provider_response")
            return {
                "message_id": message_id,
                "attachment_id": attachment_id,
                "size": len(content),
                "content": content,
            }

        return await self._call(run)
