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
import hashlib
import json
import re
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from email.utils import getaddresses
from typing import Any, Literal
from weakref import WeakKeyDictionary

import httpx
from opentelemetry.instrumentation.utils import suppress_instrumentation

from hushh_mcp.services.gmail_message_text import (
    MessageTextError,
    attachment_filenames,
    cap_utf8,
    message_text,
)
from hushh_mcp.services.gmail_nudges import derive_needs_reply_nudges
from hushh_mcp.services.gmail_receipts_service import GmailApiError, GmailReceiptsService
from hushh_mcp.services.gmail_semantic_ranker import (
    clean_snippet,
    fuse_query_candidates,
    rerank_mail_candidates,
)

_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"
_ID = re.compile(r"[A-Za-z0-9_-]{1,200}\Z")
_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
_FIELDS = "id,threadId,internalDate,labelIds,payload/headers"
_SNIPPET_FIELDS = "id,threadId,internalDate,labelIds,snippet,payload/headers"
_HEADERS = ["From", "Subject", "Date"]
_HYBRID_HEADERS = ["From", "Subject", "Date", "To"]
# What a reply in the original thread is routed by. Never a body: the reply's
# recipient, subject and RFC thread headers come from these and nothing else.
_REPLY_HEADERS = ["From", "Reply-To", "To", "Subject", "Message-ID", "References"]
# Mailbox scope for a read. Spam and trash stay excluded everywhere.
_MAILBOX_LABELS: dict[str, str | None] = {"inbox": "INBOX", "sent": "SENT", "anywhere": None}
_BUDGET = 256 * 1024
# Full messages carry every header and both MIME alternatives. The budget still
# bounds memory; an oversized mailbox result fails truthfully, never partially.
_BODY_BUDGET = 4 * 1024 * 1024
_DEADLINE = 20.0
# Gmail documents rate-limit reasons inside a 403 JSON body. Only this small
# bounded error body is inspected, and no provider text crosses the reader.
_ERROR_BUDGET = 16 * 1024
_RETRY_DELAY_SECONDS = 1.0
_MIN_RETRY_REQUEST_SECONDS = 2.0
_RETRYABLE_GET_STATUSES = frozenset({429, 500, 502, 503, 504})
_RATE_LIMIT_REASONS = frozenset({"rateLimitExceeded", "userRateLimitExceeded"})
_NUDGE_QUERY = "in:inbox category:primary newer_than:30d -in:spam -in:trash"
# Per-message reads for one listing page run concurrently, bounded so a page
# never opens more than this many provider requests at once.
_FETCH_CONCURRENCY = 8
_HYBRID_FETCH_CONCURRENCY = 16
_MAX_HYBRID_QUERIES = 3
_SHARED_HTTP_CLIENTS: WeakKeyDictionary[asyncio.AbstractEventLoop, httpx.AsyncClient] = (
    WeakKeyDictionary()
)


def _shared_http_client() -> httpx.AsyncClient:
    """Reuse one pooled HTTP/2 client per event loop to avoid cold TLS handshakes."""
    loop = asyncio.get_running_loop()
    client = _SHARED_HTTP_CLIENTS.get(loop)
    if client is None or client.is_closed:
        client = httpx.AsyncClient(
            http2=True,
            timeout=10.0,
            follow_redirects=False,
            limits=httpx.Limits(
                max_connections=64,
                max_keepalive_connections=32,
                keepalive_expiry=60.0,
            ),
        )
        _SHARED_HTTP_CLIENTS[loop] = client
    return client


_BODY_OPERATIONS = frozenset({"read_message", "read_thread", "read_message_by_id", "analyze_mail"})
MAX_BODY_MESSAGES = 5
# Analysis examines actual text, not just a heading, over one bounded page.
MAX_ANALYSIS_MESSAGES = 12
# A thread answer reads its newest messages; older ones are reported as omitted.
_MAX_THREAD_MESSAGES = 10
# Readable text shared by every message in one answer, inside the 24-KB result.
_BODY_TEXT_BUDGET = 16000
_FULL_FIELDS = "id,threadId,internalDate,labelIds,payload"
MailOperation = Literal[
    "list_needs_reply",
    "list_recent",
    "search_inbox",
    "read_message",
    "read_thread",
    "read_message_by_id",
    "analyze_mail",
]
_OPERATIONS: dict[str, frozenset[str]] = {
    "list_needs_reply": frozenset({"limit", "mailbox"}),
    "list_recent": frozenset({"limit", "mailbox"}),
    "search_inbox": frozenset({"limit", "query", "mailbox"}),
    "read_message": frozenset({"limit", "query", "mailbox"}),
    "read_thread": frozenset({"query", "mailbox"}),
    # Reads exactly the messages named, with no listing and so no search. The
    # ids come from an offer this server minted, never from a model.
    "read_message_by_id": frozenset({"message_ids", "mailbox"}),
    "analyze_mail": frozenset({"limit", "query", "mailbox"}),
}
Mailbox = Literal["inbox", "sent", "anywhere"]
RequireAccess = Callable[[], Awaitable[None]]
MAIL_READ_ERROR_CODES = frozenset(
    {
        "connect_required",
        "reconnect_required",
        "connection_changed",
        "permission_denied",
        "source_changed",
        "response_too_large",
        "invalid_argument",
    }
)


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


def _arguments(operation: str, arguments: dict[str, Any]) -> tuple[int, str, str, tuple[str, ...]]:
    allowed = _OPERATIONS.get(operation)
    if allowed is None or set(arguments) - allowed:
        raise GmailMetadataError("invalid_argument")
    reads_bodies = operation in _BODY_OPERATIONS
    message_ids: tuple[str, ...] = ()
    if operation == "read_message_by_id":
        raw_ids = arguments.get("message_ids")
        if (
            not isinstance(raw_ids, list | tuple)
            or not 1 <= len(raw_ids) <= MAX_BODY_MESSAGES
            or any(not isinstance(value, str) or not _ID.fullmatch(value) for value in raw_ids)
            or len(set(raw_ids)) != len(raw_ids)
        ):
            raise GmailMetadataError("invalid_argument")
        message_ids = tuple(raw_ids)
    limit = arguments.get("limit", 1 if reads_bodies else 10)
    maximum = (
        MAX_ANALYSIS_MESSAGES
        if operation == "analyze_mail"
        else MAX_BODY_MESSAGES
        if reads_bodies
        else 25
    )
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
    if message_ids:
        limit = len(message_ids)
    return limit, query.strip(), mailbox, message_ids


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
    items: list[str],
    fetch: Callable[[str], Awaitable[dict[str, Any]]],
    *,
    concurrency: int = _FETCH_CONCURRENCY,
) -> list[dict[str, Any]]:
    """Run bounded concurrent reads and return results in the listing's order.

    The first failure cancels the rest: an unavailable message is never read
    as an absent one, and no orphaned request outlives the read.
    """
    semaphore = asyncio.Semaphore(max(1, concurrency))

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


def _coverage_scope(operation: str, query: str) -> str:
    if operation == "read_message_by_id":
        return "selected"
    if operation == "list_needs_reply":
        return "needs_reply"
    return "search" if query else "newest"


async def _forbidden_code(response: httpx.Response) -> str:
    """Classify documented Gmail 403 reasons without trusting provider prose."""

    if response.headers.get("content-encoding", "identity").lower() != "identity":
        return "permission_denied"
    content = bytearray()
    async for chunk in response.aiter_raw():
        if len(chunk) > _ERROR_BUDGET - len(content):
            return "permission_denied"
        content.extend(chunk)
    try:
        payload = json.loads(content)
    except (ValueError, UnicodeError):
        return "permission_denied"
    error = payload.get("error") if isinstance(payload, dict) else None
    reasons = error.get("errors") if isinstance(error, dict) else None
    if not isinstance(reasons, list) or not reasons or len(reasons) > 8:
        return "permission_denied"
    if any(
        not isinstance(item, dict) or not isinstance(item.get("reason"), str) for item in reasons
    ):
        return "permission_denied"
    exact_reasons = {item["reason"] for item in reasons}
    if exact_reasons <= _RATE_LIMIT_REASONS:
        return "retryable"
    if exact_reasons == {"dailyLimitExceeded"}:
        return "quota_exceeded"
    if exact_reasons == {"domainPolicy"}:
        return "domain_policy"
    if exact_reasons == {"insufficientPermissions"}:
        return "reconnect_required"
    return "permission_denied"


class GmailMetadataReader:
    """One owner, one observed Gmail grant, one bounded read per instance."""

    def __init__(
        self,
        *,
        gmail: GmailReceiptsService,
        user_id: str,
        require_access: RequireAccess,
        transport: httpx.AsyncBaseTransport | None = None,
        expect_account: str | None = None,
    ) -> None:
        self._gmail = gmail
        self._user_id = user_id
        self._require_access = require_access
        self._transport = transport
        # The account a caller's message ids were resolved in. The session fence
        # below pins the account for the duration of this read; this pins it to
        # the one the ids came from, which is a different question and the one
        # that matters when the owner reconnected a different Google account
        # between being shown a list and asking for the second thing on it.
        self._expect_account = expect_account
        self._observation: dict[str, Any] | None = None
        self._account: str | None = None
        self._used = False
        self._remaining = _BUDGET
        self._message_ids: list[str] = []
        self._offered_message_ids: tuple[str, ...] = ()
        self._offered_thread_ids: tuple[str, ...] = ()
        self._deadline_at: float | None = None

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

    def observed_grant_fingerprint(self) -> str:
        """Hub-only digest of the grant used for this read; never a credential."""
        if self._observation is None or not self._account:
            raise GmailMetadataError("connection_changed")
        return self._grant_fingerprint(self._account, self._observation)

    def _grant_fingerprint(self, account: str, observation: dict[str, Any]) -> str:
        payload = json.dumps(
            [self._user_id, account, observation],
            sort_keys=True,
            default=str,
            separators=(",", ":"),
        )
        return hashlib.sha256(payload.encode()).hexdigest()

    async def current_grant_fingerprint(self) -> str:
        """Revalidation for a stateless pod receipt, without fetching OAuth tokens."""
        await self._require_access()
        row = await asyncio.to_thread(self._gmail._fetch_connection_row, user_id=self._user_id)
        if (
            not row
            or row.get("status") != "connected"
            or row.get("revoked") is not False
            or not row.get("google_sub")
            or _SCOPE not in re.split(r"[\s,]+", str(row.get("scope_csv") or ""))
        ):
            raise GmailMetadataError("connection_changed")
        return self._grant_fingerprint(row["google_sub"], self._gmail._refresh_observation(row))

    async def read(self, operation: MailOperation, arguments: dict[str, Any]) -> dict[str, Any]:
        limit, query, mailbox, message_ids = _arguments(operation, arguments)

        async def body(client: httpx.AsyncClient, token: str) -> dict[str, Any]:
            return await self._read(client, token, operation, limit, query, mailbox, message_ids)

        return await self._session(body, reads_bodies=operation in _BODY_OPERATIONS)

    @property
    def account(self) -> str:
        """The Google account this read was served from. Empty before the read."""
        return str(self._account or "")

    def offered_message_ids(self) -> tuple[str, ...]:
        """Provider ids for the rows this read returned, in the order shown.

        Ordinal N in the result is index N-1 here, so a caller can bind "the
        second one" to a message rather than to a position that a later search
        would fill differently.

        Empty when the mapping cannot be trusted -- an operation that cannot name
        a message per row, or a length that does not match the rows. An empty map
        makes a later positional request refuse honestly; a misaligned one would
        read the wrong mail.
        """
        return self._offered_message_ids

    def offered_thread_ids(self) -> tuple[str, ...]:
        """Provider thread ids aligned 1:1 with ``offered_message_ids()``."""
        return self._offered_thread_ids

    async def search_hybrid(
        self,
        *,
        intent: str = "",
        queries: Sequence[str] = (),
        mailbox: Mailbox = "anywhere",
        limit: int = 12,
        read_top_bodies: int = 3,
        max_candidates: int = 24,
        embedding_client: Any | None = None,
    ) -> dict[str, Any]:
        """Pure-REST multi-query recall + in-RAM semantic re-rank + top-K body hydration."""
        if mailbox not in _MAILBOX_LABELS:
            raise GmailMetadataError("invalid_argument")
        if type(limit) is not int or not 1 <= limit <= 25:
            raise GmailMetadataError("invalid_argument")
        if type(read_top_bodies) is not int or not 0 <= read_top_bodies <= MAX_BODY_MESSAGES:
            raise GmailMetadataError("invalid_argument")
        if type(max_candidates) is not int or not 1 <= max_candidates <= 30:
            raise GmailMetadataError("invalid_argument")
        if not isinstance(intent, str) or len(intent.encode("utf-8")) > 512:
            raise GmailMetadataError("invalid_argument")
        if any(ord(char) < 32 for char in intent):
            raise GmailMetadataError("invalid_argument")
        if not isinstance(queries, Sequence) or isinstance(queries, str | bytes):
            raise GmailMetadataError("invalid_argument")
        cleaned_queries: list[str] = []
        for raw_query in queries:
            if not isinstance(raw_query, str):
                raise GmailMetadataError("invalid_argument")
            q = raw_query.strip()
            if len(q.encode("utf-8")) > 512 or any(ord(char) < 32 for char in q):
                raise GmailMetadataError("invalid_argument")
            if q and q not in cleaned_queries:
                cleaned_queries.append(q)
        if len(cleaned_queries) > _MAX_HYBRID_QUERIES:
            raise GmailMetadataError("invalid_argument")

        async def body(client: httpx.AsyncClient, token: str) -> dict[str, Any]:
            return await self._search_hybrid(
                client=client,
                token=token,
                intent=intent.strip(),
                queries=tuple(cleaned_queries),
                mailbox=mailbox,
                limit=limit,
                read_top_bodies=read_top_bodies,
                max_candidates=max_candidates,
                embedding_client=embedding_client,
            )

        return await self._session(body, reads_bodies=read_top_bodies > 0)

    async def read_threads(
        self,
        *,
        message_ids: Sequence[str] = (),
        thread_ids: Sequence[str] = (),
        mailbox: Mailbox = "anywhere",
        whole_thread: bool = True,
    ) -> dict[str, Any]:
        """Read full chronological threads or specific messages by server-minted IDs."""
        if mailbox not in _MAILBOX_LABELS:
            raise GmailMetadataError("invalid_argument")
        if bool(message_ids) == bool(thread_ids):
            raise GmailMetadataError("invalid_argument")
        raw_ids = tuple(thread_ids) if thread_ids else tuple(message_ids)
        if (
            not 1 <= len(raw_ids) <= MAX_BODY_MESSAGES
            or any(not isinstance(v, str) or not _ID.fullmatch(v) for v in raw_ids)
            or len(set(raw_ids)) != len(raw_ids)
        ):
            raise GmailMetadataError("invalid_argument")

        async def body(client: httpx.AsyncClient, token: str) -> dict[str, Any]:
            return await self._read_threads(
                client=client,
                token=token,
                raw_ids=raw_ids,
                by_thread_id=bool(thread_ids),
                mailbox=mailbox,
                whole_thread=whole_thread,
            )

        return await self._session(body, reads_bodies=True)

    async def resolve_targets_by_ids(
        self,
        message_ids: Sequence[str],
        *,
        mailbox: Mailbox = "anywhere",
        label_name: str | None = None,
    ) -> MailboxTargets:
        """Resolve exact server-offered message IDs into a reviewed metadata preview.

        IDs must come from server-minted ``STATE_MAIL_READ_OFFER``, never from a
        model argument. The session fence pins ``expect_account`` so an account
        switch refuses cleanly.
        """
        if mailbox not in _MAILBOX_LABELS:
            raise GmailMetadataError("invalid_argument")
        raw_ids = tuple(message_ids)
        if (
            not 1 <= len(raw_ids) <= 25
            or any(not isinstance(v, str) or not _ID.fullmatch(v) for v in raw_ids)
            or len(set(raw_ids)) != len(raw_ids)
        ):
            raise GmailMetadataError("invalid_argument")
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
            request = {
                "format": "metadata",
                "metadataHeaders": _HEADERS + (["To"] if mailbox == "sent" else []),
                "fields": _FIELDS,
            }

            async def fetch(identity: str) -> dict[str, Any]:
                payload = await self._get(
                    client, token, f"/messages/{identity}", request, recheck=False
                )
                if payload.get("id") != identity:
                    raise GmailMetadataError("invalid_response")
                _validate_message(payload, max_headers=16)
                return payload

            await self.require_current()
            payloads = await in_listing_order(list(raw_ids), fetch)
            await self.require_current()
            raw_items = [self._message_item(payload, mailbox) for payload in payloads]
            items: list[dict[str, Any]] = []
            content_shortened = False
            for ordinal, item in enumerate(raw_items, 1):
                subject, cut_subject = _label(item["subject"], 320)
                sender, cut_sender = _label(item["sender"], 160)
                content_shortened = content_shortened or cut_subject or cut_sender
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
                    content_shortened = content_shortened or cut_recipient
                    projected["recipient"] = recipient
                items.append(projected)
            preview: dict[str, Any] = {
                "status": "ok",
                "operation": "read_message_by_id",
                "mailbox": mailbox,
                "untrusted_external_content": items,
                "truncated": content_shortened,
                "metadata_only": True,
                "one_page_only": True,
            }
            items_omitted = False
            while len(json.dumps(preview).encode("utf-8")) > 24000 and items:
                items.pop()
                items_omitted = True
                preview["truncated"] = True
            preview["coverage"] = {
                "operation": "read_message_by_id",
                "mailbox": mailbox,
                "scope": "selected",
                "unit": "messages",
                "assessed": len(raw_ids),
                "returned": len(items),
                "matches_beyond_page": False,
                "items_omitted": items_omitted,
                "content_shortened": content_shortened,
                "content_depth": "metadata",
                "one_page_only": True,
            }
            return preview, label_id

        preview, label_id = await self._session(body, reads_bodies=False)
        shown = len(preview["untrusted_external_content"])
        return MailboxTargets(
            message_ids=tuple(raw_ids[:shown]),
            preview=preview,
            label_id=label_id,
            account=str(self._account),
        )

    async def resolve_targets(
        self, arguments: dict[str, Any], *, label_name: str | None = None
    ) -> MailboxTargets:
        """Resolve one page of messages for a reviewed mailbox change.

        The same fenced session as a read. Provider message and label IDs stay
        on the server side of the result; the preview carries only the metadata
        the owner reviews before anything changes.
        """
        operation: MailOperation = "search_inbox" if arguments.get("query") else "list_recent"
        # Mailbox changes are never targeted by id from a caller; they are
        # resolved from a listing the owner reviews, so there are no ids here.
        limit, query, mailbox, _ = _arguments(operation, arguments)
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

    async def reply_source(self, message_id: str) -> dict[str, Any]:
        """Routing headers of one message this server offered, for a reply in its thread.

        Metadata only, never a body, under the same fenced session as a read:
        the account is pinned to the one the id was offered in and the grant is
        rechecked either side of the fetch. The id comes from a server offer,
        never from a model. Returns the provider message (id, thread id, labels,
        the requested headers); the caller derives the reply envelope from it.
        """
        if not isinstance(message_id, str) or not _ID.fullmatch(message_id):
            raise GmailMetadataError("invalid_argument")

        async def body(client: httpx.AsyncClient, token: str) -> dict[str, Any]:
            payload = await self._get(
                client,
                token,
                f"/messages/{message_id}",
                {"format": "metadata", "metadataHeaders": _REPLY_HEADERS, "fields": _FIELDS},
            )
            thread_id = payload.get("threadId")
            if (
                payload.get("id") != message_id
                or not isinstance(thread_id, str)
                or not _ID.fullmatch(thread_id)
            ):
                raise GmailMetadataError("invalid_response")
            # Six requested headers; a repeated one (two References lines) is
            # still bounded well below this.
            _validate_message(payload, max_headers=32)
            return payload

        result: dict[str, Any] = await self._session(body, reads_bodies=False)
        return result

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
            self._deadline_at = asyncio.get_running_loop().time() + _DEADLINE
            async with asyncio.timeout_at(self._deadline_at):
                await self._require_access()
                row = await asyncio.to_thread(
                    self._gmail._fetch_connection_row, user_id=self._user_id
                )
                if not row or row.get("status") == "disconnected":
                    raise GmailMetadataError("connect_required")
                if row.get("status") != "connected" or row.get("revoked"):
                    raise GmailMetadataError("reconnect_required")
                if _SCOPE not in re.split(r"[\s,]+", str(row.get("scope_csv") or "")):
                    raise GmailMetadataError("reconnect_required")
                access_token, row = await self._gmail._ensure_access_token(user_id=self._user_id)
                self._observation = self._gmail._refresh_observation(row)
                self._account = row.get("google_sub")
                if not self._account or not all(self._observation.values()):
                    raise GmailMetadataError("reconnect_required")
                if self._expect_account and self._account != self._expect_account:
                    # Refuse before any fetch. Ids are meaningless in another
                    # mailbox, and a request for "the second one" must not turn
                    # into a read of some unrelated message that now holds that
                    # position.
                    raise GmailMetadataError("source_changed")
                await self.require_current()
                if self._transport is None:
                    result = await body(_shared_http_client(), access_token)
                else:
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
        for attempt in range(2):
            if recheck or attempt:
                # Even a harmless GET must not retry against a changed grant.
                await self.require_current()
            retry_allowed = False
            retry_delay = _RETRY_DELAY_SECONDS
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
                    code = await _forbidden_code(response)
                    retry_allowed = code == "retryable"
                elif response.status_code == 404:
                    raise GmailMetadataError("source_changed")
                elif response.status_code != 200:
                    code = "retryable"
                    retry_allowed = response.status_code in _RETRYABLE_GET_STATUSES
                else:
                    if response.headers.get("content-encoding", "identity").lower() != "identity":
                        raise GmailMetadataError("invalid_response")
                    content = bytearray()
                    async for chunk in response.aiter_raw():
                        self._remaining -= len(chunk)
                        if self._remaining < 0:
                            raise GmailMetadataError("response_too_large")
                        content.extend(chunk)
                    break
                # A provider wait longer than this turn's deadline is returned
                # as retryable rather than silently ignored or slept through.
                retry_after = response.headers.get("retry-after", "")
                if retry_after:
                    retry_delay = (
                        max(retry_delay, float(retry_after))
                        if len(retry_after) <= 3
                        and retry_after.isascii()
                        and retry_after.isdecimal()
                        else _DEADLINE
                    )
            deadline_at = self._deadline_at
            can_retry = (
                attempt == 0
                and retry_allowed
                and deadline_at is not None
                and asyncio.get_running_loop().time() + retry_delay + _MIN_RETRY_REQUEST_SECONDS
                < deadline_at
            )
            if not can_retry:
                raise GmailMetadataError(code)
            await asyncio.sleep(retry_delay)
        try:
            payload = json.loads(content)
        except (ValueError, UnicodeError):
            raise GmailMetadataError("invalid_response") from None
        if not isinstance(payload, dict):
            raise GmailMetadataError("invalid_response")
        return payload

    async def _listing(
        self,
        client: httpx.AsyncClient,
        token: str,
        operation: MailOperation,
        limit: int,
        query: str,
        mailbox: str,
    ) -> tuple[list[str], dict[str, Any]]:
        """One page of ids, newest first, deduplicated. No content."""
        is_threads = operation in {"list_needs_reply", "read_thread"}
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
        return ids, listing

    async def _read(
        self,
        client: httpx.AsyncClient,
        token: str,
        operation: MailOperation,
        limit: int,
        query: str,
        mailbox: str = "inbox",
        message_ids: tuple[str, ...] = (),
    ) -> dict[str, Any]:
        is_threads = operation in {"list_needs_reply", "read_thread"}
        reads_bodies = operation in _BODY_OPERATIONS
        listing: dict[str, Any] = {}
        ids: list[str] = []
        if operation == "read_message_by_id":
            # No listing, so no search whose results could have shifted since
            # these ids were offered. That is the point of the operation.
            ids = list(message_ids)
        else:
            ids, listing = await self._listing(client, token, operation, limit, query, mailbox)
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
        matches_beyond_page = operation in {
            "list_needs_reply",
            "search_inbox",
            "analyze_mail",
        } and bool(listing.get("nextPageToken"))
        # Three different facts, not one. "More matches exist beyond this page",
        # "results were dropped to fit", and "text was shortened" lead the person
        # to do different things, and a single `truncated` bool made One say
        # "there may be more than I checked" when only a body had been clipped.
        items_omitted = False
        content_shortened = False
        assessed: int | None = len(ids)
        # One provider id per projected row, in row order, so a caller can bind
        # an ordinal to a message. Tracked alongside the rows rather than derived
        # afterwards, because needs-reply re-sorts and filters its threads and a
        # body read flattens one: neither row order matches the listing order.
        ordered_ids: list[str] = list(ids)
        if operation == "list_needs_reply":
            raw_items, matches_beyond_page, assessed, ordered_ids = await self._needs_reply_items(
                payloads, limit, matches_beyond_page
            )
        elif reads_bodies:
            messages = (
                [m for payload in payloads for m in payload["messages"]] if is_threads else payloads
            )
            assessed = len(messages)
            if operation == "read_thread" and len(messages) > _MAX_THREAD_MESSAGES:
                messages = messages[-_MAX_THREAD_MESSAGES:]
                items_omitted = True
            raw_items = [self._message_item(m, mailbox, with_body=True) for m in messages]
            ordered_ids = [str(message.get("id") or "") for message in messages]
            if operation == "analyze_mail":
                # Local grouping only. Provider thread IDs never leave the reader;
                # the analyzer can still compare a later update with its earlier
                # message in the same bounded page.
                thread_refs: dict[str, str] = {}
                for item, message in zip(raw_items, messages, strict=True):
                    thread_id = str(message.get("threadId") or "")
                    if thread_id:
                        item["thread_ref"] = thread_refs.setdefault(
                            thread_id, f"thread:{len(thread_refs) + 1}"
                        )
            # Every message shares one readable-text allowance.
            allowance = max(800, min(12000, _BODY_TEXT_BUDGET // max(1, len(raw_items))))
            for item in raw_items:
                item["body"], cut_body = cap_utf8(item["body"], allowance)
                item["body_truncated"] = cut_body
                content_shortened = content_shortened or cut_body
        else:
            raw_items = [self._message_item(payload, mailbox) for payload in payloads]
        items = []
        for ordinal, item in enumerate(raw_items, 1):
            subject, cut_subject = _label(item["subject"], 320)
            sender, cut_sender = _label(item["sender"], 160)
            content_shortened = content_shortened or cut_subject or cut_sender
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
                content_shortened = content_shortened or cut_recipient
                projected["recipient"] = recipient
            if "body" in item:
                projected["body"] = item["body"]
                projected["body_truncated"] = item["body_truncated"]
            if "thread_ref" in item:
                projected["thread_ref"] = item["thread_ref"]
            items.append(projected)
        result: dict[str, Any] = {
            "status": "ok",
            "operation": operation,
            "mailbox": mailbox,
            "untrusted_external_content": items,
            "truncated": matches_beyond_page or items_omitted or content_shortened,
            "metadata_only": not reads_bodies,
            "one_page_only": True,
        }
        # Leave space inside the 32-KB specialist envelope for status and the
        # interpreted answer. Count escaped JSON too, not only Python chars.
        #
        # This pops from the END, so the surviving items keep their original
        # `mail:1..N` refs as a contiguous prefix. An ordinal the person was
        # offered therefore still means the message it meant when offered.
        while len(json.dumps(result).encode("utf-8")) > 24000 and items:
            items.pop()
            items_omitted = True
            result["truncated"] = True
        # Bound after the trim, so the map covers exactly the surviving rows. A
        # length mismatch or an unusable id yields no map at all: a later
        # positional request then refuses honestly, where a misaligned map would
        # quietly read a different message.
        row_ids = ordered_ids[: len(items)]
        self._offered_message_ids = (
            tuple(row_ids)
            if len(row_ids) == len(items) and all(_ID.fullmatch(value) for value in row_ids)
            else ()
        )
        # Described after the trim, so `returned` is what the person can
        # actually be shown rather than what was fetched. Coverage is not part
        # of the interpreter's evidence; the caller reads it separately.
        result["coverage"] = {
            "operation": operation,
            "mailbox": mailbox,
            # What the read covered, so a count cannot imply a whole mailbox.
            # "newest" is the front of the mailbox and nothing more: five bodies
            # is this reader's budget, not evidence that five is all there is.
            # "needs_reply" is a filtered set (threads that may need a reply),
            # so it must never be described as the newest mail.
            "scope": _coverage_scope(operation, query),
            # One row per thread for needs-reply, one per message everywhere else.
            "unit": "threads" if operation == "list_needs_reply" else "messages",
            "assessed": assessed,
            "returned": len(items),
            "matches_beyond_page": matches_beyond_page,
            "items_omitted": items_omitted,
            "content_shortened": content_shortened,
            "content_depth": "message" if reads_bodies else "metadata",
            "one_page_only": True,
        }
        return result

    async def _needs_reply_items(
        self, payloads: list[dict[str, Any]], limit: int, truncated: bool
    ) -> tuple[list[dict[str, Any]], bool, int, list[str]]:
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
        shown = nudges[:limit]
        items = [
            {
                "subject": n.title,
                "sender": n.sender,
                "received_at": n.received_at.isoformat() if n.received_at else None,
            }
            for n in shown
        ]
        # The assessed count is every thread the nudge rule evaluated, which is
        # what makes "three need a reply out of twelve I checked" sayable.
        #
        # The nudge already knows which message it is about. Dropping that id is
        # why "read the second one" had nothing to resolve against on the one
        # operation a person is most likely to say it about.
        return (
            items,
            truncated or len(nudges) > limit,
            len(nudges),
            [str(n.message_id or "") for n in shown],
        )

    async def _search_hybrid(
        self,
        *,
        client: httpx.AsyncClient,
        token: str,
        intent: str,
        queries: tuple[str, ...],
        mailbox: Mailbox,
        limit: int,
        read_top_bodies: int,
        max_candidates: int,
        embedding_client: Any | None,
    ) -> dict[str, Any]:
        """Parallel multi-query REST recall + in-RAM E5/RRF re-rank + top-K body hydration."""
        label = _MAILBOX_LABELS[mailbox]
        page_size = max(limit, min(25, max_candidates))
        effective_queries: tuple[str, ...] = queries if queries else ("",)

        async def list_one(query: str) -> tuple[list[dict[str, str]], bool]:
            params: dict[str, Any] = {
                "maxResults": page_size,
                "includeSpamTrash": "false",
                "fields": "messages(id,threadId),nextPageToken",
            }
            if label is not None:
                params["labelIds"] = label
            if query:
                params["q"] = query
            listing = await self._get(client, token, "/messages", params, recheck=False)
            entries = listing.get("messages", [])
            if not isinstance(entries, list) or len(entries) > page_size:
                raise GmailMetadataError("invalid_response")
            validated: list[dict[str, str]] = []
            for entry in entries:
                if not isinstance(entry, dict):
                    raise GmailMetadataError("invalid_response")
                msg_id = entry.get("id")
                thread_id = entry.get("threadId")
                if not isinstance(msg_id, str) or not _ID.fullmatch(msg_id):
                    raise GmailMetadataError("invalid_response")
                if thread_id is not None and (
                    not isinstance(thread_id, str) or not _ID.fullmatch(thread_id)
                ):
                    raise GmailMetadataError("invalid_response")
                validated.append({"id": msg_id, "threadId": thread_id or msg_id})
            return validated, bool(listing.get("nextPageToken"))

        list_results = await asyncio.gather(*(list_one(q) for q in effective_queries))
        ranked_lists = [entries for entries, _ in list_results]
        matches_beyond_page = any(has_more for _, has_more in list_results)

        fused = fuse_query_candidates(ranked_lists, max_candidates=max_candidates)
        if not fused:
            self._offered_message_ids = ()
            self._offered_thread_ids = ()
            return {
                "status": "ok",
                "operation": "search_hybrid",
                "mailbox": mailbox,
                "untrusted_external_content": [],
                "truncated": False,
                "metadata_only": True,
                "one_page_only": True,
                "semantic_reranked": False,
                "coverage": {
                    "operation": "search_hybrid",
                    "mailbox": mailbox,
                    "scope": "search" if queries else "newest",
                    "unit": "messages",
                    "assessed": 0,
                    "returned": 0,
                    "matches_beyond_page": False,
                    "items_omitted": False,
                    "content_shortened": False,
                    "content_depth": "metadata",
                    "one_page_only": True,
                },
            }

        candidate_ids = [item["id"] for item in fused]
        meta_request = {
            "format": "metadata",
            "metadataHeaders": _HYBRID_HEADERS,
            "fields": _SNIPPET_FIELDS,
        }

        async def fetch_meta(identity: str) -> dict[str, Any]:
            payload = await self._get(
                client, token, f"/messages/{identity}", meta_request, recheck=False
            )
            if payload.get("id") != identity:
                raise GmailMetadataError("invalid_response")
            _validate_message(payload, max_headers=16)
            return payload

        await self.require_current()
        meta_payloads = await in_listing_order(
            candidate_ids, fetch_meta, concurrency=_HYBRID_FETCH_CONCURRENCY
        )
        await self.require_current()
        raw_candidates = [
            self._message_item(payload, mailbox, include_snippet=True) for payload in meta_payloads
        ]

        used_semantic = False
        if intent and len(raw_candidates) > 1:
            ordered_indices, used_semantic = await asyncio.to_thread(
                rerank_mail_candidates,
                intent,
                raw_candidates,
                embedding_client=embedding_client,
            )
        else:
            ordered_indices = list(range(len(raw_candidates)))

        assessed = len(raw_candidates)
        selected_indices = ordered_indices[:limit]
        items_omitted = len(ordered_indices) > limit

        hydrate_count = min(read_top_bodies, len(selected_indices))
        body_payloads: dict[int, dict[str, Any]] = {}
        if hydrate_count > 0:
            top_indices = selected_indices[:hydrate_count]
            top_ids = [fused[idx]["id"] for idx in top_indices]
            full_request = {"format": "full", "fields": _FULL_FIELDS}

            async def fetch_full(identity: str) -> dict[str, Any]:
                payload = await self._get(
                    client, token, f"/messages/{identity}", full_request, recheck=False
                )
                if payload.get("id") != identity:
                    raise GmailMetadataError("invalid_response")
                _validate_message(payload, max_headers=400)
                return payload

            await self.require_current()
            hydrated = await in_listing_order(top_ids, fetch_full)
            await self.require_current()
            for idx, payload in zip(top_indices, hydrated, strict=True):
                body_payloads[idx] = payload

        content_shortened = False
        body_allowance = (
            max(1000, min(8000, (_BODY_TEXT_BUDGET - 4000) // max(1, hydrate_count)))
            if hydrate_count > 0
            else 0
        )
        items: list[dict[str, Any]] = []
        ordered_msg_ids: list[str] = []
        ordered_thread_ids: list[str] = []

        for ordinal, idx in enumerate(selected_indices, 1):
            base = dict(raw_candidates[idx])
            if idx in body_payloads:
                full_item = self._message_item(
                    body_payloads[idx],
                    mailbox,
                    with_body=True,
                    include_attachments=True,
                )
                body_text, cut_body = cap_utf8(full_item["body"], body_allowance)
                base["body"] = body_text
                base["body_truncated"] = cut_body
                content_shortened = content_shortened or cut_body
                if full_item.get("attachments"):
                    base["attachments"] = full_item["attachments"]

            subject, cut_subject = _label(base["subject"], 320)
            sender, cut_sender = _label(base["sender"], 160)
            content_shortened = content_shortened or cut_subject or cut_sender
            projected: dict[str, Any] = {
                "source_ref": f"mail:{ordinal}",
                "subject": subject,
                "sender": sender,
                "received_at": base["received_at"],
                "unread": base["unread"],
            }
            if base.get("snippet"):
                projected["snippet"] = base["snippet"]
            if base.get("recipient"):
                recipient, cut_recipient = _label(base["recipient"], 160)
                content_shortened = content_shortened or cut_recipient
                projected["recipient"] = recipient
            if "body" in base:
                projected["body"] = base["body"]
                projected["body_truncated"] = base["body_truncated"]
            if base.get("attachments"):
                projected["attachments"] = base["attachments"]
            if fused[idx]["thread_hits"] > 1:
                projected["thread_hits"] = fused[idx]["thread_hits"]
            items.append(projected)
            ordered_msg_ids.append(fused[idx]["id"])
            ordered_thread_ids.append(fused[idx]["threadId"])

        result: dict[str, Any] = {
            "status": "ok",
            "operation": "search_hybrid",
            "mailbox": mailbox,
            "untrusted_external_content": items,
            "truncated": matches_beyond_page or items_omitted or content_shortened,
            "metadata_only": hydrate_count == 0,
            "one_page_only": True,
            "semantic_reranked": used_semantic,
        }
        while len(json.dumps(result).encode("utf-8")) > 24000 and items:
            items.pop()
            items_omitted = True
            result["truncated"] = True

        surviving_msg_ids = ordered_msg_ids[: len(items)]
        surviving_thread_ids = ordered_thread_ids[: len(items)]
        self._offered_message_ids = (
            tuple(surviving_msg_ids)
            if len(surviving_msg_ids) == len(items)
            and all(_ID.fullmatch(value) for value in surviving_msg_ids)
            else ()
        )
        self._offered_thread_ids = (
            tuple(surviving_thread_ids)
            if len(surviving_thread_ids) == len(items)
            and all(_ID.fullmatch(value) for value in surviving_thread_ids)
            else ()
        )
        result["coverage"] = {
            "operation": "search_hybrid",
            "mailbox": mailbox,
            "scope": "search" if queries else "newest",
            "unit": "messages",
            "assessed": assessed,
            "returned": len(items),
            "matches_beyond_page": matches_beyond_page,
            "items_omitted": items_omitted,
            "content_shortened": content_shortened,
            "content_depth": "message" if hydrate_count > 0 else "metadata",
            "one_page_only": True,
        }
        return result

    async def _read_threads(
        self,
        *,
        client: httpx.AsyncClient,
        token: str,
        raw_ids: tuple[str, ...],
        by_thread_id: bool,
        mailbox: Mailbox,
        whole_thread: bool,
    ) -> dict[str, Any]:
        """Fetch full chronological threads or individual messages by verified provider ID."""
        resolved_thread_ids: list[str] = []
        if whole_thread and not by_thread_id:

            async def resolve_tid(msg_id: str) -> dict[str, Any]:
                payload = await self._get(
                    client,
                    token,
                    f"/messages/{msg_id}",
                    {"format": "minimal", "fields": "id,threadId"},
                    recheck=False,
                )
                tid = payload.get("threadId")
                if (
                    payload.get("id") != msg_id
                    or not isinstance(tid, str)
                    or not _ID.fullmatch(tid)
                ):
                    raise GmailMetadataError("invalid_response")
                return payload

            await self.require_current()
            resolved = await in_listing_order(list(raw_ids), resolve_tid)
            await self.require_current()
            for item in resolved:
                tid = str(item["threadId"])
                if tid not in resolved_thread_ids:
                    resolved_thread_ids.append(tid)
            fetch_ids = resolved_thread_ids
            is_threads = True
        elif whole_thread and by_thread_id:
            fetch_ids = list(raw_ids)
            is_threads = True
        else:
            fetch_ids = list(raw_ids)
            is_threads = False

        fields = f"id,messages({_FULL_FIELDS})" if is_threads else _FULL_FIELDS
        request = {"format": "full", "fields": fields}

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
                    _validate_message(message, max_headers=400)
            else:
                _validate_message(payload, max_headers=400)
            return payload

        await self.require_current()
        payloads = await in_listing_order(fetch_ids, fetch)
        await self.require_current()
        messages = (
            [m for payload in payloads for m in payload["messages"]] if is_threads else payloads
        )
        assessed = len(messages)
        items_omitted = False
        if is_threads and len(messages) > _MAX_THREAD_MESSAGES:
            messages = messages[-_MAX_THREAD_MESSAGES:]
            items_omitted = True

        raw_items = [
            self._message_item(m, mailbox, with_body=True, include_attachments=True)
            for m in messages
        ]
        ordered_msg_ids = [str(m.get("id") or "") for m in messages]
        ordered_thread_ids = [str(m.get("threadId") or "") for m in messages]
        allowance = max(800, min(12000, _BODY_TEXT_BUDGET // max(1, len(raw_items))))
        content_shortened = False
        items: list[dict[str, Any]] = []
        thread_refs: dict[str, str] = {}

        for ordinal, (raw_item, msg) in enumerate(zip(raw_items, messages, strict=True), 1):
            body_text, cut_body = cap_utf8(raw_item["body"], allowance)
            subject, cut_subject = _label(raw_item["subject"], 320)
            sender, cut_sender = _label(raw_item["sender"], 160)
            content_shortened = content_shortened or cut_body or cut_subject or cut_sender
            projected: dict[str, Any] = {
                "source_ref": f"mail:{ordinal}",
                "subject": subject,
                "sender": sender,
                "received_at": raw_item["received_at"],
                "unread": raw_item["unread"],
                "body": body_text,
                "body_truncated": cut_body,
            }
            if raw_item.get("recipient"):
                recipient, cut_recipient = _label(raw_item["recipient"], 160)
                content_shortened = content_shortened or cut_recipient
                projected["recipient"] = recipient
            if raw_item.get("attachments"):
                projected["attachments"] = raw_item["attachments"]
            tid = str(msg.get("threadId") or "")
            if tid:
                projected["thread_ref"] = thread_refs.setdefault(
                    tid, f"thread:{len(thread_refs) + 1}"
                )
            items.append(projected)

        result: dict[str, Any] = {
            "status": "ok",
            "operation": "read_thread" if is_threads else "read_message_by_id",
            "mailbox": mailbox,
            "untrusted_external_content": items,
            "truncated": items_omitted or content_shortened,
            "metadata_only": False,
            "one_page_only": True,
        }
        while len(json.dumps(result).encode("utf-8")) > 24000 and items:
            items.pop()
            items_omitted = True
            result["truncated"] = True

        surviving_msg_ids = ordered_msg_ids[: len(items)]
        surviving_thread_ids = ordered_thread_ids[: len(items)]
        self._offered_message_ids = (
            tuple(surviving_msg_ids)
            if len(surviving_msg_ids) == len(items)
            and all(_ID.fullmatch(value) for value in surviving_msg_ids)
            else ()
        )
        self._offered_thread_ids = (
            tuple(surviving_thread_ids)
            if len(surviving_thread_ids) == len(items)
            and all(_ID.fullmatch(value) for value in surviving_thread_ids)
            else ()
        )
        result["coverage"] = {
            "operation": result["operation"],
            "mailbox": mailbox,
            "scope": "selected",
            "unit": "messages",
            "assessed": assessed,
            "returned": len(items),
            "matches_beyond_page": False,
            "items_omitted": items_omitted,
            "content_shortened": content_shortened,
            "content_depth": "message",
            "one_page_only": True,
        }
        return result

    def _message_item(
        self,
        payload: dict[str, Any],
        mailbox: str,
        *,
        with_body: bool = False,
        include_snippet: bool = False,
        include_attachments: bool = False,
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
        if mailbox == "sent" or (include_snippet and headers.get("to")):
            # Sent mail (and hybrid anywhere views) benefit from counterparty recipients.
            item["recipient"] = _recipient_label(headers.get("to", ""))
        if include_snippet:
            snippet = clean_snippet(payload.get("snippet"))
            if snippet:
                item["snippet"] = snippet
        if with_body:
            try:
                item["body"] = message_text(payload["payload"])
            except MessageTextError:
                raise GmailMetadataError("invalid_response") from None
            if include_attachments:
                files = attachment_filenames(payload["payload"])
                if files:
                    item["attachments"] = files
        return item
