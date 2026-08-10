"""Work-email verification code delivery for RIA claim upgrades.

Modeled on ``kai_invite_email_service``: Gmail API via Workspace delegation
from ``one@hushh.ai`` (``SupportEmailConfig``), test/live recipient
redirection, serialized through ``EmailDeliveryQueueService``. Delivery is
best-effort by contract — ``queue_claim_verification_email`` never raises, so
a mail fault can never fail the claim endpoint that triggered it.
"""

from __future__ import annotations

import base64
import html
import logging
from dataclasses import dataclass
from email.message import EmailMessage

from google.auth.transport.requests import AuthorizedSession
from google.oauth2 import service_account

from hushh_mcp.services.email_delivery_queue_service import (
    get_email_delivery_queue_service,
)
from hushh_mcp.services.support_email_service import (
    SupportEmailConfig,
    SupportEmailNotConfiguredError,
    SupportEmailSendError,
)

logger = logging.getLogger(__name__)

_GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send"
_GMAIL_SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"


def _clean_text(value: str | None) -> str:
    return (value or "").strip()


@dataclass(frozen=True)
class RIAClaimEmailDelivery:
    accepted: bool
    message_id: str | None
    recipient: str
    intended_recipient: str
    delivery_mode: str
    from_email: str


class RIAClaimEmailService:
    """Send the work-email verification code from the ``one@hushh.ai`` mailbox."""

    def __init__(self) -> None:
        self._config: SupportEmailConfig | None = None
        self._session: AuthorizedSession | None = None

    @property
    def config(self) -> SupportEmailConfig:
        if self._config is None:
            self._config = SupportEmailConfig.from_env()
        return self._config

    def _build_authorized_session(self) -> AuthorizedSession:
        cfg = self.config
        if not cfg.configured:
            raise SupportEmailNotConfiguredError(
                "Claim verification email is not configured. Provide SUPPORT_EMAIL_* settings "
                "or a service account JSON that can send Gmail through Workspace delegation."
            )
        if self._session is None:
            credentials = service_account.Credentials.from_service_account_info(
                cfg.service_account_info,
                scopes=[_GMAIL_SEND_SCOPE],
                subject=cfg.delegated_user,
            )
            self._session = AuthorizedSession(credentials)
        return self._session

    def _effective_recipient(self, target_email: str) -> str:
        cfg = self.config
        if cfg.delivery_mode == "test" and cfg.test_to_email:
            return str(cfg.test_to_email)
        return target_email

    def _build_subject(self) -> str:
        prefix = "[TEST] " if self.config.delivery_mode == "test" else ""
        return f"{prefix}Your Hushh verification code"

    def _build_plain_text(
        self,
        *,
        verification_code: str,
        firm_name: str | None,
        recipient: str,
        intended_recipient: str,
    ) -> str:
        lines = [
            f"Your verification code: {verification_code}",
            "",
            "Enter it on your Hushh profile to verify your work email"
            + (f" at {firm_name}." if firm_name else "."),
            "",
            "If you didn't request this, ignore this email.",
        ]
        if recipient != intended_recipient:
            lines.extend(
                [
                    "",
                    f"Delivery mode: {self.config.delivery_mode}",
                    f"Actual recipient: {recipient}",
                    f"Intended recipient: {intended_recipient}",
                ]
            )
        return "\n".join(lines)

    def _build_html(self, *, verification_code: str, firm_name: str | None) -> str:
        code = html.escape(verification_code)
        firm_line = (
            f'<p style="margin:14px 0 0;font-size:15px;line-height:1.7;color:#475569;">'
            f"Enter it on your Hushh profile to verify your work email at "
            f"{html.escape(firm_name)}.</p>"
            if firm_name
            else (
                '<p style="margin:14px 0 0;font-size:15px;line-height:1.7;color:#475569;">'
                "Enter it on your Hushh profile to verify your work email.</p>"
            )
        )
        return f"""
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f7fb;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7fb;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:28px;overflow:hidden;border:1px solid rgba(15,23,42,0.06);box-shadow:0 24px 80px rgba(15,23,42,0.08);">
            <tr>
              <td style="padding:36px;">
                <p style="margin:0 0 14px;font-size:12px;letter-spacing:0.24em;text-transform:uppercase;color:#2563eb;font-weight:700;">Hussh</p>
                <h1 style="margin:0;font-size:24px;line-height:1.2;font-weight:700;letter-spacing:-0.02em;color:#020617;">Your verification code</h1>
                {firm_line}
                <div style="margin-top:24px;padding:18px 22px;border-radius:18px;background:#f8fafc;border:1px solid rgba(15,23,42,0.06);">
                  <p style="margin:0;font-size:32px;letter-spacing:0.35em;font-weight:700;color:#0f172a;">{code}</p>
                </div>
                <p style="margin:24px 0 0;font-size:13px;line-height:1.7;color:#64748b;">If you didn't request this, ignore this email.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
        """.strip()

    def send_verification_code(
        self,
        *,
        target_email: str,
        verification_code: str,
        firm_name: str | None = None,
    ) -> RIAClaimEmailDelivery:
        if not _clean_text(target_email):
            raise SupportEmailSendError("Verification email requires a target email address.")
        if not _clean_text(verification_code):
            raise SupportEmailSendError("Verification email requires a code.")

        cfg = self.config
        intended_recipient = target_email.strip().lower()
        recipient = self._effective_recipient(intended_recipient)

        message = EmailMessage()
        message["To"] = recipient
        message["From"] = f"Hussh <{cfg.from_email}>"
        message["Subject"] = self._build_subject()
        if cfg.from_email:
            message["Reply-To"] = cfg.from_email

        message.set_content(
            self._build_plain_text(
                verification_code=verification_code,
                firm_name=firm_name,
                recipient=recipient,
                intended_recipient=intended_recipient,
            )
        )
        message.add_alternative(
            self._build_html(verification_code=verification_code, firm_name=firm_name),
            subtype="html",
        )

        encoded = base64.urlsafe_b64encode(message.as_bytes()).decode("utf-8")
        try:
            session = self._build_authorized_session()
            response = session.post(_GMAIL_SEND_ENDPOINT, json={"raw": encoded}, timeout=20)
        except SupportEmailNotConfiguredError:
            raise
        except Exception as exc:
            # Never log the code itself; the recipient is enough to triage.
            logger.exception("ria_claim_email.transport_failed recipient=%s", recipient)
            raise SupportEmailSendError(
                "Claim verification email authorization failed. Verify Workspace Gmail "
                f"delegation for `{cfg.delegated_user}` and the service account client."
            ) from exc

        try:
            payload = response.json()
        except Exception:
            payload = {}

        if response.status_code >= 400:
            logger.error(
                "ria_claim_email.send_failed status=%s recipient=%s payload=%s",
                response.status_code,
                recipient,
                payload,
            )
            detail_message = (
                payload.get("error", {}).get("message")
                if isinstance(payload, dict)
                and isinstance(payload.get("error"), dict)
                and isinstance(payload.get("error", {}).get("message"), str)
                else None
            )
            raise SupportEmailSendError(
                detail_message
                or f"Claim verification email failed with status {response.status_code}"
            )

        message_id = payload.get("id") if isinstance(payload, dict) else None
        return RIAClaimEmailDelivery(
            accepted=True,
            message_id=message_id if isinstance(message_id, str) else None,
            recipient=recipient,
            intended_recipient=intended_recipient,
            delivery_mode=cfg.delivery_mode,
            from_email=cfg.from_email,
        )


_ria_claim_email_service: RIAClaimEmailService | None = None


def get_ria_claim_email_service() -> RIAClaimEmailService:
    global _ria_claim_email_service
    if _ria_claim_email_service is None:
        _ria_claim_email_service = RIAClaimEmailService()
    return _ria_claim_email_service


async def queue_claim_verification_email(
    *,
    target_email: str,
    verification_code: str,
    firm_name: str | None = None,
) -> dict[str, str]:
    """Enqueue the code email. Best-effort: returns a status dict, never raises."""
    email_service = get_ria_claim_email_service()
    if not email_service.config.configured:
        logger.warning("ria_claim_email.not_configured")
        return {"delivery_status": "failed", "reason": "not_configured"}
    if not _clean_text(verification_code):
        logger.warning("ria_claim_email.missing_code")
        return {"delivery_status": "failed", "reason": "missing_code"}
    try:
        await get_email_delivery_queue_service().enqueue(
            kind="invite_email",
            send_callable=lambda: email_service.send_verification_code(
                target_email=target_email,
                verification_code=verification_code,
                firm_name=firm_name,
            ),
            context={"purpose": "ria_claim_email_code"},
        )
    except Exception as exc:  # noqa: BLE001 - delivery must never fail the request
        logger.warning("ria_claim_email.enqueue_failed error=%s", type(exc).__name__)
        return {"delivery_status": "failed", "reason": "enqueue_failed"}
    return {"delivery_status": "queued"}
