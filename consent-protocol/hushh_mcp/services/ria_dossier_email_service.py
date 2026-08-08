"""Dossier-ready notification mail for claimed RIA profiles.

Modeled on ``ria_claim_email_service``: Gmail API via Workspace delegation
from ``one@hushh.ai`` (``SupportEmailConfig``), test/live recipient
redirection, serialized through ``EmailDeliveryQueueService``. Delivery is
best-effort by contract — ``queue_dossier_email`` never raises, so a mail
fault can never fail the dossier worker (or the claim) that triggered it.

One deliberate divergence from the shared config: the dossier sender fails
CLOSED off production. If ``ENVIRONMENT`` is not ``production`` and the test
redirect is not active (``delivery_mode != "test"`` or
``SUPPORT_EMAIL_TEST_TO`` unset), nothing is enqueued and the caller sees
``blocked_test_unset`` — UAT can never mail a real adviser by omission.
"""

from __future__ import annotations

import base64
import html
import logging
import os
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Any, Awaitable, Callable

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
_DEFAULT_FRONTEND_ORIGIN = "http://localhost:3000"


def _clean_text(value: str | None) -> str:
    return (value or "").strip()


def _environment() -> str:
    return _clean_text(os.getenv("ENVIRONMENT")).lower()


@dataclass(frozen=True)
class RIADossierEmailDelivery:
    accepted: bool
    message_id: str | None
    recipient: str
    intended_recipient: str
    delivery_mode: str
    from_email: str


class RIADossierEmailService:
    """Send the dossier-ready pointer mail from the ``one@hushh.ai`` mailbox."""

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
                "Dossier email is not configured. Provide SUPPORT_EMAIL_* settings "
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
        return f"{prefix}Your Hushh dossier"

    def _build_plain_text(
        self,
        *,
        first_name: str | None,
        dossier_url: str,
        recipient: str,
        intended_recipient: str,
    ) -> str:
        lines = [
            f"Hi {_clean_text(first_name) or 'there'},",
            "",
            "Your dossier is ready — built from your SEC record.",
            "",
            f"Open it: {dossier_url}",
            "",
            "Sent once, because you claimed your profile.",
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

    def _build_html(self, *, dossier_url: str) -> str:
        url = html.escape(dossier_url)
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
                <h1 style="margin:0;font-size:24px;line-height:1.2;font-weight:700;letter-spacing:-0.02em;color:#020617;">Your dossier is ready</h1>
                <p style="margin:14px 0 0;font-size:15px;line-height:1.7;color:#475569;">Built from your SEC record after you claimed your adviser profile.</p>
                <div style="margin-top:24px;">
                  <a href="{url}" style="display:inline-block;border-radius:999px;background:#0f172a;color:#ffffff;text-decoration:none;padding:14px 22px;font-size:15px;font-weight:700;">Open your dossier</a>
                </div>
                <p style="margin:24px 0 0;font-size:13px;line-height:1.7;color:#64748b;">Sent once, because you claimed your profile.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
        """.strip()

    def send_dossier_ready(
        self,
        *,
        to_email: str,
        first_name: str | None = None,
        app_frontend_origin: str | None = None,
    ) -> RIADossierEmailDelivery:
        if not _clean_text(to_email):
            raise SupportEmailSendError("Dossier email requires a target email address.")

        cfg = self.config
        intended_recipient = to_email.strip().lower()
        recipient = self._effective_recipient(intended_recipient)
        origin = _clean_text(app_frontend_origin).rstrip("/") or _DEFAULT_FRONTEND_ORIGIN
        dossier_url = f"{origin}/one/profile"

        message = EmailMessage()
        message["To"] = recipient
        message["From"] = f"Hussh <{cfg.from_email}>"
        message["Subject"] = self._build_subject()
        if cfg.from_email:
            message["Reply-To"] = cfg.from_email

        message.set_content(
            self._build_plain_text(
                first_name=first_name,
                dossier_url=dossier_url,
                recipient=recipient,
                intended_recipient=intended_recipient,
            )
        )
        message.add_alternative(
            self._build_html(dossier_url=dossier_url),
            subtype="html",
        )

        encoded = base64.urlsafe_b64encode(message.as_bytes()).decode("utf-8")
        try:
            session = self._build_authorized_session()
            response = session.post(_GMAIL_SEND_ENDPOINT, json={"raw": encoded}, timeout=20)
        except SupportEmailNotConfiguredError:
            raise
        except Exception as exc:
            logger.exception("ria_dossier_email.transport_failed recipient=%s", recipient)
            raise SupportEmailSendError(
                "Dossier email authorization failed. Verify Workspace Gmail "
                f"delegation for `{cfg.delegated_user}` and the service account client."
            ) from exc

        try:
            payload = response.json()
        except Exception:
            payload = {}

        if response.status_code >= 400:
            logger.error(
                "ria_dossier_email.send_failed status=%s recipient=%s payload=%s",
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
                detail_message or f"Dossier email failed with status {response.status_code}"
            )

        message_id = payload.get("id") if isinstance(payload, dict) else None
        return RIADossierEmailDelivery(
            accepted=True,
            message_id=message_id if isinstance(message_id, str) else None,
            recipient=recipient,
            intended_recipient=intended_recipient,
            delivery_mode=cfg.delivery_mode,
            from_email=cfg.from_email,
        )


_ria_dossier_email_service: RIADossierEmailService | None = None


def get_ria_dossier_email_service() -> RIADossierEmailService:
    global _ria_dossier_email_service
    if _ria_dossier_email_service is None:
        _ria_dossier_email_service = RIADossierEmailService()
    return _ria_dossier_email_service


async def queue_dossier_email(
    *,
    user_id: str,
    to_email: str,
    first_name: str | None = None,
    app_frontend_origin: str | None = None,
    on_success: Callable[[Any], Awaitable[None]] | None = None,
    on_failure: Callable[[Exception], Awaitable[None]] | None = None,
) -> dict[str, str]:
    """Enqueue the dossier-ready mail. Best-effort: returns a status dict, never raises."""
    intended_recipient = _clean_text(to_email).lower()
    try:
        email_service = get_ria_dossier_email_service()
        cfg = email_service.config

        def _result(status: str, *, actual: str = "", reason: str | None = None) -> dict[str, str]:
            result = {
                "delivery_status": status,
                "intended_recipient": intended_recipient,
                "actual_recipient": actual,
                "delivery_mode": cfg.delivery_mode,
            }
            if reason:
                result["reason"] = reason
            return result

        if not intended_recipient:
            logger.warning("ria_dossier_email.missing_recipient user_id=%s", user_id)
            return _result("failed", reason="missing_recipient")

        environment = _environment()
        if environment != "production" and (cfg.delivery_mode != "test" or not cfg.test_to_email):
            # Fail CLOSED: off production, mail only flows through the test
            # redirect. An unset redirect blocks the send instead of falling
            # back to the real adviser's inbox.
            logger.warning(
                "ria_dossier_email.blocked_test_unset user_id=%s environment=%s",
                user_id,
                environment or "unset",
            )
            return _result("blocked_test_unset")

        if not cfg.configured:
            logger.warning("ria_dossier_email.not_configured user_id=%s", user_id)
            return _result("failed", reason="not_configured")

        actual_recipient = email_service._effective_recipient(intended_recipient)
        try:
            await get_email_delivery_queue_service().enqueue(
                kind="invite_email",
                send_callable=lambda: email_service.send_dossier_ready(
                    to_email=intended_recipient,
                    first_name=first_name,
                    app_frontend_origin=app_frontend_origin,
                ),
                on_success=on_success,
                on_failure=on_failure,
                context={"purpose": "ria_dossier_email", "user_id": user_id},
            )
        except Exception as exc:  # noqa: BLE001 - delivery must never fail the caller
            logger.warning(
                "ria_dossier_email.enqueue_failed user_id=%s error=%s",
                user_id,
                type(exc).__name__,
            )
            return _result("failed", actual=actual_recipient, reason="enqueue_failed")
        return _result("queued", actual=actual_recipient)
    except Exception as exc:  # noqa: BLE001 - the dossier mail can never raise
        logger.warning(
            "ria_dossier_email.queue_failed user_id=%s error=%s",
            user_id,
            type(exc).__name__,
        )
        return {
            "delivery_status": "failed",
            "intended_recipient": intended_recipient,
            "actual_recipient": "",
            "delivery_mode": "unknown",
            "reason": "unexpected_error",
        }
