"""A reply in an email's own Gmail thread, derived from the message itself.

The personal-information-request lane can reply only to its own workflow
source. This is the general boundary behind One Voice's ``reply_mail``: given a
message id the server itself offered, it re-reads that message's routing
headers with the owner's Gmail READ grant and derives, server-side, everything a
threaded reply is addressed by -- the recipient (``Reply-To``, else ``From``),
the ``Re:`` subject, and the ``threadId`` / ``In-Reply-To`` / ``References``
binding. Nothing here sends: ``GmailDeliveryService`` stays the only sender and
is handed the same ``GmailReplyContext`` the personal-information lane uses.

The browser carries a reply as an opaque ``source_mail_ref``: owner-, account-
and source-bound, short-lived, authenticated with AES-GCM. It names a message
and the fingerprint of its routing headers, never an envelope. Every use opens
it, re-reads the message, and derives the envelope again, so neither a browser
nor a model can retarget a reviewed reply to another message, recipient or
thread.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import hmac
import json
import re
import secrets
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from email.utils import getaddresses
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services.gmail_delivery_service import (
    GmailDeliveryError,
    GmailReplyContext,
    normalize_draft,
)
from hushh_mcp.services.gmail_metadata_reader import GmailMetadataError, GmailMetadataReader
from hushh_mcp.services.gmail_receipts_service import GmailReceiptsService

_PURPOSE = b"one-gmail-reply-source-v1"
_REF_PREFIX = "rs1."
_REF_VERSION = 1
# Long enough to read a reply over and edit it, short enough that a leaked ref
# is not a standing capability. Every use re-reads the message anyway.
SOURCE_REF_TTL_SECONDS = 15 * 60
MAX_SOURCE_REF_CHARS = 2048
SOURCE_REF_PATTERN = r"^rs1\.[A-Za-z0-9_-]{16,2044}$"
_ID = re.compile(r"[A-Za-z0-9_-]{1,200}\Z")
# RFC 5322 msg-id: printable ASCII only, so no Unicode line separator or
# control character can reach a header the SMTP policy would refuse at send.
_MESSAGE_ID = re.compile(r"<[!-;=?-~]{1,995}>")
_MAX_HEADER_CHARS = 2000
# A deep thread's References line is trimmed, never refused: the first id
# (the thread root) and the newest ids are what threading clients read. The raw
# bound only keeps parsing linear; the reader's response budget caps it anyway.
_MAX_REFERENCES_CHARS = 1800
_MAX_RAW_REFERENCES_CHARS = 64_000
_MAX_NAME_CHARS = 200
_MAX_SUBJECT_CHARS = 256
# Labels a reply is never prepared against in this release. A message in Trash
# or Spam was put there by the owner or by a filter; a draft is not a message
# anyone sent.
_UNREPLYABLE_LABELS = frozenset({"TRASH", "SPAM", "DRAFT"})

RequireAccess = Callable[[], Awaitable[None]]


def _error(code: str, message: str, status_code: int = 409) -> GmailDeliveryError:
    return GmailDeliveryError(code, message, status_code=status_code)


# Codes the voice tool maps onto spoken wording and the delivery routes return
# as HTTP errors. Authored text only: no provider payload is ever reflected.
SOURCE_UNAVAILABLE = "REPLY_SOURCE_UNAVAILABLE"
SOURCE_CHANGED = "REPLY_SOURCE_CHANGED"
ACCOUNT_CHANGED = "REPLY_ACCOUNT_CHANGED"
TARGET_AMBIGUOUS = "REPLY_TARGET_AMBIGUOUS"
TARGET_IS_OWNER = "REPLY_TARGET_IS_OWNER"
RECIPIENT_INVALID = "REPLY_RECIPIENT_INVALID"
HEADERS_INVALID = "REPLY_HEADERS_INVALID"
REF_INVALID = "REPLY_SOURCE_REF_INVALID"
REF_EXPIRED = "REPLY_SOURCE_REF_EXPIRED"
NOT_CONNECTED = "GMAIL_NOT_CONNECTED"
RECONNECT_REQUIRED = "GMAIL_READ_PERMISSION_REQUIRED"
RETRYABLE = "REPLY_SOURCE_RETRYABLE"
# The caller's admission check withdrew the reply mid-read (its switch was
# turned off, or Mail reads were withdrawn). Nothing fetched is used.
UNAVAILABLE = "MAIL_REPLY_UNAVAILABLE"


@dataclass(frozen=True)
class GmailReplySource:
    """Server-only. Never handed whole to a model, a log line, or a browser."""

    account: str
    message_id: str
    thread_id: str
    recipient_email: str
    recipient_display: str
    subject: str
    reply_context: GmailReplyContext
    fingerprint: str


@dataclass(frozen=True)
class ReplySourceRef:
    account: str
    message_id: str
    thread_id: str
    fingerprint: str
    expires_at: int


def _signing_key() -> bytes:
    secret = get_core_security_settings().app_signing_key
    if not secret:
        raise ValueError("reply source key is unavailable")
    return secret.encode("utf-8")


def _aead_key() -> bytes:
    return HKDF(algorithm=SHA256(), length=32, salt=None, info=_PURPOSE).derive(_signing_key())


def _header_map(message: dict[str, Any]) -> dict[str, str]:
    """First value per header, by lowercase name. Values are already validated strings."""
    headers: dict[str, str] = {}
    for item in message.get("payload", {}).get("headers", []):
        name = str(item.get("name") or "").strip().lower()
        if name and name not in headers:
            headers[name] = str(item.get("value") or "").strip()
    return headers


def _safe_header(value: str) -> str:
    if "\r" in value or "\n" in value or len(value) > _MAX_HEADER_CHARS:
        raise _error(HEADERS_INVALID, "That email's reply details can't be used.")
    return value


def _fingerprint(*, account: str, message_id: str, thread_id: str, headers: dict[str, str]) -> str:
    """Routing-relevant fields only. Labels are left out on purpose: archiving or
    reading a message must not void a reply to it, and Trash/Spam are refused on
    every read instead."""
    canonical = json.dumps(
        {
            "account": account,
            "message_id": message_id,
            "thread_id": thread_id,
            "reply_to": headers.get("reply-to", ""),
            "from": headers.get("from", ""),
            "subject": headers.get("subject", ""),
            "rfc_message_id": headers.get("message-id", ""),
            "references": headers.get("references", ""),
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    return hmac.new(
        _signing_key(), _PURPOSE + b":" + canonical.encode("utf-8"), hashlib.sha256
    ).hexdigest()


def _display_name(name: str, address: str) -> str:
    cleaned = " ".join("".join(ch for ch in name if ch.isprintable()).split())
    return cleaned[:_MAX_NAME_CHARS] or address


def _reply_subject(original: str) -> str:
    # ``split()`` also folds Unicode line separators (U+2028, U+0085, VT),
    # which the SMTP header policy refuses only at send time.
    original = " ".join("".join(ch for ch in original if ch.isprintable() or ch.isspace()).split())
    if original.lower().startswith("re:"):
        return original[:_MAX_SUBJECT_CHARS]
    if not original:
        return "Re:"
    return "Re: " + original[: _MAX_SUBJECT_CHARS - 4]


def _thread_headers(headers: dict[str, str]) -> tuple[str | None, str | None]:
    """``In-Reply-To`` and a bounded ``References`` chain ending in it.

    A malformed ``Message-ID`` is dropped rather than refused: Gmail threads by
    ``threadId``, and a value that is not one angle-bracketed id would only
    confuse other clients. Newlines anywhere are refused (header injection). A
    long chain keeps its root and the newest ids that fit, in one pass.
    """
    raw_message_id = _safe_header(headers.get("message-id", ""))
    raw_references = headers.get("references", "")
    if (
        "\r" in raw_references
        or "\n" in raw_references
        or len(raw_references) > _MAX_RAW_REFERENCES_CHARS
    ):
        raise _error(HEADERS_INVALID, "That email's reply details can't be used.")
    match = _MESSAGE_ID.fullmatch(raw_message_id.strip()) if raw_message_id else None
    in_reply_to = match.group(0) if match else None
    chain = _MESSAGE_ID.findall(raw_references)
    if in_reply_to and (not chain or chain[-1] != in_reply_to):
        chain.append(in_reply_to)
    if not chain:
        return in_reply_to, None
    newest = chain[-1]
    if len(chain) == 1 or len(chain[0]) + 1 + len(newest) > _MAX_REFERENCES_CHARS:
        # The direct parent outranks the root when both cannot fit.
        return in_reply_to, newest
    kept = [newest]
    size = len(chain[0]) + 1 + len(newest)
    for item in reversed(chain[1:-1]):
        if size + 1 + len(item) > _MAX_REFERENCES_CHARS:
            break
        kept.append(item)
        size += 1 + len(item)
    return in_reply_to, " ".join([chain[0], *reversed(kept)])


_GMAIL_DOMAINS = frozenset({"gmail.com", "googlemail.com"})


def _mailbox_key(address: str) -> str:
    """One key per Gmail mailbox: dots and a +tag in the local part reach the same inbox."""
    local, _, domain = address.strip().lower().rpartition("@")
    if domain in _GMAIL_DOMAINS:
        return local.split("+", 1)[0].replace(".", "") + "@gmail.com"
    return f"{local}@{domain}"


def _recipient(headers: dict[str, str], *, owner_email: str) -> tuple[str, str]:
    """``Reply-To`` wins; ``From`` otherwise. One address, never the owner's own.

    A ``Reply-To`` that is present but unusable is refused rather than skipped:
    falling through to ``From`` would send the reply somewhere its author did
    not ask for. A message the owner sent has their own address as ``From``,
    and replying to it would address them, not the person they wrote to.
    """
    reply_to = _safe_header(headers.get("reply-to", ""))
    sender = _safe_header(headers.get("from", ""))
    raw = reply_to or sender
    parsed = [(name, address.strip().lower()) for name, address in getaddresses([raw]) if address]
    if not parsed:
        raise _error(RECIPIENT_INVALID, "That email has no reply address.", status_code=422)
    try:
        normalized = normalize_draft({"to": raw, "subject": "", "body": ""}).to
    except GmailDeliveryError:
        raise _error(
            RECIPIENT_INVALID, "That email has no usable reply address.", status_code=422
        ) from None
    if len(normalized) != 1:
        raise _error(
            TARGET_AMBIGUOUS, "That email names more than one reply address.", status_code=422
        )
    address = normalized[0]
    owner = _mailbox_key(owner_email) if owner_email else ""
    senders = {_mailbox_key(value) for _name, value in getaddresses([sender]) if value}
    if owner and (_mailbox_key(address) == owner or owner in senders):
        raise _error(
            TARGET_IS_OWNER,
            "That email is from you, so its reply would come back to you.",
            status_code=422,
        )
    name = next((name for name, value in parsed if value == address), "")
    return address, _display_name(name, address)


def reply_source_from_message(
    message: dict[str, Any], *, account: str, owner_email: str
) -> GmailReplySource:
    """Derive the reply envelope from one validated provider message."""
    message_id = str(message.get("id") or "")
    thread_id = str(message.get("threadId") or "")
    if not _ID.fullmatch(message_id) or not _ID.fullmatch(thread_id) or not account:
        raise _error(SOURCE_UNAVAILABLE, "That email can't be found now.")
    labels = {label for label in message.get("labelIds", []) if isinstance(label, str)}
    if labels & _UNREPLYABLE_LABELS:
        raise _error(SOURCE_UNAVAILABLE, "That email can't be replied to from here.")
    if "SENT" in labels:
        # The owner sent it, from any of their addresses: a reply would be
        # addressed back to them, or to whoever their own Reply-To named.
        raise _error(
            TARGET_IS_OWNER,
            "That email is from you, so its reply would come back to you.",
            status_code=422,
        )
    headers = _header_map(message)
    recipient_email, recipient_display = _recipient(headers, owner_email=owner_email.lower())
    subject = _reply_subject(_safe_header(headers.get("subject", "")))
    in_reply_to, references = _thread_headers(headers)
    return GmailReplySource(
        account=account,
        message_id=message_id,
        thread_id=thread_id,
        recipient_email=recipient_email,
        recipient_display=recipient_display,
        subject=subject,
        reply_context=GmailReplyContext(
            thread_id=thread_id, in_reply_to=in_reply_to, references=references
        ),
        fingerprint=_fingerprint(
            account=account, message_id=message_id, thread_id=thread_id, headers=headers
        ),
    )


_READER_ERRORS: dict[str, tuple[str, str]] = {
    "connect_required": (NOT_CONNECTED, "Connect Mail before replying."),
    "reconnect_required": (RECONNECT_REQUIRED, "Reconnect Mail before replying."),
    "permission_denied": (RECONNECT_REQUIRED, "Mail didn't allow reading that email."),
    # The fence's own check already caught a different account before the read;
    # here it is a token refresh or grant re-check racing this read: retryable.
    "connection_changed": (RETRYABLE, "Your Mail connection changed while I was checking."),
    "source_changed": (SOURCE_UNAVAILABLE, "That email can't be found now."),
}


async def read_reply_source(
    *,
    gmail: GmailReceiptsService,
    user_id: str,
    message_id: str,
    expected_account: str,
    require_access: RequireAccess,
    reader_factory: Callable[..., GmailMetadataReader] = GmailMetadataReader,
) -> GmailReplySource:
    """Re-read one offered message and derive its reply, in the account it came from.

    The account is compared before any fetch: an id offered in one mailbox is
    meaningless in another, and "the second one" must never turn into a message
    that now holds that position somewhere else.
    """
    if not expected_account:
        raise _error(SOURCE_UNAVAILABLE, "That email can't be found now.")
    row = await _connection_row(gmail, user_id)
    if not row or row.get("status") != "connected" or row.get("revoked"):
        raise _error(NOT_CONNECTED, "Connect Mail before replying.")
    if str(row.get("google_sub") or "") != expected_account:
        raise _error(ACCOUNT_CHANGED, "That email belongs to a different Mail connection now.")
    owner_email = str(row.get("google_email") or "").strip().lower()
    if not owner_email:
        # Without it the self-reply guard cannot run; refuse rather than guess.
        raise _error(RECONNECT_REQUIRED, "Reconnect Mail before replying.")
    reader = reader_factory(
        gmail=gmail,
        user_id=user_id,
        require_access=require_access,
        expect_account=expected_account,
    )
    try:
        message = await reader.reply_source(message_id)
    except PermissionError:
        raise _error(UNAVAILABLE, "Replying from One is switched off.", status_code=403) from None
    except GmailMetadataError as exc:
        code, text = _READER_ERRORS.get(exc.code, (RETRYABLE, "I couldn't check that email."))
        raise _error(code, text, status_code=503 if code == RETRYABLE else 409) from None
    return reply_source_from_message(message, account=expected_account, owner_email=owner_email)


async def _connection_row(gmail: GmailReceiptsService, user_id: str) -> dict[str, Any] | None:
    row: dict[str, Any] | None = await asyncio.to_thread(
        gmail._fetch_connection_row, user_id=user_id
    )
    return row


def seal_reply_source_ref(
    source: GmailReplySource, *, owner_user_id: str, now: float | None = None
) -> str:
    """An opaque, owner-bound reference to the source -- never its envelope."""
    issued = int(time.time() if now is None else now)
    payload = json.dumps(
        {
            "v": _REF_VERSION,
            "owner": owner_user_id,
            "account": source.account,
            "message_id": source.message_id,
            "thread_id": source.thread_id,
            "fingerprint": source.fingerprint,
            "iat": issued,
            "exp": issued + SOURCE_REF_TTL_SECONDS,
        },
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    nonce = secrets.token_bytes(12)
    sealed = AESGCM(_aead_key()).encrypt(nonce, payload, _PURPOSE + b":" + owner_user_id.encode())
    return _REF_PREFIX + base64.urlsafe_b64encode(nonce + sealed).decode("ascii").rstrip("=")


def open_reply_source_ref(
    token: str,
    *,
    owner_user_id: str,
    now: float | None = None,
    allow_expired: bool = False,
) -> ReplySourceRef:
    """Authenticate a reference for this owner. Tampered, foreign or old ones fail closed.

    ``allow_expired`` only skips the clock, for reading back which thread a
    settled reply was bound to; authentication and owner binding still apply.
    """
    if (
        not isinstance(token, str)
        or not token.startswith(_REF_PREFIX)
        or len(token) > MAX_SOURCE_REF_CHARS
    ):
        raise _error(REF_INVALID, "This reply can't be verified. Ask One to prepare it again.")
    body = token[len(_REF_PREFIX) :]
    try:
        packed = base64.b64decode(body + "=" * (-len(body) % 4), altchars=b"-_", validate=True)
        if len(packed) < 12 + 16:
            raise ValueError("short")
        raw = AESGCM(_aead_key()).decrypt(
            packed[:12], packed[12:], _PURPOSE + b":" + owner_user_id.encode()
        )
        value = json.loads(raw)
    except (ValueError, TypeError, binascii.Error, InvalidTag):
        raise _error(
            REF_INVALID, "This reply can't be verified. Ask One to prepare it again."
        ) from None
    if (
        not isinstance(value, dict)
        or value.get("v") != _REF_VERSION
        or value.get("owner") != owner_user_id
        or not all(
            isinstance(value.get(key), str) and value.get(key)
            for key in ("account", "message_id", "thread_id", "fingerprint")
        )
        or type(value.get("exp")) is not int
    ):
        raise _error(REF_INVALID, "This reply can't be verified. Ask One to prepare it again.")
    current = int(time.time() if now is None else now)
    if not allow_expired and current > value["exp"]:
        raise _error(REF_EXPIRED, "This reply expired. Ask One to prepare it again.")
    return ReplySourceRef(
        account=value["account"],
        message_id=value["message_id"],
        thread_id=value["thread_id"],
        fingerprint=value["fingerprint"],
        expires_at=value["exp"],
    )


async def verified_reply_source(
    *,
    gmail: GmailReceiptsService,
    user_id: str,
    ref: ReplySourceRef,
    require_access: RequireAccess,
    reader_factory: Callable[..., GmailMetadataReader] = GmailMetadataReader,
) -> GmailReplySource:
    """Re-read the referenced message and require it to be the one that was reviewed."""
    source = await read_reply_source(
        gmail=gmail,
        user_id=user_id,
        message_id=ref.message_id,
        expected_account=ref.account,
        require_access=require_access,
        reader_factory=reader_factory,
    )
    if source.thread_id != ref.thread_id or not hmac.compare_digest(
        source.fingerprint, ref.fingerprint
    ):
        raise _error(SOURCE_CHANGED, "That email changed. Review the reply again.")
    return source


async def resolve_source_bound_reply(
    *,
    gmail: GmailReceiptsService,
    user_id: str,
    source_mail_ref: str,
    body: str,
    html_body: str | None,
    require_access: RequireAccess,
    reader_factory: Callable[..., GmailMetadataReader] = GmailMetadataReader,
) -> tuple[dict[str, Any], GmailReplyContext]:
    """The delivery routes' bridge to a general reply, like the KYC lane's.

    Only the body is the browser's: recipient, Cc, Bcc, subject and every thread
    header are re-derived here on each prepare and each send, so the envelope
    HMAC binds what the source says now.
    """
    ref = open_reply_source_ref(source_mail_ref, owner_user_id=user_id)
    source = await verified_reply_source(
        gmail=gmail,
        user_id=user_id,
        ref=ref,
        require_access=require_access,
        reader_factory=reader_factory,
    )
    return (
        {
            "to": [source.recipient_email],
            "cc": [],
            "bcc": [],
            "subject": source.subject,
            "body": body,
            "html_body": html_body,
        },
        source.reply_context,
    )


def reply_target_key(*, owner_user_id: str, account: str, message_id: str) -> str:
    """A stable, non-reversible name for "this message", for duplicate detection."""
    return hmac.new(
        _signing_key(),
        _PURPOSE + b":target:" + f"{owner_user_id}:{account}:{message_id}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()[:32]
