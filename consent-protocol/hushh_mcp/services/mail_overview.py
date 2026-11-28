"""Mail Overview reads: recent mail, an explicit search, an exact open and a reply source.

This is a thin adapter over the owners that already exist. It adds no mail
subsystem: reads go through ``GmailMetadataReader``'s fenced session (one
grant, one account, a grant recheck either side of every provider call), and a
reply starts from ``gmail_reply_source_service`` exactly as One's own reply
tools do. What the browser could not do before is name *a message*. One's voice
and chat lists name rows by position inside an offer that the next list
replaces, and the reply reference expires after fifteen minutes by design.

Source identity
---------------
A row carries ``source_id``: ``ms1.`` plus an authenticated, opaque encryption
of ``(account, message id)`` bound to the owner. It is deterministic, so a row
keeps the same id across refreshes, reorders and searches, and it never
expires: it is an identity, not an authority. Using it still needs the
authenticated vault owner, an unrevoked grant and the same Google account, and
every use re-reads the message. A different account, a deleted message or a
tampered value fails; none of them falls back to another message. The browser
never holds a Gmail id.

Read-only: ``gmail.readonly`` and GET requests only. Opening a message does not
mark it read, label it, archive it or complete anything.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import hmac
import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.gmail_delivery_service import GmailDeliveryError
from hushh_mcp.services.gmail_message_text import (
    MessageTextError,
    cap_utf8,
    message_text,
)
from hushh_mcp.services.gmail_metadata_reader import (
    _FULL_FIELDS,
    _HEADERS,
    _ID,
    _MAILBOX_LABELS,
    _SNIPPET_FIELDS,
    GmailMetadataError,
    GmailMetadataReader,
    _extract_attachment_details,
    _label,
    _recipient_label,
    _validate_message,
    in_listing_order,
)
from hushh_mcp.services.gmail_receipts_service import GmailReceiptsService
from hushh_mcp.services.gmail_reply_source_service import (
    SOURCE_REF_TTL_SECONDS,
    read_reply_source,
    seal_reply_source_ref,
)
from hushh_mcp.services.gmail_semantic_ranker import clean_snippet

_PURPOSE = b"one-mail-overview-source-v1"
_REF_PREFIX = "ms1."
_REF_VERSION = 1
SOURCE_ID_PATTERN = r"^ms1\.[A-Za-z0-9_-]{16,2044}$"
_SOURCE_ID = re.compile(SOURCE_ID_PATTERN)

# Gmail's own page size for one provider list call is far larger; 25 matches the
# reader's metadata cap and what a phone can reasonably show. There is no
# continuation: refine the search to narrow it.
ROW_LIMIT = 25
DEFAULT_RECENT_ROWS = 5
PREVIEW_BYTES = 200
_QUERY_BYTES = 512

# The reader's own placeholders for a header that was absent. They are not mail
# content, so a row reports the field as missing instead of showing them.
# The brief reads a short, recent window: what is current, not an archive.
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

RECENT_SCOPE = {"kind": "recent", "mailbox": "inbox", "label": "Inbox"}
SEARCH_SCOPE = {
    "kind": "search",
    "mailbox": "all_mail",
    "label": "All mail (Spam and Trash excluded)",
}


class MailOverviewError(RuntimeError):
    """Authored, value-free failure. Never carries a provider payload or message text."""

    def __init__(self, code: str, message: str, status_code: int = 409) -> None:
        super().__init__(code)
        self.code = code
        self.message = message
        self.status_code = status_code


_READER_ERRORS: dict[str, tuple[str, str, int]] = {
    "connect_required": ("CONNECT_REQUIRED", "Connect your mail.", 409),
    "reconnect_required": ("RECONNECT_REQUIRED", "Reconnect your mail to continue.", 409),
    "connection_changed": (
        "CONNECTION_CHANGED",
        "Your mail connection changed. Try again.",
        409,
    ),
    "permission_denied": (
        "PERMISSION_DENIED",
        "Mail didn't allow that read. Reconnect your mail.",
        403,
    ),
    # A 404 on the message itself: it was deleted, or never belonged to this mailbox.
    "source_changed": ("SOURCE_CHANGED", "That email can't be found now.", 410),
    "response_too_large": ("RESPONSE_TOO_LARGE", "That email is too large to show here.", 413),
    "retryable": ("RETRYABLE", "Mail is temporarily unavailable. Try again.", 503),
    "invalid_argument": ("INVALID_REQUEST", "That request couldn't be used.", 400),
}


def reader_failure(exc: GmailMetadataError) -> MailOverviewError:
    code, message, status = _READER_ERRORS.get(
        exc.code, ("MAIL_UNAVAILABLE", "Mail couldn't be read. Try again.", 502)
    )
    return MailOverviewError(code, message, status)


# --- source identity ---------------------------------------------------------------


@dataclass(frozen=True)
class SourceRef:
    account: str
    message_id: str


def _signing_key() -> bytes:
    secret = get_core_security_settings().app_signing_key
    if not secret:
        raise MailOverviewError(
            "MAIL_UNAVAILABLE", "Mail couldn't be read. Try again.", status_code=503
        )
    return secret.encode("utf-8")


def _derive(info: bytes) -> bytes:
    return HKDF(algorithm=SHA256(), length=32, salt=None, info=info).derive(_signing_key())


def _aad(owner_user_id: str) -> bytes:
    return _PURPOSE + b":" + owner_user_id.encode("utf-8")


def seal_source_id(*, owner_user_id: str, account: str, message_id: str) -> str:
    """The stable, opaque identity of one message in one owner's one Google account.

    The nonce is a keyed hash of the plaintext (a synthetic IV), so equal inputs
    give equal ids while distinct inputs never share a nonce. Equality is the
    only thing this reveals, and only to a holder of both ids.
    """
    if not _ID.fullmatch(message_id) or not account or not owner_user_id:
        raise MailOverviewError("SOURCE_REF_INVALID", "That email can't be identified.", 422)
    payload = json.dumps(
        {"v": _REF_VERSION, "account": account, "message_id": message_id},
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    aad = _aad(owner_user_id)
    nonce = hmac.new(_derive(_PURPOSE + b":iv"), aad + b"\x00" + payload, hashlib.sha256).digest()[
        :12
    ]
    sealed = AESGCM(_derive(_PURPOSE)).encrypt(nonce, payload, aad)
    return _REF_PREFIX + base64.urlsafe_b64encode(nonce + sealed).decode("ascii").rstrip("=")


def open_source_id(token: str, *, owner_user_id: str) -> SourceRef:
    """Authenticate an id for this owner. Tampered, foreign or malformed ids fail closed."""
    invalid = MailOverviewError("SOURCE_REF_INVALID", "That email can't be identified.", 422)
    if not isinstance(token, str) or not _SOURCE_ID.fullmatch(token):
        raise invalid
    body = token[len(_REF_PREFIX) :]
    try:
        packed = base64.b64decode(body + "=" * (-len(body) % 4), altchars=b"-_", validate=True)
        if len(packed) < 12 + 16:
            raise ValueError("short")
        raw = AESGCM(_derive(_PURPOSE)).decrypt(packed[:12], packed[12:], _aad(owner_user_id))
        value = json.loads(raw)
    except (ValueError, TypeError, binascii.Error, InvalidTag):
        raise invalid from None
    if (
        not isinstance(value, dict)
        or value.get("v") != _REF_VERSION
        or not isinstance(value.get("account"), str)
        or not value["account"]
        or not isinstance(value.get("message_id"), str)
        or not _ID.fullmatch(value["message_id"])
    ):
        raise invalid
    return SourceRef(account=value["account"], message_id=value["message_id"])


# --- reads -------------------------------------------------------------------------


class OverviewMailReader(GmailMetadataReader):
    """The reader's fenced session, with one more read shaped for a persistent list."""

    brief_has_more: bool = False

    async def list_rows(self, *, query: str, limit: int) -> dict[str, Any]:
        """Newest-first metadata and a short preview for one page of Inbox or search.

        No query lists the Inbox. A query searches all mail except Spam and
        Trash. One provider page only: Gmail reports whether more matches exist,
        and this reader neither fetches them nor estimates a total.
        """
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= ROW_LIMIT:
            raise GmailMetadataError("invalid_argument")
        if (
            not isinstance(query, str)
            or len(query.encode("utf-8")) > _QUERY_BYTES
            or any(ord(char) < 32 for char in query)
        ):
            raise GmailMetadataError("invalid_argument")
        query = query.strip()
        label = _MAILBOX_LABELS["anywhere" if query else "inbox"]

        async def body(client: Any, token: str) -> dict[str, Any]:
            params: dict[str, Any] = {
                "maxResults": limit,
                "includeSpamTrash": "false",
                "fields": "messages(id,threadId),nextPageToken",
            }
            if label is not None:
                params["labelIds"] = label
            if query:
                params["q"] = query
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
            request = {
                "format": "metadata",
                "metadataHeaders": _HEADERS,
                "fields": _SNIPPET_FIELDS,
            }

            async def fetch(identity: str) -> dict[str, Any]:
                payload: dict[str, Any] = await self._get(
                    client, token, f"/messages/{identity}", request, recheck=False
                )
                if payload.get("id") != identity:
                    raise GmailMetadataError("invalid_response")
                _validate_message(payload, max_headers=16)
                return payload

            await self.require_current()
            # No best-effort swallowing: an unreadable message is not an absent one.
            payloads = await in_listing_order(ids, fetch)
            await self.require_current()
            return {
                "rows": [self._overview_row(payload) for payload in payloads],
                "more_available": bool(listing.get("nextPageToken")),
            }

        result: dict[str, Any] = await self._session(body, reads_bodies=False)
        return result

    def _overview_row(self, payload: dict[str, Any]) -> dict[str, Any]:
        headers = self._gmail._extract_headers(payload)
        name, address = self._gmail._parse_from_header(headers.get("from", ""))
        received = self._gmail._message_received_at(payload, headers)
        subject, _ = _label(headers.get("subject"), 320)
        sender, _ = _label(name or address, 160)
        return {
            "message_id": str(payload["id"]),
            "subject": subject or None,
            "sender": sender or None,
            "preview": clean_snippet(payload.get("snippet"), max_bytes=PREVIEW_BYTES) or None,
            "received_at": received.isoformat() if received else None,
            "unread": "UNREAD" in payload.get("labelIds", []),
        }

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
            self.brief_has_more = bool(listing.get("nextPageToken"))
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
        details = _extract_attachment_details(payload.get("payload"))
        return {
            "message_id": str(payload["id"]),
            "thread_id": str(payload.get("threadId") or ""),
            "direction": "sent" if "SENT" in labels else "received",
            "from_name": _label(name, 160)[0] or None,
            "from_address": (address or "").strip().lower() or None,
            "to": _recipient_label(headers.get("to", "")) or None,
            "subject": _field(subject, _NO_SUBJECT),
            "received_at": received.isoformat(),
            "unread": "UNREAD" in labels,
            "text": text,
            "text_cut": text_cut,
            "attachments": [
                _label(item["filename"], _ATTACHMENT_NAME_BYTES)[0] for item in details[:5]
            ],
        }

    async def sent_proofs(self, message_ids: list[str]) -> list[dict[str, Any]]:
        """Which of these Gmail ids are real sent messages in this connected mailbox.

        A message that is missing here (another account's, or deleted) is left
        out, never guessed at. A draft, or anything without the SENT label, is
        not a sent message.
        """
        if not message_ids or len(message_ids) > 10:
            raise GmailMetadataError("invalid_argument")
        if any(not isinstance(value, str) or not _ID.fullmatch(value) for value in message_ids):
            raise GmailMetadataError("invalid_argument")

        async def body(client: Any, token: str) -> list[dict[str, Any]]:
            request = {"format": "full", "fields": _FULL_FIELDS}

            async def fetch(identity: str) -> dict[str, Any]:
                try:
                    payload: dict[str, Any] = await self._get(
                        client, token, f"/messages/{identity}", request, recheck=False
                    )
                except GmailMetadataError as exc:
                    if exc.code == "source_changed":
                        return {"_missing": True}
                    raise
                if payload.get("id") != identity:
                    raise GmailMetadataError("invalid_response")
                _validate_message(payload, max_headers=400)
                return payload

            await self.require_current()
            payloads = await in_listing_order(list(message_ids), fetch)
            await self.require_current()
            proofs: list[dict[str, Any]] = []
            for payload in payloads:
                if payload.get("_missing"):
                    continue
                labels = payload.get("labelIds") or []
                if "SENT" not in labels or "DRAFT" in labels:
                    continue
                headers = self._gmail._extract_headers(payload)
                sent_at = self._gmail._message_received_at(payload, headers)
                if sent_at is None:
                    continue
                subject, _ = _label(headers.get("subject"), 320)
                details = _extract_attachment_details(payload.get("payload"))
                proofs.append(
                    {
                        "message_id": str(payload["id"]),
                        "thread_id": str(payload.get("threadId") or ""),
                        "subject": _field(subject, _NO_SUBJECT),
                        "to": _recipient_label(headers.get("to", "")) or None,
                        "sent_at": sent_at.isoformat(),
                        "attachments": [
                            _label(item["filename"], _ATTACHMENT_NAME_BYTES)[0]
                            for item in details[:5]
                        ],
                    }
                )
            return proofs

        result: list[dict[str, Any]] = await self._session(body, reads_bodies=True)
        return result


RequireAccess = Callable[[], Awaitable[None]]
ReaderFactory = Callable[..., OverviewMailReader]


def reads_admitted(user_id: str) -> bool:
    """Owner-authorized Mail reads, the same admission One's typed Chat reads use."""
    return bool(connector_feature_enabled("gmail_chat_reads", user_id))


async def _connection_gate(
    gmail: GmailReceiptsService, user_id: str, expected_account: str | None
) -> str:
    """The connected account, or the precise reason there is none.

    Checked before any provider call, so a row that was listed under one account
    can never be answered from another: an account is compared, never assumed.
    """
    row = await asyncio.to_thread(gmail._fetch_connection_row, user_id=user_id)
    if not row or row.get("status") == "disconnected":
        raise MailOverviewError("CONNECT_REQUIRED", "Connect your mail.", 409)
    if row.get("status") != "connected" or row.get("revoked"):
        raise MailOverviewError("RECONNECT_REQUIRED", "Reconnect your mail to continue.", 409)
    account = str(row.get("google_sub") or "")
    if not account:
        raise MailOverviewError("RECONNECT_REQUIRED", "Reconnect your mail to continue.", 409)
    if expected_account and expected_account != account:
        raise MailOverviewError(
            "ACCOUNT_CHANGED", "Your mail account changed. Refresh to see the new one.", 409
        )
    return account


def _reads_access(user_id: str) -> RequireAccess:
    async def require() -> None:
        if not reads_admitted(user_id):
            raise PermissionError("Mail reads are unavailable")

    return require


def _require_reads(user_id: str) -> None:
    if not reads_admitted(user_id):
        raise MailOverviewError(
            "MAIL_READS_UNAVAILABLE", "Mail isn't available for this account.", 403
        )


def _row_view(row: dict[str, Any], *, owner_user_id: str, account: str) -> dict[str, Any]:
    return {
        "source_id": seal_source_id(
            owner_user_id=owner_user_id, account=account, message_id=row["message_id"]
        ),
        "subject": row["subject"],
        "sender": row["sender"],
        "preview": row["preview"],
        "received_at": row["received_at"],
        "unread": row["unread"],
    }


async def list_messages(
    *,
    gmail: GmailReceiptsService,
    user_id: str,
    query: str,
    limit: int,
    expected_account: str | None,
    reader_factory: ReaderFactory = OverviewMailReader,
) -> dict[str, Any]:
    """Recent Inbox mail (empty ``query``) or one explicit search, newest first."""
    _require_reads(user_id)
    await _connection_gate(gmail, user_id, expected_account)
    reader = reader_factory(
        gmail=gmail,
        user_id=user_id,
        require_access=_reads_access(user_id),
        expect_account=expected_account or None,
    )
    try:
        page = await reader.list_rows(query=query, limit=limit)
    except PermissionError:
        raise MailOverviewError(
            "MAIL_READS_UNAVAILABLE", "Mail isn't available for this account.", 403
        ) from None
    except GmailMetadataError as exc:
        raise reader_failure(exc) from None
    account = reader.account
    items = [_row_view(row, owner_user_id=user_id, account=account) for row in page["rows"]]
    scope = dict(SEARCH_SCOPE if query.strip() else RECENT_SCOPE)
    return {
        "account": account,
        "scope": scope,
        "items": items,
        # What the provider reported for this one page, and nothing more. There is
        # no total, no continuation and no claim that this is all mail.
        "coverage": {
            "requested": limit,
            "returned": len(items),
            "more_available": bool(page["more_available"]),
            "cap": ROW_LIMIT,
        },
    }


async def _resolve(
    *,
    gmail: GmailReceiptsService,
    user_id: str,
    source_id: str,
    expected_account: str | None,
) -> SourceRef:
    ref = open_source_id(source_id, owner_user_id=user_id)
    # The id names the account its message lived in. If the browser's own idea
    # of the account differs, or the connection is now another one, refuse
    # before reading anything.
    if expected_account and expected_account != ref.account:
        raise MailOverviewError(
            "ACCOUNT_CHANGED", "Your mail account changed. Refresh to see the new one.", 409
        )
    account = await _connection_gate(gmail, user_id, ref.account)
    return SourceRef(account=account, message_id=ref.message_id)


def _field(value: Any, placeholder: str) -> str | None:
    text = value.strip() if isinstance(value, str) else ""
    return None if not text or text == placeholder else text


async def open_message(
    *,
    gmail: GmailReceiptsService,
    user_id: str,
    source_id: str,
    expected_account: str | None,
    reader_factory: ReaderFactory = OverviewMailReader,
) -> dict[str, Any]:
    """The exact message this id names, as safe text. Never a different message."""
    _require_reads(user_id)
    ref = await _resolve(
        gmail=gmail, user_id=user_id, source_id=source_id, expected_account=expected_account
    )
    reader = reader_factory(
        gmail=gmail,
        user_id=user_id,
        require_access=_reads_access(user_id),
        expect_account=ref.account,
    )
    try:
        result = await reader.read(
            "read_message_by_id", {"message_ids": [ref.message_id], "mailbox": "anywhere"}
        )
    except PermissionError:
        raise MailOverviewError(
            "MAIL_READS_UNAVAILABLE", "Mail isn't available for this account.", 403
        ) from None
    except GmailMetadataError as exc:
        raise reader_failure(exc) from None
    items = result.get("untrusted_external_content") or []
    if len(items) != 1:
        raise MailOverviewError("SOURCE_CHANGED", "That email can't be found now.", 410)
    item = items[0]
    return {
        "account": reader.account,
        "message": {
            "source_id": source_id,
            "subject": _field(item.get("subject"), _NO_SUBJECT),
            "sender": _field(item.get("sender"), _NO_SENDER),
            "received_at": item.get("received_at"),
            "unread": bool(item.get("unread")),
            "body": item.get("body") if isinstance(item.get("body"), str) else "",
            "body_truncated": item.get("body_truncated") is True,
        },
    }


def replies_admitted() -> bool:
    """A reply re-reads the original, so both voice mail switches gate it, as at send."""
    from hushh_mcp.one_voice.config import voice_mail_reads_enabled, voice_mail_reply_enabled

    return voice_mail_reply_enabled() and voice_mail_reads_enabled()


async def prepare_reply(
    *,
    gmail: GmailReceiptsService,
    user_id: str,
    source_id: str,
    expected_account: str | None,
    reader_factory: Callable[..., GmailMetadataReader] = GmailMetadataReader,
) -> dict[str, Any]:
    """A fresh, short-lived reply reference for the exact message this id names.

    The recipient, subject and thread are derived from the message by the same
    service the delivery routes use on every prepare and send; the browser
    supplies only the body. A message that cannot be replied to says why.
    """
    _require_reads(user_id)
    if not replies_admitted():
        raise MailOverviewError("MAIL_REPLY_UNAVAILABLE", "Replying from One is switched off.", 403)
    ref = await _resolve(
        gmail=gmail, user_id=user_id, source_id=source_id, expected_account=expected_account
    )

    async def require_access() -> None:
        if not replies_admitted() or not reads_admitted(user_id):
            raise PermissionError("Mail replies are disabled")

    try:
        source = await read_reply_source(
            gmail=gmail,
            user_id=user_id,
            message_id=ref.message_id,
            expected_account=ref.account,
            require_access=require_access,
            reader_factory=reader_factory,
        )
    except GmailDeliveryError as exc:
        raise MailOverviewError(exc.code, exc.message, exc.status_code) from None
    return {
        "account": ref.account,
        "reply": {
            "source_mail_ref": seal_reply_source_ref(source, owner_user_id=user_id),
            "to": source.recipient_email,
            "recipient_label": source.recipient_display,
            "subject": source.subject,
            "expires_in_seconds": SOURCE_REF_TTL_SECONDS,
        },
    }
