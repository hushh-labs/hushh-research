"""Kai-branded investor invite email delivery for RIA relationship invites."""

from __future__ import annotations

import base64
import html
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from email.message import EmailMessage

from google.auth.transport.requests import AuthorizedSession
from google.oauth2 import service_account

from hushh_mcp.runtime_settings import get_app_runtime_settings
from hushh_mcp.services.support_email_service import (
    SupportEmailConfig,
    SupportEmailNotConfiguredError,
    SupportEmailSendError,
)

logger = logging.getLogger(__name__)

_GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send"
_GMAIL_SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
_KAI_PRODUCT_URL = "https://www.hushh.ai/products/kai"


def _clean_text(value: str | None) -> str:
    return (value or "").strip()


def _format_expiry(expires_at: datetime | str | None) -> str | None:
    if expires_at is None:
        return None
    if isinstance(expires_at, datetime):
        dt = expires_at
    else:
        try:
            dt = datetime.fromisoformat(str(expires_at).replace("Z", "+00:00"))
        except Exception:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%b %d, %Y at %I:%M %p UTC")


def _frontend_url() -> str:
    return get_app_runtime_settings().app_frontend_origin or "http://localhost:3000"


@dataclass(frozen=True)
class KaiInviteEmailDelivery:
    accepted: bool
    message_id: str | None
    recipient: str
    intended_recipient: str
    delivery_mode: str
    from_email: str


class KaiInviteEmailService:
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
                "Kai invite email is not configured. Provide SUPPORT_EMAIL_* settings or "
                "a service account JSON that can send Gmail through Workspace delegation."
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
            return cfg.test_to_email
        return target_email

    def _build_subject(self, advisor_name: str) -> str:
        prefix = "[TEST] " if self.config.delivery_mode == "test" else ""
        return f"{prefix}{advisor_name} invited you to Kai"

    def _build_plain_text(
        self,
        *,
        advisor_name: str,
        firm_name: str | None,
        invite_url: str,
        expires_at: str | None,
        recipient: str,
        intended_recipient: str,
        target_display_name: str | None,
        reason: str | None,
    ) -> str:
        lines = [
            f"Hi {target_display_name or 'there'},",
            "",
            f"{advisor_name} invited you to join Kai.",
        ]
        if firm_name:
            lines.append(f"Firm: {firm_name}")
        if reason:
            lines.extend(["", f"Advisor note: {reason}"])
        lines.extend(
            [
                "",
                "What happens next:",
                "1. Open the invite link",
                "2. Sign in or create your Kai account",
                "3. Review the relationship and consent request inside the app",
                "",
                f"Open Kai: {invite_url}",
                f"Learn about Kai: {_KAI_PRODUCT_URL}",
            ]
        )
        if expires_at:
            lines.append(f"Invite expires: {expires_at}")
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

    def _build_html(
        self,
        *,
        advisor_name: str,
        firm_name: str | None,
        invite_url: str,
        expires_at: str | None,
        target_display_name: str | None,
        reason: str | None,
    ) -> str:
        recipient_name = html.escape(target_display_name or "there")
        advisor = html.escape(advisor_name)
        firm = html.escape(firm_name or "")
        expiry = html.escape(expires_at or "Available until the invite is revoked or expires.")
        note = html.escape(reason or "")

        note_block = (
            f"""
              <div style="margin-top:20px;border:1px solid rgba(15,23,42,0.08);border-radius:18px;padding:16px;background:#f8fafc;">
                <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#64748b;font-weight:700;">Advisor note</p>
                <p style="margin:0;font-size:15px;line-height:1.7;color:#0f172a;">{note}</p>
              </div>
            """
            if note
            else ""
        )
        firm_line = (
            f'<p style="margin:6px 0 0;font-size:15px;line-height:1.6;color:#334155;">Advisor firm: {firm}</p>'
            if firm
            else ""
        )

        return f"""
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f7fb;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7fb;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border-radius:28px;overflow:hidden;border:1px solid rgba(15,23,42,0.06);box-shadow:0 24px 80px rgba(15,23,42,0.08);">
            <tr>
              <td style="padding:36px 36px 28px;background:linear-gradient(135deg,#eff6ff 0%,#ffffff 45%,#ecfeff 100%);">
                <p style="margin:0 0 14px;font-size:12px;letter-spacing:0.24em;text-transform:uppercase;color:#2563eb;font-weight:700;">Kai by Hushh</p>
                <h1 style="margin:0;font-size:34px;line-height:1.05;font-weight:700;letter-spacing:-0.04em;color:#020617;">An advisor invited you to join Kai</h1>
                <p style="margin:18px 0 0;font-size:17px;line-height:1.75;color:#475569;">
                  Hi {recipient_name}, {advisor} invited you into Kai so you can connect, review the relationship, and manage any consented access in one place.
                </p>
                {firm_line}
                {note_block}
              </td>
            </tr>
            <tr>
              <td style="padding:0 36px 36px;">
                <div style="margin-top:24px;padding:20px 22px;border-radius:22px;background:#f8fafc;border:1px solid rgba(15,23,42,0.06);">
                  <p style="margin:0;font-size:13px;letter-spacing:0.18em;text-transform:uppercase;color:#64748b;font-weight:700;">What happens next</p>
                  <ol style="margin:14px 0 0;padding-left:18px;color:#334155;font-size:15px;line-height:1.8;">
                    <li>Open the invite in Kai.</li>
                    <li>Sign in or create your account.</li>
                    <li>Review the relationship and any access requests before approving anything.</li>
                  </ol>
                </div>
                <div style="margin-top:28px;display:flex;flex-wrap:wrap;gap:12px;">
                  <a href="{html.escape(invite_url)}" style="display:inline-block;border-radius:999px;background:#0f172a;color:#ffffff;text-decoration:none;padding:14px 22px;font-size:15px;font-weight:700;">Open your Kai invite</a>
                  <a href="{_KAI_PRODUCT_URL}" style="display:inline-block;border-radius:999px;background:#eff6ff;color:#1d4ed8;text-decoration:none;padding:14px 22px;font-size:15px;font-weight:700;">See what Kai is</a>
                </div>
                <p style="margin:28px 0 0;font-size:13px;line-height:1.7;color:#64748b;">
                  Invite expires: {expiry}
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
        """.strip()

    def send_ria_invite(
        self,
        *,
        target_email: str,
        target_display_name: str | None,
        advisor_name: str,
        firm_name: str | None,
        invite_token: str,
        invite_path: str,
        expires_at: datetime | str | None,
        reason: str | None = None,
    ) -> KaiInviteEmailDelivery:
        if not _clean_text(target_email):
            raise SupportEmailSendError("Invite email requires a target email address.")

        cfg = self.config
        recipient = self._effective_recipient(target_email.strip().lower())
        invite_url = f"{_frontend_url().rstrip('/')}{invite_path}"
        expiry_label = _format_expiry(expires_at)

        message = EmailMessage()
        message["To"] = recipient
        message["From"] = f"Kai by Hushh <{cfg.from_email}>"
        message["Subject"] = self._build_subject(advisor_name.strip() or "Your advisor")
        if cfg.from_email:
            message["Reply-To"] = cfg.from_email

        plain_text = self._build_plain_text(
            advisor_name=advisor_name.strip() or "Your advisor",
            firm_name=firm_name,
            invite_url=invite_url,
            expires_at=expiry_label,
            recipient=recipient,
            intended_recipient=target_email.strip().lower(),
            target_display_name=target_display_name,
            reason=reason,
        )
        message.set_content(plain_text)
        message.add_alternative(
            self._build_html(
                advisor_name=advisor_name.strip() or "Your advisor",
                firm_name=firm_name,
                invite_url=invite_url,
                expires_at=expiry_label,
                target_display_name=target_display_name,
                reason=reason,
            ),
            subtype="html",
        )

        encoded = base64.urlsafe_b64encode(message.as_bytes()).decode("utf-8")
        try:
            session = self._build_authorized_session()
            response = session.post(_GMAIL_SEND_ENDPOINT, json={"raw": encoded}, timeout=20)
        except SupportEmailNotConfiguredError:
            raise
        except Exception as exc:
            logger.exception(
                "kai_invite_email.transport_failed invite_token=%s recipient=%s",
                invite_token,
                recipient,
            )
            raise SupportEmailSendError(
                "Kai invite email authorization failed. Verify Workspace Gmail delegation for "
                f"`{cfg.delegated_user}` and the service account client."
            ) from exc

        try:
            payload = response.json()
        except Exception:
            payload = {}

        if response.status_code >= 400:
            logger.error(
                "kai_invite_email.send_failed invite_token=%s status=%s recipient=%s payload=%s",
                invite_token,
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
                detail_message or f"Kai invite email failed with status {response.status_code}"
            )

        message_id = payload.get("id") if isinstance(payload, dict) else None
        return KaiInviteEmailDelivery(
            accepted=True,
            message_id=message_id if isinstance(message_id, str) else None,
            recipient=recipient,
            intended_recipient=target_email.strip().lower(),
            delivery_mode=cfg.delivery_mode,
            from_email=cfg.from_email,
        )


_kai_invite_email_service: KaiInviteEmailService | None = None


def get_kai_invite_email_service() -> KaiInviteEmailService:
    global _kai_invite_email_service
    if _kai_invite_email_service is None:
        _kai_invite_email_service = KaiInviteEmailService()
    return _kai_invite_email_service
