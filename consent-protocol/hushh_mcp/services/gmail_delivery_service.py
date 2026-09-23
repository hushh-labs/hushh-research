"""Owner-approved delivery through the canonical Gmail receipts connection.

This service intentionally stores only action metadata and HMACs.  It never
creates Gmail-native drafts, never persists an email envelope, and never
accepts a sender address or a caller-provided OAuth token.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import getaddresses
from typing import Any

import httpx
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from db.connection import get_pool
from hushh_mcp.agents.email.runtime import EMAIL_DRAFT_SCHEMA, run_email_gene
from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services.gmail_owner_html import sanitize_gmail_owner_html
from hushh_mcp.services.gmail_receipts_service import (
    GmailApiError,
    GmailReceiptsService,
    get_gmail_receipts_service,
)
from hushh_mcp.services.google_connection_service import GoogleConnectionError
from hushh_mcp.services.google_drive_blob_attachment_service import (
    MAX_BLOB_BYTES,
    DriveBlobDescriptor,
    GoogleDriveBlobAttachmentService,
)

logger = logging.getLogger(__name__)

_GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
_MAX_RECIPIENTS = 50
_MAX_SUBJECT_CHARS = 256
_MAX_BODY_CHARS = 50_000
_ACTION_TTL_SECONDS = 10 * 60
_EMAIL_RE = re.compile(r"^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$")
_CRLF_RE = re.compile(r"[\r\n]")

_EMAIL_AGENT_INTRO_PHRASES = (
    "explain features of the email agent",
    "demonstrate the core features of the gmail agent",
)
_EMAIL_AGENT_INTRO_BODY = """Hi,

## Meet your Hushh Email Agent

Thanks for giving it a try. Here’s what I can help with:

- **Draft polished emails** from a short request
- **Keep recipients organised** across To, Cc, and Bcc
- **Surface useful Gmail context** for receipts and inbox questions
- **Keep you in control** — every message stays editable until you choose Send

You can ask One to write, refine, or explain an email whenever you need it.

Best,
Hushh"""


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _text(value: Any) -> str:
    return str(value or "").strip()


def _is_email_agent_intro_instruction(instruction: str) -> bool:
    normalized = " ".join(instruction.lower().split())
    return any(phrase in normalized for phrase in _EMAIL_AGENT_INTRO_PHRASES)


@dataclass(frozen=True)
class GmailDeliveryError(RuntimeError):
    code: str
    message: str
    status_code: int = 400

    def __str__(self) -> str:
        return self.message


@dataclass(frozen=True)
class NormalizedEmailDraft:
    to: tuple[str, ...]
    cc: tuple[str, ...]
    bcc: tuple[str, ...]
    subject: str
    body: str
    html_body: str | None = None

    @property
    def recipient_count(self) -> int:
        return len(self.to) + len(self.cc) + len(self.bcc)

    def canonical_json(self) -> str:
        return json.dumps(
            {
                "to": self.to,
                "cc": self.cc,
                "bcc": self.bcc,
                "subject": self.subject,
                "body": self.body,
                "html_body": self.html_body or "",
            },
            separators=(",", ":"),
            sort_keys=True,
        )


@dataclass(frozen=True)
class GmailReplyContext:
    """Server-derived Gmail thread binding for an owner-approved reply."""

    thread_id: str
    in_reply_to: str | None = None
    references: str | None = None

    def canonical_json(self) -> str:
        return json.dumps(
            {
                "thread_id": self.thread_id,
                "in_reply_to": self.in_reply_to or "",
                "references": self.references or "",
            },
            separators=(",", ":"),
            sort_keys=True,
        )


def _normalize_recipients(value: Any, *, field_name: str) -> tuple[str, ...]:
    if value is None:
        return ()
    values = (
        [value]
        if isinstance(value, str)
        else list(value)
        if isinstance(value, list | tuple)
        else None
    )
    if values is None or any(not isinstance(item, str) for item in values):
        raise GmailDeliveryError(
            "INVALID_RECIPIENTS", f"{field_name} must be a list of email addresses."
        )
    raw = ",".join(values)
    if not raw.strip():
        return ()
    if _CRLF_RE.search(raw):
        raise GmailDeliveryError("INVALID_RECIPIENTS", "Recipient headers cannot contain newlines.")
    parsed = getaddresses([raw])
    normalized: list[str] = []
    for _name, address in parsed:
        address = address.strip().lower()
        if not address or not _EMAIL_RE.fullmatch(address):
            raise GmailDeliveryError(
                "INVALID_RECIPIENTS", f"{field_name} contains an invalid email address."
            )
        if address not in normalized:
            normalized.append(address)
    return tuple(normalized)


def normalize_draft(payload: dict[str, Any]) -> NormalizedEmailDraft:
    """Validate the exact envelope which the owner reviews and confirms."""

    to = _normalize_recipients(payload.get("to"), field_name="To")
    cc = _normalize_recipients(payload.get("cc"), field_name="Cc")
    bcc = _normalize_recipients(payload.get("bcc"), field_name="Bcc")
    # Preserve recipient role precedence and prevent accidental duplicate sends.
    cc = tuple(address for address in cc if address not in to)
    bcc = tuple(address for address in bcc if address not in to and address not in cc)
    if not (to or cc or bcc):
        raise GmailDeliveryError("MISSING_RECIPIENT", "Add at least one recipient before review.")
    if len(to) + len(cc) + len(bcc) > _MAX_RECIPIENTS:
        raise GmailDeliveryError("TOO_MANY_RECIPIENTS", "An email can have at most 50 recipients.")

    subject = _text(payload.get("subject"))
    body = str(payload.get("body") or "")
    if _CRLF_RE.search(subject):
        raise GmailDeliveryError("INVALID_SUBJECT", "Subject cannot contain newlines.")
    if len(subject) > _MAX_SUBJECT_CHARS:
        raise GmailDeliveryError("SUBJECT_TOO_LONG", "Subject is too long.")
    if len(body) > _MAX_BODY_CHARS:
        raise GmailDeliveryError("BODY_TOO_LONG", "Message is too long.")
    try:
        html_body = sanitize_gmail_owner_html(payload.get("html_body"))
    except ValueError as exc:
        raise GmailDeliveryError("INVALID_HTML_BODY", "Message formatting is invalid.") from exc
    return NormalizedEmailDraft(
        to=to,
        cc=cc,
        bcc=bcc,
        subject=subject,
        body=body,
        html_body=html_body,
    )


def _message_for(
    draft: NormalizedEmailDraft,
    *,
    reply_context: GmailReplyContext | None = None,
    attachment: tuple[DriveBlobDescriptor, bytes] | None = None,
) -> EmailMessage:
    message = EmailMessage(policy=SMTP)
    # Deliberately omit From: Gmail assigns the connected user's `me` sender.
    message["To"] = ", ".join(draft.to)
    if draft.cc:
        message["Cc"] = ", ".join(draft.cc)
    if draft.bcc:
        # Gmail consumes Bcc from the RFC message and strips it before delivery.
        message["Bcc"] = ", ".join(draft.bcc)
    message["Subject"] = draft.subject
    if reply_context and reply_context.in_reply_to:
        message["In-Reply-To"] = reply_context.in_reply_to
    if reply_context and reply_context.references:
        message["References"] = reply_context.references
    message.set_content(draft.body)
    if draft.html_body:
        message.add_alternative(draft.html_body, subtype="html")
    if attachment is not None:
        descriptor, content = attachment
        maintype, subtype = descriptor.mime_type.split("/", 1)
        message.add_attachment(
            content, maintype=maintype, subtype=subtype, filename=descriptor.filename
        )
    return message


def _attachment_ref(value: Any) -> tuple[str, str | None, str | None] | None:
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) - {"file_id", "revision", "sha256"}:
        raise GmailDeliveryError("INVALID_ATTACHMENT", "Choose one Drive file for review.")
    file_id, revision, sha256 = value.get("file_id"), value.get("revision"), value.get("sha256")
    if (
        not isinstance(file_id, str)
        or (revision is not None and not isinstance(revision, str))
        or (sha256 is not None and not isinstance(sha256, str))
    ):
        raise GmailDeliveryError("INVALID_ATTACHMENT", "Choose one Drive file for review.")
    return file_id, revision, sha256


def _reviewed_attachment(value: Any) -> tuple[DriveBlobDescriptor, str, str] | None:
    if value is None:
        return None
    fields = {
        "file_id",
        "filename",
        "mime_type",
        "size",
        "revision",
        "sha256",
        "grant_binding",
        "source_account_label",
    }
    if not isinstance(value, dict) or set(value) != fields:
        raise GmailDeliveryError("INVALID_ATTACHMENT", "Review the Drive attachment again.")
    if (
        any(
            not isinstance(value[key], str) or len(value[key]) > 256
            for key in fields - {"size", "source_account_label"}
        )
        or not isinstance(value["source_account_label"], str)
        or not re.fullmatch(r"[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+", value["source_account_label"])
        or len(value["source_account_label"]) > 320
        or type(value["size"]) is not int
        or not 0 < value["size"] <= MAX_BLOB_BYTES
        or not re.fullmatch(r"[0-9a-f]{64}", value["grant_binding"])
    ):
        raise GmailDeliveryError("INVALID_ATTACHMENT", "Review the Drive attachment again.")
    return (
        DriveBlobDescriptor(
            **{key: value[key] for key in fields - {"grant_binding", "source_account_label"}}
        ),
        value["grant_binding"],
        value["source_account_label"],
    )


def _safe_attachment_descriptor(
    descriptor: DriveBlobDescriptor, source_account_label: str
) -> dict[str, Any]:
    return {
        "filename": descriptor.filename,
        "mime_type": descriptor.mime_type,
        "size": descriptor.size,
        "source_account_label": source_account_label,
        "revision": descriptor.revision,
        "sha256": descriptor.sha256,
    }


class GmailDeliveryService:
    def __init__(
        self,
        *,
        gmail_service: GmailReceiptsService | None = None,
        drive_blobs: GoogleDriveBlobAttachmentService | None = None,
    ) -> None:
        self._gmail_service = gmail_service
        self._drive_blobs = drive_blobs

    @property
    def gmail_service(self) -> GmailReceiptsService:
        return self._gmail_service or get_gmail_receipts_service()

    @property
    def drive_blobs(self) -> GoogleDriveBlobAttachmentService:
        return self._drive_blobs or GoogleDriveBlobAttachmentService()

    async def _resolve_attachment(
        self, *, user_id: str, file_id: str, revision: str | None, sha256: str | None
    ) -> tuple[DriveBlobDescriptor, bytes, str, str]:
        # UAT's Drive connector grants access only to Picker-selected files.
        # The older attachment resolver uses a separate account-wide grant,
        # so it cannot serve a UAT attachment until it is migrated to the
        # selected-document authority. Plain reviewed Gmail sends continue.
        if os.getenv("ENVIRONMENT", "").strip().lower() == "uat":
            raise GmailDeliveryError(
                "DRIVE_ATTACHMENT_UNAVAILABLE",
                "Drive attachments are temporarily unavailable. Send without the attachment.",
                status_code=403,
            )
        try:
            identity_before = await self.drive_blobs.grant_identity(
                authenticated_owner_user_id=user_id
            )
            resolved = await self.drive_blobs.resolve(
                file_id=file_id,
                authenticated_owner_user_id=user_id,
                expected_revision=revision,
                expected_sha256=sha256,
            )
            identity_after = await self.drive_blobs.grant_identity(
                authenticated_owner_user_id=user_id
            )
        except GoogleConnectionError as exc:
            raise GmailDeliveryError(
                "DRIVE_ATTACHMENT_UNAVAILABLE",
                "The Drive attachment changed or is unavailable. Review it again.",
                status_code=exc.status_code,
            ) from None
        if identity_before != identity_after:
            raise GmailDeliveryError(
                "DRIVE_ATTACHMENT_CHANGED",
                "The Drive account or grant changed. Review the attachment again.",
                status_code=409,
            )
        return (
            resolved.descriptor,
            resolved.content,
            identity_after.binding,
            identity_after.account_label,
        )

    def _hmac(self, value: str, *, purpose: str) -> str:
        key = get_core_security_settings().app_signing_key.encode("utf-8")
        return hmac.new(
            key, f"gmail-owner-delivery:{purpose}:{value}".encode("utf-8"), hashlib.sha256
        ).hexdigest()

    def _envelope_hmac(
        self,
        draft: NormalizedEmailDraft,
        *,
        reply_context: GmailReplyContext | None = None,
        attachment: DriveBlobDescriptor | None = None,
        owner_user_id: str | None = None,
        grant_binding: str | None = None,
        source_account_label: str | None = None,
    ) -> str:
        # Keep the text-only HMAC shape unchanged for existing prepared actions.
        envelope: dict[str, Any] = {
            "draft": json.loads(draft.canonical_json()),
            "reply_context": json.loads(reply_context.canonical_json()) if reply_context else None,
        }
        if attachment is not None:
            envelope["drive_attachment"] = asdict(attachment)
            envelope["owner_user_id"] = owner_user_id
            envelope["drive_grant_binding"] = grant_binding
            envelope["drive_source_account_label"] = source_account_label
        return self._hmac(
            json.dumps(envelope, separators=(",", ":"), sort_keys=True),
            purpose="envelope",
        )

    def _idempotency_hmac(self, idempotency_key: str) -> str:
        return self._hmac(idempotency_key, purpose="idempotency")

    @staticmethod
    def _attachment_key() -> bytes:
        signing_key = get_core_security_settings().app_signing_key.encode("utf-8")
        return hmac.new(signing_key, b"gmail-drive-attachment-token-v1", hashlib.sha256).digest()

    def _seal_attachment(
        self,
        *,
        user_id: str,
        action_id: str,
        descriptor: DriveBlobDescriptor,
        grant_binding: str,
        source_account_label: str,
    ) -> str:
        payload = json.dumps(
            {
                "version": 1,
                "owner_user_id": user_id,
                "action_id": action_id,
                "drive_attachment": {
                    **asdict(descriptor),
                    "grant_binding": grant_binding,
                    "source_account_label": source_account_label,
                },
            },
            separators=(",", ":"),
            sort_keys=True,
        ).encode()
        nonce = secrets.token_bytes(12)
        ciphertext = AESGCM(self._attachment_key()).encrypt(
            nonce, payload, b"gmail-drive-attachment-v1"
        )
        return base64.urlsafe_b64encode(nonce + ciphertext).decode("ascii").rstrip("=")

    def _open_attachment(
        self, token: str, *, user_id: str, action_id: str
    ) -> tuple[DriveBlobDescriptor, str, str]:
        if not isinstance(token, str) or not 32 <= len(token) <= 2048:
            raise GmailDeliveryError("INVALID_ATTACHMENT", "Review the Drive attachment again.")
        try:
            packed = base64.b64decode(
                token + "=" * (-len(token) % 4), altchars=b"-_", validate=True
            )
            nonce, ciphertext = packed[:12], packed[12:]
            raw = AESGCM(self._attachment_key()).decrypt(
                nonce, ciphertext, b"gmail-drive-attachment-v1"
            )
            value = json.loads(raw)
        except (ValueError, TypeError, binascii.Error, InvalidTag):
            raise GmailDeliveryError(
                "INVALID_ATTACHMENT", "Review the Drive attachment again.", status_code=409
            ) from None
        if (
            not isinstance(value, dict)
            or value.get("version") != 1
            or value.get("owner_user_id") != user_id
            or value.get("action_id") != action_id
        ):
            raise GmailDeliveryError(
                "INVALID_ATTACHMENT", "Review the Drive attachment again.", status_code=409
            )
        reviewed = _reviewed_attachment(value.get("drive_attachment"))
        if reviewed is None:
            raise GmailDeliveryError(
                "INVALID_ATTACHMENT", "Review the Drive attachment again.", status_code=409
            )
        return reviewed

    @staticmethod
    def _action_payload(row: dict[str, Any]) -> dict[str, Any]:
        return {
            "action_id": _text(row.get("action_id")),
            "state": _text(row.get("state")),
            "expires_at": row.get("expires_at"),
            "sent_at": row.get("sent_at"),
            "outcome_unknown": _text(row.get("state")) == "outcome_unknown",
        }

    async def draft_from_instruction(
        self, *, instruction: str, user_id: str, consent_token: str
    ) -> dict[str, Any]:
        """Generate a structured draft only; provider output cannot send mail."""

        instruction = _text(instruction)
        if not instruction:
            raise GmailDeliveryError("MISSING_INSTRUCTION", "Tell One what email to draft.")
        if not _text(user_id) or not _text(consent_token):
            raise GmailDeliveryError(
                "OWNER_AUTHORITY_REQUIRED",
                "Email drafting requires the current vault owner's authorization.",
                status_code=403,
            )
        prompt = (
            "Draft an email from only the explicit user instruction below. Return JSON only. "
            "Never claim an email was sent, never invent recipient addresses, and list missing details. "
            "Write body as polished compact email text: use real paragraph breaks, a greeting and sign-off when appropriate, "
            "and use Markdown only when helpful: **bold**, *italic*, ++underline++, # through ### headings, "
            "- bullets, 1. numbered items, [label](https://example.com) links, > quotes, and :::center/:::right blocks. "
            "Do not emit literal backslash-n sequences.\n\n"
            f"Instruction:\n{instruction}"
        )
        try:
            value = await run_email_gene(
                gene_id="agent_email_draft",
                prompt=prompt,
                user_id=_text(user_id),
                consent_token=_text(consent_token),
                output_schema=EMAIL_DRAFT_SCHEMA,
                timeout_seconds=float(os.getenv("GMAIL_EMAIL_DRAFT_TIMEOUT_SECONDS") or 30),
            )
        except GmailDeliveryError:
            raise
        except Exception as exc:
            logger.warning("gmail.delivery.draft_failed error=%s", type(exc).__name__)
            raise GmailDeliveryError(
                "DRAFT_UNAVAILABLE", "Email drafting is temporarily unavailable.", status_code=503
            ) from exc
        if not isinstance(value, dict):
            raise GmailDeliveryError(
                "DRAFT_INVALID", "Email drafting returned an invalid draft.", status_code=502
            )
        draft = {
            "to": [str(item).strip() for item in value.get("to", []) if str(item).strip()],
            "cc": [str(item).strip() for item in value.get("cc", []) if str(item).strip()],
            "bcc": [str(item).strip() for item in value.get("bcc", []) if str(item).strip()],
            "subject": str(value.get("subject") or "").strip(),
            "body": str(value.get("body") or ""),
            "missing_details": [
                str(item).strip() for item in value.get("missing_details", []) if str(item).strip()
            ],
        }
        if _is_email_agent_intro_instruction(instruction):
            draft["subject"] = "Meet your Hushh Email Agent"
            draft["body"] = _EMAIL_AGENT_INTRO_BODY
        if not draft["body"].strip():
            raise GmailDeliveryError(
                "DRAFT_INVALID",
                "Email drafting returned an incomplete draft.",
                status_code=502,
            )
        return draft

    async def prepare(
        self,
        *,
        user_id: str,
        draft_payload: dict[str, Any],
        idempotency_key: str,
        reply_context: GmailReplyContext | None = None,
    ) -> dict[str, Any]:
        draft = normalize_draft(draft_payload)
        idempotency_key = _text(idempotency_key)
        if not 16 <= len(idempotency_key) <= 256:
            raise GmailDeliveryError("INVALID_IDEMPOTENCY_KEY", "Use a valid confirmation key.")
        await self.gmail_service.assert_send_ready(user_id=user_id)
        attachment_ref = _attachment_ref(draft_payload.get("drive_attachment"))
        attachment = None
        grant_binding = None
        source_account_label = None
        if attachment_ref is not None:
            (
                attachment,
                _content,
                grant_binding,
                source_account_label,
            ) = await self._resolve_attachment(
                user_id=user_id,
                file_id=attachment_ref[0],
                revision=attachment_ref[1],
                sha256=attachment_ref[2],
            )
            del _content
        envelope_hmac = self._envelope_hmac(
            draft,
            reply_context=reply_context,
            attachment=attachment,
            owner_user_id=user_id,
            grant_binding=grant_binding,
            source_account_label=source_account_label,
        )
        idempotency_hmac = self._idempotency_hmac(idempotency_key)
        action_id = str(uuid.uuid4())
        expires_at = _utcnow() + timedelta(seconds=_ACTION_TTL_SECONDS)
        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    """
                    UPDATE gmail_owner_send_actions
                    SET state = 'expired', updated_at = NOW()
                    WHERE user_id = $1 AND state = 'prepared' AND expires_at <= NOW()
                    """,
                    user_id,
                )
                existing = await conn.fetchrow(
                    """
                    SELECT action_id, state, expires_at, sent_at, envelope_hmac
                    FROM gmail_owner_send_actions
                    WHERE user_id = $1 AND idempotency_hmac = $2
                    FOR UPDATE
                    """,
                    user_id,
                    idempotency_hmac,
                )
                if existing is not None:
                    row = dict(existing)
                    if not hmac.compare_digest(_text(row.get("envelope_hmac")), envelope_hmac):
                        raise GmailDeliveryError(
                            "IDEMPOTENCY_PAYLOAD_MISMATCH",
                            "This confirmation key belongs to a different draft.",
                            status_code=409,
                        )
                    result = self._action_payload(row)
                    if attachment and grant_binding and source_account_label:
                        result["drive_attachment"] = _safe_attachment_descriptor(
                            attachment, source_account_label
                        )
                        result["attachment_token"] = self._seal_attachment(
                            user_id=user_id,
                            action_id=_text(row.get("action_id")),
                            descriptor=attachment,
                            grant_binding=grant_binding,
                            source_account_label=source_account_label,
                        )
                    return result
                await conn.execute(
                    """
                    INSERT INTO gmail_owner_send_actions (
                        action_id, user_id, envelope_hmac, idempotency_hmac,
                        recipient_count, state, expires_at
                    ) VALUES ($1, $2, $3, $4, $5, 'prepared', $6)
                    """,
                    action_id,
                    user_id,
                    envelope_hmac,
                    idempotency_hmac,
                    draft.recipient_count,
                    expires_at,
                )
        result: dict[str, Any] = {
            "action_id": action_id,
            "state": "prepared",
            "expires_at": expires_at,
            "sent_at": None,
            "outcome_unknown": False,
        }
        if attachment is not None:
            result["drive_attachment"] = _safe_attachment_descriptor(
                attachment, source_account_label
            )
            result["attachment_token"] = self._seal_attachment(
                user_id=user_id,
                action_id=action_id,
                descriptor=attachment,
                grant_binding=grant_binding,
                source_account_label=source_account_label,
            )
        return result

    async def execute(
        self,
        *,
        user_id: str,
        action_id: str,
        draft_payload: dict[str, Any],
        reply_context: GmailReplyContext | None = None,
    ) -> dict[str, Any]:
        draft = normalize_draft(draft_payload)
        action_id = _text(action_id)
        if not action_id:
            raise GmailDeliveryError("MISSING_ACTION", "Choose the prepared email confirmation.")
        attachment_token = draft_payload.get("attachment_token")
        reviewed = (
            self._open_attachment(attachment_token, user_id=user_id, action_id=action_id)
            if attachment_token is not None
            else None
        )
        attachment, grant_binding, source_account_label = (
            reviewed if reviewed else (None, None, None)
        )
        envelope_hmac = self._envelope_hmac(
            draft,
            reply_context=reply_context,
            attachment=attachment,
            owner_user_id=user_id,
            grant_binding=grant_binding,
            source_account_label=source_account_label,
        )
        pool = await get_pool()
        resolved_attachment: tuple[DriveBlobDescriptor, bytes, str, str] | None = None
        if attachment is not None:
            # Check the action before reading a private blob. Sent retries keep
            # their existing idempotent result even if Drive was disconnected.
            async with pool.acquire() as conn:
                initial = await conn.fetchrow(
                    """SELECT action_id, state, expires_at, sent_at, envelope_hmac
                       FROM gmail_owner_send_actions WHERE action_id = $1 AND user_id = $2""",
                    action_id,
                    user_id,
                )
            if initial is None:
                raise GmailDeliveryError(
                    "ACTION_NOT_FOUND", "That email confirmation is unavailable.", status_code=404
                )
            initial_row = dict(initial)
            if not hmac.compare_digest(_text(initial_row.get("envelope_hmac")), envelope_hmac):
                raise GmailDeliveryError(
                    "DRAFT_CHANGED",
                    "The draft changed. Review it again before sending.",
                    status_code=409,
                )
            if _text(initial_row.get("state")) == "sent":
                return self._action_payload(initial_row)
            if _text(initial_row.get("state")) != "prepared":
                raise GmailDeliveryError(
                    "ACTION_NOT_SENDABLE",
                    "This email confirmation can no longer be sent.",
                    status_code=409,
                )
            resolved_attachment = await self._resolve_attachment(
                user_id=user_id,
                file_id=attachment.file_id,
                revision=attachment.revision,
                sha256=attachment.sha256,
            )
            if (
                resolved_attachment[0] != attachment
                or not hmac.compare_digest(resolved_attachment[2], grant_binding or "")
                or resolved_attachment[3] != source_account_label
            ):
                raise GmailDeliveryError(
                    "DRIVE_ATTACHMENT_CHANGED",
                    "The Drive attachment changed. Review it again before sending.",
                    status_code=409,
                )
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    """
                    UPDATE gmail_owner_send_actions
                    SET state = 'expired', updated_at = NOW()
                    WHERE action_id = $1 AND user_id = $2
                      AND state = 'prepared' AND expires_at <= NOW()
                    """,
                    action_id,
                    user_id,
                )
                action = await conn.fetchrow(
                    """
                    SELECT action_id, state, expires_at, sent_at, envelope_hmac
                    FROM gmail_owner_send_actions
                    WHERE action_id = $1 AND user_id = $2
                    FOR UPDATE
                    """,
                    action_id,
                    user_id,
                )
                if action is None:
                    raise GmailDeliveryError(
                        "ACTION_NOT_FOUND",
                        "That email confirmation is unavailable.",
                        status_code=404,
                    )
                row = dict(action)
                if not hmac.compare_digest(_text(row.get("envelope_hmac")), envelope_hmac):
                    raise GmailDeliveryError(
                        "DRAFT_CHANGED",
                        "The draft changed. Review it again before sending.",
                        status_code=409,
                    )
                if _text(row.get("state")) == "sent":
                    return self._action_payload(row)
                if _text(row.get("state")) != "prepared":
                    raise GmailDeliveryError(
                        "ACTION_NOT_SENDABLE",
                        "This email confirmation can no longer be sent.",
                        status_code=409,
                    )
                transitioned = await conn.fetchrow(
                    """
                    UPDATE gmail_owner_send_actions
                    SET state = 'sending', sending_at = NOW(), updated_at = NOW()
                    WHERE action_id = $1 AND user_id = $2 AND state = 'prepared'
                      AND expires_at > NOW() AND envelope_hmac = $3
                    RETURNING action_id, state, expires_at, sent_at
                    """,
                    action_id,
                    user_id,
                    envelope_hmac,
                )
                if transitioned is None:
                    raise GmailDeliveryError(
                        "ACTION_NOT_SENDABLE",
                        "This email confirmation can no longer be sent.",
                        status_code=409,
                    )

        provider_attempted = False
        provider_accepted = False
        try:
            access_token = await self.gmail_service.get_send_access_token(user_id=user_id)
            raw = base64.urlsafe_b64encode(
                _message_for(
                    draft,
                    reply_context=reply_context,
                    attachment=resolved_attachment[:2] if resolved_attachment else None,
                ).as_bytes()
            ).decode("ascii")
            send_payload: dict[str, str] = {"raw": raw}
            if reply_context:
                send_payload["threadId"] = reply_context.thread_id
            timeout = httpx.Timeout(20.0, connect=8.0)
            async with httpx.AsyncClient(timeout=timeout) as client:
                provider_attempted = True
                response = await client.post(
                    _GMAIL_SEND_URL,
                    headers={"Authorization": f"Bearer {access_token}"},
                    json=send_payload,
                )
            if response.status_code >= 400:
                await self._set_terminal(
                    action_id=action_id, state="failed", error_code="gmail_send_failed"
                )
                raise GmailDeliveryError(
                    "GMAIL_SEND_FAILED", "Gmail could not send this email.", status_code=502
                )
            provider_accepted = True
            response_payload = response.json() if response.content else {}
            message_id = (
                _text(response_payload.get("id")) if isinstance(response_payload, dict) else ""
            )
            sent_thread_id = (
                _text(response_payload.get("threadId"))
                if isinstance(response_payload, dict)
                else ""
            )
            if reply_context and sent_thread_id != reply_context.thread_id:
                await self._set_outcome_unknown(
                    action_id=action_id,
                    error_code="reply_thread_mismatch",
                    message_id=message_id or None,
                    thread_id=sent_thread_id or None,
                )
                return {"action_id": action_id, "state": "outcome_unknown", "outcome_unknown": True}
            if not message_id:
                await self._set_outcome_unknown(
                    action_id=action_id, error_code="missing_message_id"
                )
                return {"action_id": action_id, "state": "outcome_unknown", "outcome_unknown": True}
            try:
                await self._set_terminal(
                    action_id=action_id,
                    state="sent",
                    message_id=message_id,
                    thread_id=sent_thread_id or None,
                )
            except Exception:
                # Gmail accepted the message but the durable result could not
                # be written. A retry could send a duplicate, so surface only
                # the safe ambiguous outcome.
                await self._set_outcome_unknown(
                    action_id=action_id,
                    error_code="terminal_persist_failed",
                    message_id=message_id,
                    thread_id=sent_thread_id or None,
                )
                return {"action_id": action_id, "state": "outcome_unknown", "outcome_unknown": True}
            return {"action_id": action_id, "state": "sent", "outcome_unknown": False}
        except asyncio.TimeoutError:
            await self._set_outcome_unknown(action_id=action_id, error_code="provider_timeout")
            return {"action_id": action_id, "state": "outcome_unknown", "outcome_unknown": True}
        except httpx.TimeoutException:
            await self._set_outcome_unknown(action_id=action_id, error_code="provider_timeout")
            return {"action_id": action_id, "state": "outcome_unknown", "outcome_unknown": True}
        except httpx.TransportError:
            # A connection may fail after Gmail accepted the POST but before
            # the response arrived. Never turn that ambiguity into a retry.
            await self._set_outcome_unknown(action_id=action_id, error_code="provider_transport")
            return {"action_id": action_id, "state": "outcome_unknown", "outcome_unknown": True}
        except GmailApiError as exc:
            await self._set_terminal(
                action_id=action_id, state="failed", error_code="gmail_unavailable"
            )
            raise GmailDeliveryError(
                exc.code or "GMAIL_NOT_READY", str(exc), status_code=exc.status_code
            ) from exc
        except GmailDeliveryError:
            raise
        except Exception as exc:
            logger.warning(
                "gmail.delivery.send_failed action_id=%s error=%s", action_id, type(exc).__name__
            )
            if provider_attempted or provider_accepted:
                await self._set_outcome_unknown(
                    action_id=action_id, error_code="provider_outcome_ambiguous"
                )
                return {"action_id": action_id, "state": "outcome_unknown", "outcome_unknown": True}
            await self._set_terminal(
                action_id=action_id, state="failed", error_code="delivery_failed"
            )
            raise GmailDeliveryError(
                "DELIVERY_FAILED", "Gmail could not send this email.", status_code=502
            ) from exc

    async def _set_outcome_unknown(
        self,
        *,
        action_id: str,
        error_code: str,
        message_id: str | None = None,
        thread_id: str | None = None,
    ) -> None:
        try:
            await self._set_terminal(
                action_id=action_id,
                state="outcome_unknown",
                error_code=error_code,
                message_id=message_id,
                thread_id=thread_id,
            )
        except Exception as exc:
            # Keep the original action non-retryable even when a transient DB
            # issue prevents recording its terminal state immediately.
            logger.error(
                "gmail.delivery.outcome_unknown_persist_failed action_id=%s error=%s",
                action_id,
                type(exc).__name__,
            )

    async def _set_terminal(
        self,
        *,
        action_id: str,
        state: str,
        error_code: str | None = None,
        message_id: str | None = None,
        thread_id: str | None = None,
    ) -> None:
        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE gmail_owner_send_actions
                SET state = $2,
                    safe_error_code = $3,
                    gmail_message_id = COALESCE($4, gmail_message_id),
                    gmail_thread_id = COALESCE($5, gmail_thread_id),
                    sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE sent_at END,
                    updated_at = NOW()
                WHERE action_id = $1 AND state = 'sending'
                """,
                action_id,
                state,
                error_code,
                message_id,
                thread_id,
            )


_gmail_delivery_service: GmailDeliveryService | None = None


def get_gmail_delivery_service() -> GmailDeliveryService:
    global _gmail_delivery_service
    if _gmail_delivery_service is None:
        _gmail_delivery_service = GmailDeliveryService()
    return _gmail_delivery_service
