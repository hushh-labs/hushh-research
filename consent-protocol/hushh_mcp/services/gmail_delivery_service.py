"""Owner-approved delivery through the canonical Gmail receipts connection.

This service intentionally stores only action metadata and HMACs.  It never
creates Gmail-native drafts, never persists an email envelope, and never
accepts a sender address or a caller-provided OAuth token.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import getaddresses
from typing import Any

import httpx
from google.genai import types as genai_types

from db.connection import get_pool
from hushh_mcp.runtime_providers import (
    GEMINI_37_FLASH,
    build_generate_content_config,
    build_managed_runtime_client,
)
from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services.gmail_owner_html import sanitize_gmail_owner_html
from hushh_mcp.services.gmail_receipts_service import (
    GmailApiError,
    GmailReceiptsService,
    get_gmail_receipts_service,
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


def _message_for(draft: NormalizedEmailDraft) -> EmailMessage:
    message = EmailMessage(policy=SMTP)
    # Deliberately omit From: Gmail assigns the connected user's `me` sender.
    message["To"] = ", ".join(draft.to)
    if draft.cc:
        message["Cc"] = ", ".join(draft.cc)
    if draft.bcc:
        # Gmail consumes Bcc from the RFC message and strips it before delivery.
        message["Bcc"] = ", ".join(draft.bcc)
    message["Subject"] = draft.subject
    message.set_content(draft.body)
    if draft.html_body:
        message.add_alternative(draft.html_body, subtype="html")
    return message


class GmailDeliveryService:
    def __init__(self, *, gmail_service: GmailReceiptsService | None = None) -> None:
        self._gmail_service = gmail_service

    @property
    def gmail_service(self) -> GmailReceiptsService:
        return self._gmail_service or get_gmail_receipts_service()

    def _hmac(self, value: str, *, purpose: str) -> str:
        key = get_core_security_settings().app_signing_key.encode("utf-8")
        return hmac.new(
            key, f"gmail-owner-delivery:{purpose}:{value}".encode("utf-8"), hashlib.sha256
        ).hexdigest()

    def _envelope_hmac(self, draft: NormalizedEmailDraft) -> str:
        return self._hmac(draft.canonical_json(), purpose="envelope")

    def _idempotency_hmac(self, idempotency_key: str) -> str:
        return self._hmac(idempotency_key, purpose="idempotency")

    @staticmethod
    def _action_payload(row: dict[str, Any]) -> dict[str, Any]:
        return {
            "action_id": _text(row.get("action_id")),
            "state": _text(row.get("state")),
            "expires_at": row.get("expires_at"),
            "sent_at": row.get("sent_at"),
            "outcome_unknown": _text(row.get("state")) == "outcome_unknown",
        }

    async def draft_from_instruction(self, *, instruction: str) -> dict[str, Any]:
        """Generate a structured draft only; provider output cannot send mail."""

        instruction = _text(instruction)
        if not instruction:
            raise GmailDeliveryError("MISSING_INSTRUCTION", "Tell One what email to draft.")
        response_schema = {
            "type": "OBJECT",
            "properties": {
                "to": {"type": "ARRAY", "items": {"type": "STRING"}},
                "cc": {"type": "ARRAY", "items": {"type": "STRING"}},
                "bcc": {"type": "ARRAY", "items": {"type": "STRING"}},
                "subject": {"type": "STRING"},
                "body": {"type": "STRING"},
                "missing_details": {"type": "ARRAY", "items": {"type": "STRING"}},
            },
            "required": ["to", "cc", "bcc", "subject", "body", "missing_details"],
        }
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
            client = build_managed_runtime_client("gemini")
            config = build_generate_content_config(
                genai_types,
                os.getenv("GMAIL_EMAIL_DRAFT_MODEL", GEMINI_37_FLASH),
                temperature=0.2,
                max_output_tokens=1200,
                response_mime_type="application/json",
                response_schema=response_schema,
                automatic_function_calling=genai_types.AutomaticFunctionCallingConfig(disable=True),
            )
            response = await client.aio.models.generate_content(
                model=os.getenv("GMAIL_EMAIL_DRAFT_MODEL", GEMINI_37_FLASH),
                contents=prompt,
                config=config,
            )
            value = getattr(response, "parsed", None)
            if not isinstance(value, dict):
                value = json.loads(str(getattr(response, "text", "") or "{}"))
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
        return draft

    async def prepare(
        self, *, user_id: str, draft_payload: dict[str, Any], idempotency_key: str
    ) -> dict[str, Any]:
        draft = normalize_draft(draft_payload)
        idempotency_key = _text(idempotency_key)
        if not 16 <= len(idempotency_key) <= 256:
            raise GmailDeliveryError("INVALID_IDEMPOTENCY_KEY", "Use a valid confirmation key.")
        await self.gmail_service.assert_send_ready(user_id=user_id)
        envelope_hmac = self._envelope_hmac(draft)
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
                    return self._action_payload(row)
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
        return {
            "action_id": action_id,
            "state": "prepared",
            "expires_at": expires_at,
            "sent_at": None,
            "outcome_unknown": False,
        }

    async def execute(
        self, *, user_id: str, action_id: str, draft_payload: dict[str, Any]
    ) -> dict[str, Any]:
        draft = normalize_draft(draft_payload)
        action_id = _text(action_id)
        if not action_id:
            raise GmailDeliveryError("MISSING_ACTION", "Choose the prepared email confirmation.")
        envelope_hmac = self._envelope_hmac(draft)
        pool = await get_pool()
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

        try:
            access_token = await self.gmail_service.get_send_access_token(user_id=user_id)
            raw = base64.urlsafe_b64encode(_message_for(draft).as_bytes()).decode("ascii")
            timeout = httpx.Timeout(20.0, connect=8.0)
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(
                    _GMAIL_SEND_URL,
                    headers={"Authorization": f"Bearer {access_token}"},
                    json={"raw": raw},
                )
            if response.status_code >= 400:
                await self._set_terminal(
                    action_id=action_id, state="failed", error_code="gmail_send_failed"
                )
                raise GmailDeliveryError(
                    "GMAIL_SEND_FAILED", "Gmail could not send this email.", status_code=502
                )
            response_payload = response.json() if response.content else {}
            message_id = (
                _text(response_payload.get("id")) if isinstance(response_payload, dict) else ""
            )
            if not message_id:
                await self._set_terminal(
                    action_id=action_id, state="outcome_unknown", error_code="missing_message_id"
                )
                return {"action_id": action_id, "state": "outcome_unknown", "outcome_unknown": True}
            await self._set_terminal(
                action_id=action_id,
                state="sent",
                message_id=message_id,
                thread_id=_text(response_payload.get("threadId"))
                if isinstance(response_payload, dict)
                else None,
            )
            return {"action_id": action_id, "state": "sent", "outcome_unknown": False}
        except asyncio.TimeoutError:
            await self._set_terminal(
                action_id=action_id, state="outcome_unknown", error_code="provider_timeout"
            )
            return {"action_id": action_id, "state": "outcome_unknown", "outcome_unknown": True}
        except httpx.TimeoutException:
            await self._set_terminal(
                action_id=action_id, state="outcome_unknown", error_code="provider_timeout"
            )
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
            await self._set_terminal(
                action_id=action_id, state="failed", error_code="delivery_failed"
            )
            raise GmailDeliveryError(
                "DELIVERY_FAILED", "Gmail could not send this email.", status_code=502
            ) from exc

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
