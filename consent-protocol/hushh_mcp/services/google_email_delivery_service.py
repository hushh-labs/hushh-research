"""Confirmation-bound delivery through the owner's connected Gmail account.

This is deliberately a small provider operon.  Draft text stays in the
browser; the database retains only a content HMAC and bounded delivery status.
The existing One KYC Workspace sender is not used here because it sends as
``one@hushh.ai`` rather than the owner.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import secrets
from datetime import UTC, datetime, timedelta
from email.message import EmailMessage
from email.utils import parseaddr
from typing import Any, Protocol

import httpx

from db.db_client import get_db
from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services.gmail_receipts_service import (
    GmailApiError,
    GmailReceiptsService,
    get_gmail_receipts_service,
)
from hushh_mcp.services.google_connection_service import GoogleConnectionError

logger = logging.getLogger(__name__)
_GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
_ACTION_TTL = timedelta(minutes=10)
_MAX_RECIPIENTS = 60
_MAX_SUBJECT = 512
_MAX_BODY = 20_000


def _clean(value: object | None) -> str:
    return str(value or "").strip()


class GoogleEmailDeliveryService:
    def __init__(
        self,
        *,
        db: Any | None = None,
        gmail: GmailReceiptsService | None = None,
        transport: EmailDeliveryTransport | None = None,
    ) -> None:
        self.db = db or get_db()
        self.gmail = gmail or get_gmail_receipts_service()
        self.transport = transport or GmailUserMailboxTransport(self.gmail)

    @staticmethod
    def _addresses(value: object, field: str) -> list[str]:
        values = value if isinstance(value, list) else []
        normalized: list[str] = []
        seen: set[str] = set()
        for raw in values:
            candidate = _clean(raw).lower()
            if not candidate:
                continue
            if "\r" in candidate or "\n" in candidate:
                raise GoogleConnectionError(
                    "Email headers cannot contain line breaks", status_code=422
                )
            _, address = parseaddr(candidate)
            local, separator, domain = address.partition("@")
            if (
                not address
                or address != candidate
                or not separator
                or not local
                or not domain
                or any(char.isspace() for char in address)
            ):
                raise GoogleConnectionError(
                    f"{field} contains an invalid email address", status_code=422
                )
            if candidate not in seen:
                seen.add(candidate)
                normalized.append(candidate)
        return normalized

    @classmethod
    def normalize_draft(cls, draft: dict[str, Any]) -> dict[str, Any]:
        to = cls._addresses(draft.get("to"), "To")
        cc = cls._addresses(draft.get("cc"), "Cc")
        bcc = cls._addresses(draft.get("bcc"), "Bcc")
        # A recipient must appear in only one header.  Prefer its first
        # explicit placement (To, then Cc, then Bcc) instead of sending copies.
        seen = set(to)
        cc = [item for item in cc if not (item in seen or seen.add(item))]
        bcc = [item for item in bcc if not (item in seen or seen.add(item))]
        if not to:
            raise GoogleConnectionError("At least one To recipient is required", status_code=422)
        if len(to) + len(cc) + len(bcc) > _MAX_RECIPIENTS:
            raise GoogleConnectionError("An email can have at most 60 recipients", status_code=422)
        subject = str(draft.get("subject") or "").strip()
        body = str(draft.get("body") or "")
        if "\r" in subject or "\n" in subject or len(subject) > _MAX_SUBJECT:
            raise GoogleConnectionError("Email subject is invalid", status_code=422)
        if not body.strip() or len(body) > _MAX_BODY:
            raise GoogleConnectionError(
                "Email body is required and must be under 20,000 characters", status_code=422
            )
        return {"to": to, "cc": cc, "bcc": bcc, "subject": subject, "body": body}

    @staticmethod
    def _canonical(draft: dict[str, Any]) -> bytes:
        return json.dumps(draft, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()

    @staticmethod
    def _hmac(value: bytes) -> str:
        return hmac.new(
            get_core_security_settings().app_signing_key.encode(), value, hashlib.sha256
        ).hexdigest()

    @classmethod
    def _draft_hmac(cls, draft: dict[str, Any]) -> str:
        return cls._hmac(cls._canonical(draft))

    @classmethod
    def _idempotency_hmac(cls, key: str) -> str:
        return cls._hmac(key.encode())

    def _purge_expired(self, user_id: str) -> None:
        self.db.execute_raw(
            """UPDATE google_email_send_actions SET status = 'expired', updated_at = NOW()
               WHERE user_id = :user_id AND status = 'prepared' AND expires_at <= NOW()""",
            {"user_id": user_id},
        )

    async def prepare(
        self, *, user_id: str, draft: dict[str, Any], idempotency_key: str
    ) -> dict[str, Any]:
        self._purge_expired(user_id)
        # Fail before the final confirmation when the single Gmail connection
        # has not enabled delivery.
        try:
            await self.gmail.send_access_token(user_id=user_id)
        except GmailApiError as exc:
            raise GoogleConnectionError(exc.message, status_code=exc.status_code) from exc
        normalized = self.normalize_draft(draft)
        action_id = f"gmail_send_{secrets.token_urlsafe(24)}"
        expires_at = datetime.now(UTC) + _ACTION_TTL
        action_hmac = self._draft_hmac(normalized)
        idempotency_hmac = self._idempotency_hmac(idempotency_key)
        existing = self.db.execute_raw(
            """SELECT action_id, status, expires_at FROM google_email_send_actions
               WHERE user_id = :user_id AND idempotency_hmac = :idempotency_hmac""",
            {"user_id": user_id, "idempotency_hmac": idempotency_hmac},
        ).data
        if existing:
            row = existing[0]
            if row.get("status") == "prepared" and row.get("expires_at"):
                return {
                    "action_id": row["action_id"],
                    "expires_at": str(row["expires_at"]),
                    "confirmation_required": True,
                }
            raise GoogleConnectionError(
                "This email action was already used; review it again", status_code=409
            )
        self.db.execute_raw(
            """INSERT INTO google_email_send_actions
               (action_id, user_id, payload_hmac, idempotency_hmac, recipient_count, expires_at)
               VALUES (:action_id, :user_id, :payload_hmac, :idempotency_hmac, :recipient_count, :expires_at)""",
            {
                "action_id": action_id,
                "user_id": user_id,
                "payload_hmac": action_hmac,
                "idempotency_hmac": idempotency_hmac,
                "recipient_count": len(normalized["to"])
                + len(normalized["cc"])
                + len(normalized["bcc"]),
                "expires_at": expires_at,
            },
        )
        logger.info(
            "google_email.send_prepared action_id=%s recipient_count=%s",
            action_id,
            len(normalized["to"]) + len(normalized["cc"]) + len(normalized["bcc"]),
        )
        return {
            "action_id": action_id,
            "expires_at": expires_at.isoformat(),
            "confirmation_required": True,
        }

    @staticmethod
    def _mime(draft: dict[str, Any]) -> tuple[str, list[str]]:
        message = EmailMessage()
        message["To"] = ", ".join(draft["to"])
        if draft["cc"]:
            message["Cc"] = ", ".join(draft["cc"])
        if draft["bcc"]:
            # Gmail strips Bcc from the delivered copy. It is present only in
            # the transient provider request and is never persisted or logged.
            message["Bcc"] = ", ".join(draft["bcc"])
        message["Subject"] = draft["subject"]
        message.set_content(draft["body"])
        all_recipients = [*draft["to"], *draft["cc"], *draft["bcc"]]
        raw = base64.urlsafe_b64encode(message.as_bytes()).decode().rstrip("=")
        return raw, all_recipients

    async def _provider_send(self, *, user_id: str, draft: dict[str, Any]) -> dict[str, Any]:
        return await self.transport.send_confirmed_message(user_id=user_id, draft=draft)

    async def execute(
        self, *, user_id: str, action_id: str, draft: dict[str, Any]
    ) -> dict[str, Any]:
        self._purge_expired(user_id)
        normalized = self.normalize_draft(draft)
        supplied_hmac = self._draft_hmac(normalized)
        claim = self.db.execute_raw(
            """UPDATE google_email_send_actions SET status = 'sending', sending_at = NOW(), updated_at = NOW()
               WHERE action_id = :action_id AND user_id = :user_id AND status = 'prepared'
                 AND expires_at > NOW() AND payload_hmac = :payload_hmac
               RETURNING action_id""",
            {"action_id": action_id, "user_id": user_id, "payload_hmac": supplied_hmac},
        )
        if not claim.data:
            raise GoogleConnectionError(
                "This email changed, expired, or was already sent. Review it again before sending.",
                status_code=409,
            )
        try:
            result = await self._provider_send(user_id=user_id, draft=normalized)
        except httpx.RequestError as exc:
            self.db.execute_raw(
                """UPDATE google_email_send_actions SET status = 'outcome_unknown', completed_at = NOW(),
                   error_code = 'provider_timeout', updated_at = NOW() WHERE action_id = :action_id""",
                {"action_id": action_id},
            )
            logger.warning("google_email.send_outcome_unknown action_id=%s", action_id)
            raise GoogleConnectionError(
                "Gmail did not confirm delivery. Check Sent Mail before trying again.",
                status_code=502,
            ) from exc
        except GoogleConnectionError as exc:
            self.db.execute_raw(
                """UPDATE google_email_send_actions SET status = 'failed', completed_at = NOW(),
                   error_code = :error_code, updated_at = NOW() WHERE action_id = :action_id""",
                {"action_id": action_id, "error_code": f"google_{exc.status_code}"},
            )
            logger.warning(
                "google_email.send_failed action_id=%s status=%s", action_id, exc.status_code
            )
            raise
        message_id = _clean(result.get("id")) or None
        thread_id = _clean(result.get("threadId")) or None
        if not message_id:
            self.db.execute_raw(
                """UPDATE google_email_send_actions SET status = 'outcome_unknown', completed_at = NOW(),
                   error_code = 'missing_provider_id', updated_at = NOW() WHERE action_id = :action_id""",
                {"action_id": action_id},
            )
            raise GoogleConnectionError(
                "Gmail did not confirm delivery. Check Sent Mail before trying again.",
                status_code=502,
            )
        self.db.execute_raw(
            """UPDATE google_email_send_actions SET status = 'sent', completed_at = NOW(),
               provider_message_id = :message_id, provider_thread_id = :thread_id,
               updated_at = NOW() WHERE action_id = :action_id""",
            {"action_id": action_id, "message_id": message_id, "thread_id": thread_id},
        )
        logger.info("google_email.send_sent action_id=%s", action_id)
        return {
            "action_id": action_id,
            "status": "sent",
            "message_id": message_id,
            "thread_id": thread_id,
        }


class EmailDeliveryTransport(Protocol):
    """Provider seam for a confirmed, owner-bound delivery only.

    KYC can later add a Workspace thread-reply adapter here without borrowing
    this user's OAuth credential path or weakening its scope workflow.
    """

    async def send_confirmed_message(
        self, *, user_id: str, draft: dict[str, Any]
    ) -> dict[str, Any]: ...


class GmailUserMailboxTransport:
    def __init__(self, gmail: GmailReceiptsService) -> None:
        self.gmail = gmail

    async def send_confirmed_message(
        self, *, user_id: str, draft: dict[str, Any]
    ) -> dict[str, Any]:
        try:
            token = await self.gmail.send_access_token(user_id=user_id)
        except GmailApiError as exc:
            raise GoogleConnectionError(exc.message, status_code=exc.status_code) from exc
        raw, recipients = GoogleEmailDeliveryService._mime(draft)
        del recipients  # validates the complete envelope above without logging it.
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(
                _GMAIL_SEND_URL,
                headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
                json={"raw": raw},
            )
        if response.status_code == 401:
            raise GoogleConnectionError(
                "Google Gmail connection needs reauthorization", status_code=401
            )
        if response.status_code == 403:
            raise GoogleConnectionError(
                "Google Gmail send permission is insufficient", status_code=403
            )
        if response.status_code >= 400:
            raise GoogleConnectionError("Gmail could not accept this email", status_code=502)
        payload = response.json()
        return payload if isinstance(payload, dict) else {}


_singleton: GoogleEmailDeliveryService | None = None


def get_google_email_delivery_service() -> GoogleEmailDeliveryService:
    global _singleton
    if _singleton is None:
        _singleton = GoogleEmailDeliveryService()
    return _singleton
