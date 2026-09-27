"""Turn-local Mail reads over the existing Gmail credential owner.

Metadata operations return senders, subjects and dates. The two body
operations (``read_message``, ``read_thread``) return size-capped readable text
under the same ``gmail.readonly`` grant when the person asked to read mail.
No receipt cache, sync, attachment, persistence, mutation or sending path is
exposed. The legacy credential envelope is observed conservatively: even a
concurrent refresh causes a safe retry rather than releasing a possibly
superseded grant.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from email.utils import getaddresses
from typing import Any, Literal

import httpx
from opentelemetry.instrumentation.utils import suppress_instrumentation

from hushh_mcp.services.gmail_message_text import MessageTextError, cap_utf8, message_text
from hushh_mcp.services.gmail_nudges import derive_needs_reply_nudges
from hushh_mcp.services.gmail_receipts_service import GmailApiError, GmailReceiptsService

_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"
_ID = re.compile(r"[A-Za-z0-9_-]{1,200}\Z")
_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
_FIELDS = "id,threadId,internalDate,labelIds,payload/headers"
_HEADERS = ["From", "Subject", "Date"]
# Mailbox scope for a read. Spam and trash stay excluded everywhere.
_MAILBOX_LABELS: dict[str, str | None] = {"inbox": "INBOX", "sent": "SENT", "anywhere": None}
_BUDGET = 256 * 1024
# Full messages carry every header and both MIME alternatives. The budget still
# bounds memory; an oversized mailbox result fails truthfully, never partially.
_BODY_BUDGET = 4 * 1024 * 1024
_DEADLINE = 20.0
_NUDGE_QUERY = "in:inbox category:primary newer_than:30d -in:spam -in:trash"
# Per-message reads for one listing page run concurrently, bounded so a page
# never opens more than this many provider requests at once.
_FETCH_CONCURRENCY = 8
_BODY_OPERATIONS = frozenset({"read_message", "read_thread"})
MAX_BODY_MESSAGES = 5
# A thread answer reads its newest messages; older ones are reported as omitted.
_MAX_THREAD_MESSAGES = 10
# Readable text shared by every message in one answer, inside the 24-KB result.
_BODY_TEXT_BUDGET = 16000
_FULL_FIELDS = "id,threadId,internalDate,labelIds,payload"
MailOperation = Literal[
    "list_needs_reply", "list_recent", "search_inbox", "read_message", "read_thread"
]
_OPERATIONS: dict[str, frozenset[str]] = {
    "list_needs_reply": frozenset({"limit", "mailbox"}),
    "list_recent": frozenset({"limit", "mailbox"}),
    "search_inbox": frozenset({"limit", "query", "mailbox"}),
    "read_message": frozenset({"limit", "query", "mailbox"}),
    "read_thread": frozenset({"query", "mailbox"}),
}
Mailbox = Literal["inbox", "sent", "anywhere"]
RequireAccess = Callable[[], Awaitable[None]]


# System labels a person may add or remove by name. INBOX and UNREAD have their
# own actions (archive, read state); SPAM, TRASH and DRAFT are never labels here.
_SETTABLE_SYSTEM_LABELS = frozenset({"STARRED", "IMPORTANT"})


@dataclass(frozen=True)
class MailboxTargets:
    """Exact messages a reviewed mailbox change would touch, resolved server-side."""

    message_ids: tuple[str, ...] = field(repr=False)
    preview: dict[str, Any]
    label_id: str | None = field(repr=False)
    account: str = field(repr=False)


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


def _arguments(operation: str, arguments: dict[str, Any]) -> tuple[int, str, str]:
    allowed = _OPERATIONS.get(operation)
    if allowed is None or set(arguments) - allowed:
        raise GmailMetadataError("invalid_argument")
    reads_bodies = operation in _BODY_OPERATIONS
    limit = arguments.get("limit", 1 if reads_bodies else 10)
    maximum = MAX_BODY_MESSAGES if reads_bodies else 25
    if type(limit) is not int or not 1 <= limit <= maximum:
        raise GmailMetadataError("invalid_argument")
    query = arguments.get("query", "")
    # A search needs criteria; a body read without criteria reads the newest.
    if "query" in allowed and (
        not isinstance(query, str)
        or (operation == "search_inbox" and not query.strip())
        or len(query.encode("utf-8")) > 512
        or any(ord(char) < 32 for char in query)
    ):
        raise GmailMetadataError("invalid_argument")
    mailbox = arguments.get("mailbox", "inbox")
    # Needs-reply is defined over inbound inbox threads; it has no other scope.
    if mailbox not in _MAILBOX_LABELS or (operation == "list_needs_reply" and mailbox != "inbox"):
        raise GmailMetadataError("invalid_argument")
    return limit, query.strip(), mailbox


def _recipient_label(value: str) -> str:
    """First recipient's display name or address, plus how many others."""
    recipients = [name or address for name, address in getaddresses([value]) if name or address]
    if not recipients:
        return "Unknown recipient"
    extra = len(recipients) - 1
    return recipients[0] + (f" (+{extra} more)" if extra else "")


def _validate_message(message: Any, *, max_headers: int = 16) -> None:
    if not isinstance(message, dict) or not isinstance(message.get("payload"), dict):
        raise GmailMetadataError("invalid_response")
    headers = message["payload"].get("headers")
    # Full messages carry every transport header, not only the requested four.
    if not isinstance(headers, list) or len(headers) > max_headers:
        raise GmailMetadataError("invalid_response")
    if any(
        not isinstance(header, dict)
        or not isinstance(header.get("name"), str)
        or not isinstance(header.get("value"), str)
        for header in headers
    ):
        raise GmailMetadataError("invalid_response")
    labels = message.get("labelIds", [])
    if (
        not isinstance(labels, list)
        or len(labels) > 100
        or any(not isinstance(label, str) for label in labels)
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


async def in_listing_order(
    items: list[str], fetch: Callable[[str], Awaitable[dict[str, Any]]]
) -> list[dict[str, Any]]:
    """Run bounded concurrent reads and return results in the listing's order.

    The first failure cancels the rest: an unavailable message is never read
    as an absent one, and no orphaned request outlives the read.
    """
    semaphore = asyncio.Semaphore(_FETCH_CONCURRENCY)

    async def one(item: str) -> dict[str, Any]:
        async with semaphore:
            return await fetch(item)

    tasks = [asyncio.create_task(one(item)) for item in items]
    try:
        return list(await asyncio.gather(*tasks))
    except BaseException:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise


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
        self._message_ids: list[str] = []

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
        limit, query, mailbox = _arguments(operation, arguments)

        async def body(client: httpx.AsyncClient, token: str) -> dict[str, Any]:
            return await self._read(client, token, operation, limit, query, mailbox)

        return await self._session(body, reads_bodies=operation in _BODY_OPERATIONS)

    async def resolve_targets(
        self, arguments: dict[str, Any], *, label_name: str | None = None
    ) -> MailboxTargets:
        """Resolve one page of messages for a reviewed mailbox change.

        The same fenced session as a read. Provider message and label IDs stay
        on the server side of the result; the preview carries only the metadata
        the owner reviews before anything changes.
        """
        operation: MailOperation = "search_inbox" if arguments.get("query") else "list_recent"
        limit, query, mailbox = _arguments(operation, arguments)
        if label_name is not None and (
            not isinstance(label_name, str)
            or not label_name.strip()
            or len(label_name) > 225
            or any(ord(char) < 32 for char in label_name)
        ):
            raise GmailMetadataError("invalid_argument")

        async def body(client: httpx.AsyncClient, token: str) -> tuple[dict[str, Any], str | None]:
            label_id = (
                await self._label_id(client, token, label_name.strip()) if label_name else None
            )
            return await self._read(client, token, operation, limit, query, mailbox), label_id

        preview, label_id = await self._session(body, reads_bodies=False)
        shown = len(preview["untrusted_external_content"])
        return MailboxTargets(
            message_ids=tuple(self._message_ids[:shown]),
            preview=preview,
            label_id=label_id,
            account=str(self._account),
        )

    async def _label_id(self, client: httpx.AsyncClient, token: str, name: str) -> str:
        """Map a label the person named to its ID: their own labels, or a star/importance."""
        listing = await self._get(client, token, "/labels", {"fields": "labels(id,name,type)"})
        labels = listing.get("labels", [])
        if not isinstance(labels, list) or len(labels) > 10000:
            raise GmailMetadataError("invalid_response")
        wanted = name.casefold()
        for label in labels:
            if not isinstance(label, dict):
                raise GmailMetadataError("invalid_response")
            identity, label_name = label.get("id"), label.get("name")
            if not isinstance(identity, str) or not isinstance(label_name, str):
                raise GmailMetadataError("invalid_response")
            usable = label.get("type") == "user" or identity in _SETTABLE_SYSTEM_LABELS
            if usable and label_name.casefold() == wanted and _ID.fullmatch(identity):
                return identity
        raise GmailMetadataError("label_not_found")

    async def _session(
        self,
        body: Callable[[httpx.AsyncClient, str], Awaitable[Any]],
        *,
        reads_bodies: bool,
    ) -> Any:
        if self._used:
            raise GmailMetadataError("read_already_used")
        self._used = True
        if reads_bodies:
            self._remaining = _BODY_BUDGET
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
                    result = await body(client, access_token)
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
        self,
        client: httpx.AsyncClient,
        token: str,
        path: str,
        params: dict[str, Any],
        *,
        recheck: bool = True,
    ) -> dict[str, Any]:
        # HTTPX URL spans otherwise retain inbox queries and provider IDs.
        with suppress_instrumentation():
            return await self._get_private(client, token, path, params, recheck=recheck)

    async def _get_private(
        self,
        client: httpx.AsyncClient,
        token: str,
        path: str,
        params: dict[str, Any],
        *,
        recheck: bool,
    ) -> dict[str, Any]:
        # A concurrent page is rechecked once by its caller before and after the
        # fan-out, so it holds one database connection rather than one per read.
        if recheck:
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
        mailbox: str = "inbox",
    ) -> dict[str, Any]:
        is_threads = operation in {"list_needs_reply", "read_thread"}
        reads_bodies = operation in _BODY_OPERATIONS
        maximum = 25 if operation == "list_needs_reply" else limit
        params: dict[str, Any] = {
            "maxResults": maximum,
            "includeSpamTrash": "false",
            "fields": "messages(id,threadId),nextPageToken",
        }
        # list_recent is the newest INBOX page with no search expression; the
        # provider already returns it newest first. A body read with no
        # criteria reads the newest mail the same way.
        label = _MAILBOX_LABELS[mailbox]
        if label is not None:
            params["labelIds"] = label
        if operation == "list_needs_reply":
            params["q"] = _NUDGE_QUERY
        elif operation != "list_recent" and query:
            params["q"] = query
        listing = await self._get(client, token, "/messages", params)
        entries = listing.get("messages", [])
        if not isinstance(entries, list) or len(entries) > maximum:
            raise GmailMetadataError("invalid_response")
        id_key = "threadId" if is_threads else "id"
        ids: list[str] = []
        for entry in entries:
            identity = entry.get(id_key) if isinstance(entry, dict) else None
            if not isinstance(identity, str) or not _ID.fullmatch(identity):
                raise GmailMetadataError("invalid_response")
            if identity not in ids:
                ids.append(identity)
        if not is_threads:
            self._message_ids = ids

        if reads_bodies:
            fields = f"id,messages({_FULL_FIELDS})" if is_threads else _FULL_FIELDS
            request = {"format": "full", "fields": fields}
        else:
            request = {
                "format": "metadata",
                # Recipients are requested only for sent mail, where they
                # replace the owner as the meaningful counterparty.
                "metadataHeaders": _HEADERS + (["To"] if mailbox == "sent" else []),
                "fields": f"id,messages({_FIELDS})" if is_threads else _FIELDS,
            }
        max_headers = 400 if reads_bodies else 16

        async def fetch(identity: str) -> dict[str, Any]:
            payload = await self._get(
                client,
                token,
                f"/{'threads' if is_threads else 'messages'}/{identity}",
                request,
                recheck=False,
            )
            if payload.get("id") != identity:
                raise GmailMetadataError("invalid_response")
            if is_threads:
                messages = payload.get("messages")
                if not isinstance(messages, list) or not messages or len(messages) > 100:
                    raise GmailMetadataError("invalid_response")
                for message in messages:
                    _validate_message(message, max_headers=max_headers)
            else:
                _validate_message(payload, max_headers=max_headers)
            return payload

        # One page, bounded concurrent reads in listing order. No best-effort
        # exception swallowing: an unavailable inbox is not an empty inbox.
        await self.require_current()
        payloads = await in_listing_order(ids, fetch)
        await self.require_current()
        # "Last N" asked for exactly N newest messages, and a body read asked for
        # the newest matches, so older mail beyond the page is not an omission.
        # Search and needs-reply still report a next page as truncation because
        # matches were left out.
        truncated = operation in {"list_needs_reply", "search_inbox"} and bool(
            listing.get("nextPageToken")
        )
        if operation == "list_needs_reply":
            raw_items, truncated = await self._needs_reply_items(payloads, limit, truncated)
        elif reads_bodies:
            messages = (
                [m for payload in payloads for m in payload["messages"]] if is_threads else payloads
            )
            if len(messages) > _MAX_THREAD_MESSAGES:
                messages = messages[-_MAX_THREAD_MESSAGES:]
                truncated = True
            raw_items = [self._message_item(m, mailbox, with_body=True) for m in messages]
            # Every message shares one readable-text allowance.
            allowance = max(800, min(12000, _BODY_TEXT_BUDGET // max(1, len(raw_items))))
            for item in raw_items:
                item["body"], cut_body = cap_utf8(item["body"], allowance)
                item["body_truncated"] = cut_body
                truncated = truncated or cut_body
        else:
            raw_items = [self._message_item(payload, mailbox) for payload in payloads]
        items = []
        for ordinal, item in enumerate(raw_items, 1):
            subject, cut_subject = _label(item["subject"], 320)
            sender, cut_sender = _label(item["sender"], 160)
            truncated = truncated or cut_subject or cut_sender
            projected: dict[str, Any] = {
                "source_ref": f"mail:{ordinal}",
                "subject": subject,
                "sender": sender,
                "received_at": item["received_at"],
            }
            if "unread" in item:
                projected["unread"] = item["unread"]
            if "recipient" in item:
                recipient, cut_recipient = _label(item["recipient"], 160)
                truncated = truncated or cut_recipient
                projected["recipient"] = recipient
            if "body" in item:
                projected["body"] = item["body"]
                projected["body_truncated"] = item["body_truncated"]
            items.append(projected)
        result = {
            "status": "ok",
            "operation": operation,
            "mailbox": mailbox,
            "untrusted_external_content": items,
            "truncated": truncated,
            "metadata_only": not reads_bodies,
            "one_page_only": True,
        }
        # Leave space inside the 32-KB specialist envelope for status and the
        # interpreted answer. Count escaped JSON too, not only Python chars.
        while len(json.dumps(result).encode("utf-8")) > 24000 and items:
            items.pop()
            result["truncated"] = True
        return result

    async def _needs_reply_items(
        self, payloads: list[dict[str, Any]], limit: int, truncated: bool
    ) -> tuple[list[dict[str, Any]], bool]:
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
        items = [
            {
                "subject": n.title,
                "sender": n.sender,
                "received_at": n.received_at.isoformat() if n.received_at else None,
            }
            for n in nudges[:limit]
        ]
        return items, truncated or len(nudges) > limit

    def _message_item(
        self, payload: dict[str, Any], mailbox: str, *, with_body: bool = False
    ) -> dict[str, Any]:
        headers = self._gmail._extract_headers(payload)
        sender, email = self._gmail._parse_from_header(headers.get("from", ""))
        received = self._gmail._message_received_at(payload, headers)
        item: dict[str, Any] = {
            "subject": headers.get("subject") or "(no subject)",
            "sender": sender or email or "Unknown sender",
            "received_at": received.isoformat() if received else None,
            "unread": "UNREAD" in payload.get("labelIds", []),
        }
        if mailbox == "sent":
            # The owner sent these, so the sender is always them; the
            # useful metadata is who received it.
            item["recipient"] = _recipient_label(headers.get("to", ""))
        if with_body:
            try:
                item["body"] = message_text(payload["payload"])
            except MessageTextError:
                raise GmailMetadataError("invalid_response") from None
        return item
