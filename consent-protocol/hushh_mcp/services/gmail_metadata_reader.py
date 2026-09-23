"""Turn-local Mail reads over the existing Gmail credential owner.

No receipt cache, sync, body, attachment, persistence or sending path is exposed.
The legacy credential envelope is observed conservatively: even a concurrent
refresh causes a safe retry rather than releasing a possibly superseded grant.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Awaitable, Callable
from typing import Any, Literal

import httpx
from opentelemetry.instrumentation.utils import suppress_instrumentation

from hushh_mcp.services.gmail_nudges import derive_needs_reply_nudges
from hushh_mcp.services.gmail_receipts_service import GmailApiError, GmailReceiptsService

_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"
_ID = re.compile(r"[A-Za-z0-9_-]{1,200}\Z")
_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
_FIELDS = "id,threadId,internalDate,payload/headers"
_HEADERS = ["From", "Subject", "Date"]
_BUDGET = 256 * 1024
_DEADLINE = 20.0
_NUDGE_QUERY = "in:inbox category:primary newer_than:30d -in:spam -in:trash"
MailOperation = Literal["list_needs_reply", "search_inbox"]
RequireAccess = Callable[[], Awaitable[None]]


class GmailMetadataError(RuntimeError):
    """Authored, value-free error; never carries provider payloads or exceptions."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _label(value: Any, maximum: int) -> tuple[str, bool]:
    raw = value if isinstance(value, str) else ""
    # Strip control characters; do not interpret markup, URLs or instructions.
    cleaned = " ".join(raw.split())
    encoded = cleaned.encode("utf-8")
    return encoded[:maximum].decode("utf-8", errors="ignore"), len(encoded) > maximum


def _arguments(operation: str, arguments: dict[str, Any]) -> tuple[int, str]:
    allowed = {"limit", "query"} if operation == "search_inbox" else {"limit"}
    if operation not in {"list_needs_reply", "search_inbox"} or set(arguments) - allowed:
        raise GmailMetadataError("invalid_argument")
    limit = arguments.get("limit", 10)
    if type(limit) is not int or not 1 <= limit <= 25:
        raise GmailMetadataError("invalid_argument")
    query = arguments.get("query", "")
    if operation == "search_inbox" and (
        not isinstance(query, str)
        or not query.strip()
        or len(query.encode("utf-8")) > 512
        or any(ord(char) < 32 for char in query)
    ):
        raise GmailMetadataError("invalid_argument")
    return limit, query.strip()


def _validate_message(message: Any) -> None:
    if not isinstance(message, dict) or not isinstance(message.get("payload"), dict):
        raise GmailMetadataError("invalid_response")
    headers = message["payload"].get("headers")
    if not isinstance(headers, list) or len(headers) > 16:
        raise GmailMetadataError("invalid_response")
    if any(
        not isinstance(header, dict)
        or not isinstance(header.get("name"), str)
        or not isinstance(header.get("value"), str)
        for header in headers
    ):
        raise GmailMetadataError("invalid_response")
    timestamp = message.get("internalDate")
    if timestamp is not None and (
        not isinstance(timestamp, str)
        or not timestamp.isascii()
        or not timestamp.isdigit()
        or len(timestamp) > 15
        or int(timestamp) > 253402300799999
    ):
        raise GmailMetadataError("invalid_response")


class GmailMetadataReader:
    """One owner, one observed Gmail grant, one bounded read per instance."""

    def __init__(
        self,
        *,
        gmail: GmailReceiptsService,
        user_id: str,
        require_access: RequireAccess,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._gmail = gmail
        self._user_id = user_id
        self._require_access = require_access
        self._transport = transport
        self._observation: dict[str, Any] | None = None
        self._account: str | None = None
        self._used = False
        self._remaining = _BUDGET

    async def require_current(self) -> None:
        """Recheck after interpretation too; no stale content leaves the hop."""
        await self._require_access()
        row = await asyncio.to_thread(self._gmail._fetch_connection_row, user_id=self._user_id)
        if (
            self._observation is None
            or not row
            or row.get("status") != "connected"
            or row.get("revoked") is not False
            or self._gmail._refresh_observation(row) != self._observation
            or row.get("google_sub") != self._account
            or _SCOPE not in re.split(r"[\s,]+", str(row.get("scope_csv") or ""))
        ):
            raise GmailMetadataError("connection_changed")

    async def read(self, operation: MailOperation, arguments: dict[str, Any]) -> dict[str, Any]:
        limit, query = _arguments(operation, arguments)
        if self._used:
            raise GmailMetadataError("read_already_used")
        self._used = True
        try:
            async with asyncio.timeout(_DEADLINE):
                await self._require_access()
                row = await asyncio.to_thread(
                    self._gmail._fetch_connection_row, user_id=self._user_id
                )
                if not row or row.get("status") == "disconnected":
                    raise GmailMetadataError("connect_required")
                if row.get("status") != "connected" or row.get("revoked"):
                    raise GmailMetadataError("reconnect_required")
                access_token, row = await self._gmail._ensure_access_token(user_id=self._user_id)
                self._observation = self._gmail._refresh_observation(row)
                self._account = row.get("google_sub")
                if not self._account or not all(self._observation.values()):
                    raise GmailMetadataError("reconnect_required")
                await self.require_current()
                async with httpx.AsyncClient(
                    transport=self._transport, timeout=10, follow_redirects=False
                ) as client:
                    result = await self._read(client, access_token, operation, limit, query)
                await self.require_current()
                return result
        except GmailApiError as exc:
            code = "reconnect_required" if exc.status_code in {400, 401, 403, 404} else "retryable"
            if exc.status_code == 409:
                code = "connection_changed"
            raise GmailMetadataError(code) from None
        except (TimeoutError, httpx.HTTPError):
            raise GmailMetadataError("retryable") from None

    async def _get(
        self, client: httpx.AsyncClient, token: str, path: str, params: dict[str, Any]
    ) -> dict[str, Any]:
        # HTTPX URL spans otherwise retain inbox queries and provider IDs.
        with suppress_instrumentation():
            return await self._get_private(client, token, path, params)

    async def _get_private(
        self, client: httpx.AsyncClient, token: str, path: str, params: dict[str, Any]
    ) -> dict[str, Any]:
        await self.require_current()
        async with client.stream(
            "GET",
            _BASE + path,
            params=params,
            headers={"Authorization": f"Bearer {token}", "Accept-Encoding": "identity"},
        ) as response:
            if response.status_code == 401:
                # CAS against the exact grant. A stale rejection never disables
                # an account connected while this request was in flight.
                await asyncio.to_thread(
                    self._gmail._mark_connection_needs_reauth,
                    user_id=self._user_id,
                    message="Reconnect Mail to continue.",
                    observed=self._observation,
                )
                raise GmailMetadataError("reconnect_required")
            if response.status_code == 403:
                raise GmailMetadataError("permission_denied")
            if response.status_code == 404:
                raise GmailMetadataError("source_changed")
            if response.status_code != 200:
                raise GmailMetadataError("retryable")
            if response.headers.get("content-encoding", "identity").lower() != "identity":
                raise GmailMetadataError("invalid_response")
            content = bytearray()
            async for chunk in response.aiter_raw():
                self._remaining -= len(chunk)
                if self._remaining < 0:
                    raise GmailMetadataError("response_too_large")
                content.extend(chunk)
        try:
            payload = json.loads(content)
        except (ValueError, UnicodeError):
            raise GmailMetadataError("invalid_response") from None
        if not isinstance(payload, dict):
            raise GmailMetadataError("invalid_response")
        return payload

    async def _read(
        self,
        client: httpx.AsyncClient,
        token: str,
        operation: MailOperation,
        limit: int,
        query: str,
    ) -> dict[str, Any]:
        listing = await self._get(
            client,
            token,
            "/messages",
            {
                "q": query if operation == "search_inbox" else _NUDGE_QUERY,
                "labelIds": "INBOX",
                "maxResults": 25 if operation == "list_needs_reply" else limit,
                "includeSpamTrash": "false",
                "fields": "messages(id,threadId),nextPageToken",
            },
        )
        entries = listing.get("messages", [])
        maximum = 25 if operation == "list_needs_reply" else limit
        if not isinstance(entries, list) or len(entries) > maximum:
            raise GmailMetadataError("invalid_response")
        id_key = "threadId" if operation == "list_needs_reply" else "id"
        ids = []
        for entry in entries:
            identity = entry.get(id_key) if isinstance(entry, dict) else None
            if not isinstance(identity, str) or not _ID.fullmatch(identity):
                raise GmailMetadataError("invalid_response")
            if identity not in ids:
                ids.append(identity)

        is_threads = operation == "list_needs_reply"
        payloads = []
        # One page, sequential bounded reads. No best-effort exception swallowing:
        # an unavailable inbox is not an empty inbox.
        for identity in ids:
            payload = await self._get(
                client,
                token,
                f"/{'threads' if is_threads else 'messages'}/{identity}",
                {
                    "format": "metadata",
                    "metadataHeaders": _HEADERS,
                    "fields": f"id,messages({_FIELDS})" if is_threads else _FIELDS,
                },
            )
            if payload.get("id") != identity:
                raise GmailMetadataError("invalid_response")
            if is_threads:
                messages = payload.get("messages")
                if not isinstance(messages, list) or not messages or len(messages) > 100:
                    raise GmailMetadataError("invalid_response")
                for message in messages:
                    _validate_message(message)
            else:
                _validate_message(payload)
            payloads.append(payload)
        truncated = bool(listing.get("nextPageToken"))
        if is_threads:
            row = await asyncio.to_thread(self._gmail._fetch_connection_row, user_id=self._user_id)
            account_email = str((row or {}).get("google_email") or "")
            if not account_email:
                raise GmailMetadataError("reconnect_required")
            threads = []
            for payload in payloads:
                thread = self._gmail._nudge_thread_from_payload(payload)
                if thread is None:
                    raise GmailMetadataError("invalid_response")
                threads.append(thread)
            nudges = derive_needs_reply_nudges(threads, user_email=account_email, limit=25)
            truncated = truncated or len(nudges) > limit
            raw_items = [
                {
                    "subject": n.title,
                    "sender": n.sender,
                    "received_at": n.received_at.isoformat() if n.received_at else None,
                }
                for n in nudges[:limit]
            ]
        else:
            raw_items = []
            for payload in payloads:
                headers = self._gmail._extract_headers(payload)
                sender, email = self._gmail._parse_from_header(headers.get("from", ""))
                received = self._gmail._message_received_at(payload, headers)
                raw_items.append(
                    {
                        "subject": headers.get("subject") or "(no subject)",
                        "sender": sender or email or "Unknown sender",
                        "received_at": received.isoformat() if received else None,
                    }
                )
        items = []
        for ordinal, item in enumerate(raw_items, 1):
            subject, cut_subject = _label(item["subject"], 320)
            sender, cut_sender = _label(item["sender"], 160)
            truncated = truncated or cut_subject or cut_sender
            items.append(
                {
                    "source_ref": f"mail:{ordinal}",
                    "subject": subject,
                    "sender": sender,
                    "received_at": item["received_at"],
                }
            )
        result = {
            "status": "ok",
            "operation": operation,
            "untrusted_external_content": items,
            "truncated": truncated,
            "metadata_only": True,
            "one_page_only": True,
        }
        # Leave space inside the 32-KB specialist envelope for status and the
        # interpreted answer. Count escaped JSON too, not only Python chars.
        while len(json.dumps(result).encode("utf-8")) > 24000 and items:
            items.pop()
            result["truncated"] = True
        return result
